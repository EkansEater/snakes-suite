package com.snake.suite.screen

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.service.quicksettings.TileService
import android.content.ComponentName
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import com.snake.suite.core.Collection
import com.snake.suite.core.publish
import com.snake.suite.media.Ffmpeg
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** What the recorder is doing, for the screen, the notification and the quick settings tile. */
sealed interface RecState {
    data object Idle : RecState
    data class Countdown(val seconds: Int) : RecState
    data class Recording(val startedAt: Long, val pausedMs: Long, val pausedSince: Long?) : RecState {
        fun elapsed(now: Long = System.currentTimeMillis()) = now - startedAt - pausedMs - (pausedSince?.let { now - it } ?: 0)
    }
    data class Processing(val label: String, val progress: Float?) : RecState
    data class Finished(val uri: Uri, val name: String) : RecState
    data class Failed(val message: String) : RecState
}

/**
 * The recording runs here, in a foreground service, so it keeps going while you
 * use other apps. Android shows its own "recording" chip for the projection.
 */
class RecorderService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var projection: MediaProjection? = null
    private var recorder: Recorder? = null
    private var config: RecordConfig? = null
    private var raw: File? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> start(intent)
            ACTION_PAUSE -> togglePause()
            ACTION_STOP -> stop()
        }
        return START_NOT_STICKY
    }

    private fun start(intent: Intent) {
        if (recorder != null) return
        val cfg = intent.config()
        config = cfg
        val needsProjection = cfg.hasVideo || cfg.systemAudio
        // The service must be in the foreground, with the right types, before the projection is used.
        var types = 0
        if (needsProjection) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        if (cfg.microphone) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification("Starting...", recording = false), types)

        if (needsProjection) {
            val data = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
            else @Suppress("DEPRECATION") intent.getParcelableExtra(EXTRA_DATA)
            val mgr = getSystemService(MediaProjectionManager::class.java)
            projection = mgr.getMediaProjection(intent.getIntExtra(EXTRA_RESULT, Activity.RESULT_CANCELED), data!!)?.apply {
                registerCallback(object : MediaProjection.Callback() {
                    // The user stopped sharing from the system chip or the lock screen.
                    override fun onStop() { if (recorder != null) stop() }
                }, Handler(Looper.getMainLooper()))
            }
            if (projection == null) return fail("Screen capture was not allowed")
        }

        scope.launch {
            for (n in intent.getIntExtra(EXTRA_COUNTDOWN, 0) downTo 1) {
                state.value = RecState.Countdown(n)
                updateNotification("Recording in $n...")
                delay(1000)
            }
            val file = File(cacheDir, "rec-${System.currentTimeMillis()}.${if (cfg.hasVideo) "mp4" else "m4a"}")
            raw = file
            try {
                recorder = Recorder(projection, cfg, file).also { it.start() }
            } catch (e: Throwable) {
                recorder = null
                return@launch fail(e.message ?: "Could not start recording")
            }
            state.value = RecState.Recording(System.currentTimeMillis(), 0, null)
            refreshTile()
            while (recorder != null) {
                val s = state.value
                if (s is RecState.Recording) updateNotification(
                    (if (s.pausedSince != null) "Paused · " else "Recording · ") + com.snake.suite.core.formatDuration(s.elapsed()),
                )
                recorder?.error?.let { stop(); break }
                delay(1000)
            }
        }
    }

    private fun togglePause() {
        val rec = recorder ?: return
        val s = state.value as? RecState.Recording ?: return
        val now = System.currentTimeMillis()
        state.value = if (rec.paused) {
            rec.resume()
            s.copy(pausedMs = s.pausedMs + (now - (s.pausedSince ?: now)), pausedSince = null)
        } else {
            rec.pause()
            s.copy(pausedSince = now)
        }
        updateNotification(if (rec.paused) "Paused" else "Recording")
    }

    private fun stop() {
        val rec = recorder ?: run { finish(); return }
        recorder = null
        val cfg = config!!
        val file = raw!!
        scope.launch {
            state.value = RecState.Processing("Saving", null)
            updateNotification("Saving...")
            val ok = kotlinx.coroutines.withContext(Dispatchers.IO) { rec.stop() }
            projection?.stop()
            projection = null
            if (!ok) {
                file.delete()
                return@launch fail(rec.error?.message ?: "Nothing was recorded")
            }
            try {
                val name = "SnakeScreen_" + SimpleDateFormat("yyyy-MM-dd_HH-mm-ss", Locale.ROOT).format(Date()) + "." + cfg.mode.ext
                val final = when (cfg.mode) {
                    RecordConfig.Mode.Video -> file
                    RecordConfig.Mode.Gif -> convert(file, name, listOf("-vf",
                        "fps=12,scale='min(480,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", "-an"))
                    RecordConfig.Mode.Audio -> convert(file, name, listOf("-vn", "-c:a", "libmp3lame", "-b:a", "192k"))
                }
                val collection = when (cfg.mode) {
                    RecordConfig.Mode.Video -> Collection.Movies
                    RecordConfig.Mode.Gif -> Collection.Pictures
                    RecordConfig.Mode.Audio -> Collection.Music
                }
                val uri = kotlinx.coroutines.withContext(Dispatchers.IO) { publish(final, name, FOLDER, collection) }
                state.value = RecState.Finished(uri, name)
            } catch (e: Throwable) {
                state.value = RecState.Failed(e.message ?: "Saving failed")
            } finally {
                file.delete()
                finish()
            }
        }
    }

    private suspend fun convert(src: File, name: String, args: List<String>): File {
        val ffmpeg = Ffmpeg(this)
        val out = File(cacheDir, name)
        val total = ffmpeg.duration(src.path)
        state.value = RecState.Processing("Making ${name.substringAfterLast('.').uppercase()}", 0f)
        ffmpeg.run(listOf("-i", src.path) + args + out.path, total) { state.value = RecState.Processing("Making ${name.substringAfterLast('.').uppercase()}", it) }
        return out
    }

    private fun fail(message: String) {
        state.value = RecState.Failed(message)
        recorder = null
        projection?.stop()
        projection = null
        finish()
    }

    private fun finish() {
        refreshTile()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        recorder?.stop()
        projection?.stop()
        scope.cancel()
        super.onDestroy()
    }

    private fun refreshTile() = runCatching {
        TileService.requestListeningState(this, ComponentName(this, RecordTileService::class.java))
    }

    // ------------------------------------------------------------- notification

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text, recorder != null))
    }

    private fun notification(text: String, recording: Boolean): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Recording", NotificationManager.IMPORTANCE_LOW))
        fun action(a: String) = PendingIntent.getService(this, a.hashCode(), Intent(this, RecorderService::class.java).setAction(a),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_record)
            .setContentTitle("Snake's Screen Recorder")
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(open)
            .apply {
                if (recording) {
                    addAction(0, if (recorder?.paused == true) "Resume" else "Pause", action(ACTION_PAUSE))
                    addAction(0, "Stop", action(ACTION_STOP))
                }
            }
            .build()
    }

    companion object {
        const val FOLDER = "Snake's Screen Recorder"
        private const val CHANNEL = "recording"
        private const val NOTIFICATION_ID = 7
        const val ACTION_START = "com.snake.suite.screen.START"
        const val ACTION_PAUSE = "com.snake.suite.screen.PAUSE"
        const val ACTION_STOP = "com.snake.suite.screen.STOP"
        private const val EXTRA_RESULT = "result"
        private const val EXTRA_DATA = "data"
        private const val EXTRA_COUNTDOWN = "countdown"

        val state = MutableStateFlow<RecState>(RecState.Idle)
        val current: StateFlow<RecState> get() = state

        val active: Boolean get() = state.value.let { it is RecState.Recording || it is RecState.Countdown || it is RecState.Processing }

        fun start(context: Context, resultCode: Int, data: Intent?, config: RecordConfig, countdown: Int) {
            val i = Intent(context, RecorderService::class.java).setAction(ACTION_START)
                .putExtra(EXTRA_RESULT, resultCode).putExtra(EXTRA_DATA, data).putExtra(EXTRA_COUNTDOWN, countdown)
            config.into(i)
            context.startForegroundService(i)
        }

        fun send(context: Context, action: String) {
            context.startService(Intent(context, RecorderService::class.java).setAction(action))
        }

        private fun RecordConfig.into(i: Intent) {
            i.putExtra("mode", mode.name).putExtra("w", width).putExtra("h", height).putExtra("dpi", dpi).putExtra("fps", fps)
                .putExtra("bitrate", videoBitrate).putExtra("sys", systemAudio).putExtra("mic", microphone)
        }

        private fun Intent.config() = RecordConfig(
            RecordConfig.Mode.valueOf(getStringExtra("mode") ?: "Video"), getIntExtra("w", 1280), getIntExtra("h", 720),
            getIntExtra("dpi", 320), getIntExtra("fps", 30), getIntExtra("bitrate", 8_000_000), getBooleanExtra("sys", true),
            getBooleanExtra("mic", false),
        )
    }
}

/** Quick settings tile: the phone's version of `snakescreen --toggle`. */
class RecordTileService : TileService() {
    override fun onStartListening() {
        qsTile?.apply {
            state = if (RecorderService.active) android.service.quicksettings.Tile.STATE_ACTIVE else android.service.quicksettings.Tile.STATE_INACTIVE
            subtitle = if (RecorderService.active) "Tap to stop" else null
            updateTile()
        }
    }

    override fun onClick() {
        if (RecorderService.active) {
            RecorderService.send(this, RecorderService.ACTION_STOP)
        } else {
            // Starting needs the system's "start recording?" dialog, which only an activity can show.
            val intent = Intent(this, MainActivity::class.java).setAction(MainActivity.ACTION_QUICK_START)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (Build.VERSION.SDK_INT >= 34) {
                startActivityAndCollapse(PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE))
            } else {
                @Suppress("DEPRECATION", "StartActivityAndCollapseDeprecated")
                startActivityAndCollapse(intent)
            }
        }
    }
}
