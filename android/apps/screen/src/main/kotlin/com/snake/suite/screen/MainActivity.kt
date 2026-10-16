package com.snake.suite.screen

import android.Manifest
import android.app.Activity
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Audiotrack
import androidx.compose.material.icons.filled.Gif
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.snake.suite.core.CardState
import com.snake.suite.core.ChoiceChip
import com.snake.suite.core.DangerButton
import com.snake.suite.core.SecondaryButton
import com.snake.suite.core.SectionLabel
import com.snake.suite.core.Snake
import com.snake.suite.core.SnakeCard
import com.snake.suite.core.SnakeProgress
import com.snake.suite.core.SnakeScaffold
import com.snake.suite.core.SnakeTheme
import com.snake.suite.core.Tools
import com.snake.suite.core.formatDuration
import com.snake.suite.core.formatSize
import com.snake.suite.core.openFile
import com.snake.suite.core.shareFile
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    var quickStart by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        quickStart = intent?.action == ACTION_QUICK_START
        setContent { SnakeTheme { ScreenRecorder(this) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        quickStart = intent.action == ACTION_QUICK_START
    }

    companion object {
        const val ACTION_QUICK_START = "com.snake.suite.screen.QUICK_START"
    }
}

/** Saved choices, like the desktop recorder's settings. */
private class Prefs(context: Context) {
    private val p = context.getSharedPreferences("screen", Context.MODE_PRIVATE)
    var mode: RecordConfig.Mode
        get() = RecordConfig.Mode.valueOf(p.getString("mode", "Video")!!)
        set(v) = p.edit().putString("mode", v.name).apply()
    var quality: String
        get() = p.getString("quality", "1080")!!
        set(v) = p.edit().putString("quality", v).apply()
    var fps: Int
        get() = p.getInt("fps", 30)
        set(v) = p.edit().putInt("fps", v).apply()
    var system: Boolean
        get() = p.getBoolean("system", true)
        set(v) = p.edit().putBoolean("system", v).apply()
    var mic: Boolean
        get() = p.getBoolean("mic", false)
        set(v) = p.edit().putBoolean("mic", v).apply()
    var countdown: Int
        get() = p.getInt("countdown", 3)
        set(v) = p.edit().putInt("countdown", v).apply()
}

/** The screen size scaled so its short side is at most [short] px, in multiples of 16 for the encoder. */
private fun captureSize(activity: Activity, quality: String): Triple<Int, Int, Int> {
    val bounds = activity.windowManager.maximumWindowMetrics.bounds
    val dpi = activity.resources.displayMetrics.densityDpi
    var w = bounds.width()
    var h = bounds.height()
    val short = when (quality) { "720" -> 720; "480" -> 480; "1080" -> 1080; else -> minOf(w, h) }
    val scale = minOf(1f, short.toFloat() / minOf(w, h))
    w = ((w * scale).toInt() / 16) * 16
    h = ((h * scale).toInt() / 16) * 16
    return Triple(w, h, (dpi * scale).toInt())
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScreenRecorder(activity: MainActivity) {
    val tool = Tools.byId("screen")!!
    val context = LocalContext.current
    val prefs = remember { Prefs(context) }
    var mode by remember { mutableStateOf(prefs.mode) }
    var quality by remember { mutableStateOf(prefs.quality) }
    var fps by remember { mutableStateOf(prefs.fps) }
    var system by remember { mutableStateOf(prefs.system) }
    var mic by remember { mutableStateOf(prefs.mic) }
    var countdown by remember { mutableStateOf(prefs.countdown) }
    val state by RecorderService.current.collectAsState()
    var refresh by remember { mutableStateOf(0) }

    fun config(): RecordConfig {
        val (w, h, dpi) = captureSize(activity, quality)
        val bitrate = when (quality) { "480" -> 2_500_000; "720" -> 5_000_000; "1080" -> 10_000_000; else -> 16_000_000 } * (if (fps == 60) 3 else 2) / 2
        return RecordConfig(mode, w, h, dpi, fps, bitrate, system, mic && mode != RecordConfig.Mode.Gif)
    }

    val projection = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        if (r.resultCode == Activity.RESULT_OK) RecorderService.start(context, r.resultCode, r.data, config(), countdown)
    }
    fun begin() {
        val cfg = config()
        if (cfg.hasVideo || cfg.systemAudio) {
            val mgr = context.getSystemService(MediaProjectionManager::class.java)
            projection.launch(mgr.createScreenCaptureIntent())
        } else {
            RecorderService.start(context, 0, null, cfg, countdown)
        }
    }
    val permissions = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { begin() }
    fun record() {
        val needed = buildList {
            if (mic && mode != RecordConfig.Mode.Gif) add(Manifest.permission.RECORD_AUDIO)
            if (system && mode != RecordConfig.Mode.Gif) add(Manifest.permission.RECORD_AUDIO)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.distinct().filter { ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED }
        if (needed.isEmpty()) begin() else permissions.launch(needed.toTypedArray())
    }

    LaunchedEffect(activity.quickStart) {
        if (activity.quickStart && !RecorderService.active) { activity.quickStart = false; record() }
    }
    LaunchedEffect(state) { if (state is RecState.Finished) refresh++ }

    SnakeScaffold(tool, subtitle = "Screen to MP4 or GIF, sound to MP3") { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize().padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Spacer(Modifier.height(2.dp)); StatusCard(state, activity) { record() } }
            if (!RecorderService.active) item {
                SnakeCard(Modifier.fillMaxWidth()) {
                    SectionLabel("Record")
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        RecordConfig.Mode.entries.forEach { m ->
                            ChoiceChip(m.label, mode == m, { mode = m; prefs.mode = m })
                        }
                    }
                    if (mode != RecordConfig.Mode.Audio) {
                        Spacer(Modifier.height(12.dp))
                        SectionLabel("Quality")
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            listOf("full" to "Full", "1080" to "1080p", "720" to "720p", "480" to "480p").forEach { (k, v) ->
                                ChoiceChip(v, quality == k, { quality = k; prefs.quality = k })
                            }
                            listOf(30, 60).forEach { f -> ChoiceChip("$f fps", fps == f, { fps = f; prefs.fps = f }) }
                        }
                    }
                    if (mode != RecordConfig.Mode.Gif) {
                        Spacer(Modifier.height(12.dp))
                        SectionLabel("Sound")
                        Toggle("System sound (apps and games)", system) { system = it; prefs.system = it }
                        Toggle("Microphone", mic) { mic = it; prefs.mic = it }
                    }
                    Spacer(Modifier.height(8.dp))
                    SectionLabel("Countdown")
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf(0, 3, 5, 10).forEach { s -> ChoiceChip(if (s == 0) "Off" else "${s}s", countdown == s, { countdown = s; prefs.countdown = s }) }
                    }
                }
            }
            item { Recordings(refresh) }
            item { Spacer(Modifier.height(16.dp)) }
        }
    }
}

@Composable
private fun Toggle(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!value) }.padding(vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f))
        Switch(value, onChange, colors = SwitchDefaults.colors(checkedTrackColor = Snake.Accent))
    }
}

@Composable
private fun StatusCard(state: RecState, activity: Activity, onRecord: () -> Unit) {
    val context = LocalContext.current
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state) {
        while (state is RecState.Recording) { now = System.currentTimeMillis(); delay(250) }
    }
    SnakeCard(
        Modifier.fillMaxWidth(),
        state = when (state) { is RecState.Finished -> CardState.Done; is RecState.Failed -> CardState.Failed; else -> CardState.Normal },
    ) {
        Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
            when (state) {
                is RecState.Recording -> {
                    Text(formatDuration(state.elapsed(now)), fontSize = 40.sp, fontWeight = FontWeight.Light)
                    Text(if (state.pausedSince != null) "Paused" else "Recording", color = if (state.pausedSince != null) Snake.Warning else Snake.Record)
                    Spacer(Modifier.height(12.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        SecondaryButton(if (state.pausedSince != null) "Resume" else "Pause",
                            { RecorderService.send(context, RecorderService.ACTION_PAUSE) },
                            icon = if (state.pausedSince != null) Icons.Default.PlayArrow else Icons.Default.Pause)
                        DangerButton("Stop", { RecorderService.send(context, RecorderService.ACTION_STOP) }, icon = Icons.Default.Stop)
                    }
                }
                is RecState.Countdown -> {
                    Text("${state.seconds}", fontSize = 56.sp, fontWeight = FontWeight.Light, color = Snake.Highlight)
                    Text("Recording starts...", color = Snake.Fg2)
                    Spacer(Modifier.height(8.dp))
                    SecondaryButton("Cancel", { RecorderService.send(context, RecorderService.ACTION_STOP) })
                }
                is RecState.Processing -> {
                    Text(state.label + "...", color = Snake.Fg2)
                    Spacer(Modifier.height(8.dp))
                    SnakeProgress(state.progress)
                }
                else -> {
                    RecordButton(onRecord)
                    Spacer(Modifier.height(8.dp))
                    when (state) {
                        is RecState.Finished -> Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("Saved ${state.name}", Modifier.weight(1f), color = Snake.Highlight, maxLines = 2,
                                style = MaterialTheme.typography.bodySmall)
                            IconButton({ context.openFile(state.uri) }) { Icon(Icons.Default.OpenInNew, "Open", tint = Snake.Fg2) }
                            IconButton({ context.shareFile(state.uri) }) { Icon(Icons.Default.Share, "Share", tint = Snake.Fg2) }
                        }
                        is RecState.Failed -> Text(state.message, color = Snake.ErrorSoft)
                        else -> Text("Tap to record. You can also add the Snake Record tile to quick settings.",
                            color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }
    }
}

@Composable
private fun RecordButton(onClick: () -> Unit) {
    Box(
        Modifier.size(84.dp).clip(CircleShape).background(Snake.DangerBg).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(52.dp).clip(CircleShape).background(Snake.Record))
    }
}

private data class Recording(val uri: Uri, val name: String, val size: Long, val mime: String)

/** Files this app saved, newest first, from Movies, Pictures and Music. */
private fun loadRecordings(context: Context): List<Recording> {
    val out = mutableListOf<Recording>()
    val volumes = listOf(
        MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
        MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
        MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
    )
    val cols = arrayOf(MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE,
        MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.DATE_ADDED)
    val dated = mutableListOf<Pair<Long, Recording>>()
    for (base in volumes) {
        runCatching {
            context.contentResolver.query(base, cols, "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?",
                arrayOf("%/${RecorderService.FOLDER}/"), null)?.use { c ->
                while (c.moveToNext()) {
                    dated += c.getLong(4) to Recording(ContentUris.withAppendedId(base, c.getLong(0)), c.getString(1), c.getLong(2), c.getString(3) ?: "")
                }
            }
        }
    }
    dated.sortByDescending { it.first }
    dated.mapTo(out) { it.second }
    return out
}

@Composable
private fun Recordings(refresh: Int) {
    val context = LocalContext.current
    var list by remember { mutableStateOf(emptyList<Recording>()) }
    LaunchedEffect(refresh) { list = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { loadRecordings(context) } }
    if (list.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        SectionLabel("Recordings")
        list.take(50).forEach { r ->
            SnakeCard(padding = 10.dp, onClick = { context.openFile(r.uri, r.mime) }) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        when { r.mime.startsWith("audio") -> Icons.Default.Audiotrack; r.mime == "image/gif" -> Icons.Default.Gif; else -> Icons.Default.Movie },
                        null, tint = Snake.Fg2,
                    )
                    Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                        Text(r.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(formatSize(r.size), color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
                    }
                    IconButton({ context.shareFile(r.uri, r.mime) }) { Icon(Icons.Default.Share, "Share", tint = Snake.Fg2) }
                }
            }
        }
    }
}
