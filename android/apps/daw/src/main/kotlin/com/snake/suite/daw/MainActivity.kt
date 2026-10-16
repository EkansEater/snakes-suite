package com.snake.suite.daw

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Bundle
import android.os.IBinder
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Loop
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material.icons.filled.ViewList
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.unit.dp
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.snake.suite.core.EmptyState
import com.snake.suite.core.PrimaryButton
import com.snake.suite.core.Snake
import com.snake.suite.core.SnakeProgress
import com.snake.suite.core.SnakeScaffold
import com.snake.suite.core.SnakeTheme
import com.snake.suite.core.Tools

class MainActivity : ComponentActivity() {
    private val model: DawModel by viewModels()
    private var permissionAsked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContent { SnakeTheme { DawScreen(model) } }
    }

    override fun onStart() {
        super.onStart()
        stopService(Intent(this, DawService::class.java))
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) model.start()
    }

    override fun onStop() {
        super.onStop()
        if (isChangingConfigurations) return
        // Keep playing or recording in the background; otherwise let go of the sound card.
        if (model.busy) ContextCompat.startForegroundService(this, Intent(this, DawService::class.java))
        else model.stop()
    }
}

@Composable
private fun DawScreen(model: DawModel) {
    val tool = Tools.byId("daw")!!
    val context = LocalContext.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        granted = ok
        // Without the mic it still plays back and edits; inputs stay silent.
        model.start()
    }
    LaunchedEffect(Unit) { if (!granted) ask.launch(Manifest.permission.RECORD_AUDIO) }

    var tab by remember { mutableStateOf(0) }
    var projects by remember { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }
    var viewDialog by remember { mutableStateOf(false) }
    var trackMenu by remember { mutableStateOf<Track?>(null) }
    val view = remember { ViewPrefs(context) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(model.message) { model.message?.let { snackbar.showSnackbar(it); model.message = null } }
    val s = model.state

    // The View menu's interface size scales everything, text included.
    val density = LocalDensity.current
    CompositionLocalProvider(LocalDensity provides Density(density.density * view.scale, density.fontScale)) {
        SnakeScaffold(
            tool,
            subtitle = s?.let { it.name + if (it.recording) " · recording" else "" } ?: tool.tagline,
            snackbar = snackbar,
            header = view.showTitleBar,
            actions = {
                IconButton({ projects = true }, enabled = s != null) { Icon(Icons.Default.Folder, "Projects", tint = Snake.Fg2) }
                IconButton({ settings = true }, enabled = s != null) { Icon(Icons.Default.Settings, "Audio settings", tint = Snake.Fg2) }
            },
            bottomBar = { Tabs(tab, view.showTabLabels) { tab = it } },
        ) { pad ->
            Box(Modifier.padding(pad).fillMaxSize()) {
                when {
                    model.error != null -> Column(Modifier.fillMaxSize().padding(24.dp)) {
                        EmptyState("Snake's DAW could not start", hint = model.error)
                        PrimaryButton("Try again", { model.restartAudio() })
                    }
                    s == null -> EmptyState("Starting audio...", Modifier.align(Alignment.Center))
                    else -> Column(Modifier.fillMaxSize()) {
                        TransportBar(model, s, view, { projects = true }, { settings = true }, { viewDialog = true })
                        s.export?.let { SnakeProgress(it, Modifier.fillMaxWidth()) }
                        when (tab) {
                            0 -> {
                                Timeline(model, s, view, { trackMenu = it }, Modifier.weight(1f))
                                if (view.showEditBar) EditBar(model, s)
                            }
                            1 -> EffectsScreen(model, s)
                            2 -> LooperScreen(model, s)
                            else -> TunerScreen(model, s)
                        }
                    }
                }
            }
        }
        if (s != null) {
            if (projects) ProjectsDialog(model, s) { projects = false }
            if (settings) SettingsDialog(model, s) { settings = false }
            trackMenu?.let { t -> TrackDialog(model, s, t) { trackMenu = null } }
        }
        if (viewDialog) ViewDialog(view) { viewDialog = false }
    }
}

/** Tracks / Effects / Loops / Tuner: a slim tab strip instead of the tall navigation bar. */
@Composable
private fun Tabs(selected: Int, labels: Boolean, onSelect: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().background(Snake.Title).navigationBarsPadding()) {
        listOf(Icons.Default.ViewList to "Tracks", Icons.Default.Tune to "Effects", Icons.Default.Loop to "Loops", Icons.Default.MusicNote to "Tuner").forEachIndexed { i, (icon, label) ->
            val on = i == selected
            Column(
                Modifier.weight(1f).clickable { onSelect(i) }.background(if (on) Snake.Selection else Snake.Title)
                    .padding(vertical = if (labels) 6.dp else 10.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Icon(icon, label, tint = if (on) Snake.Highlight else Snake.Fg2)
                if (labels) Text(label, color = if (on) Snake.Highlight else Snake.Fg2, fontSize = 11.sp)
            }
        }
    }
}

/** Keeps playback, recording and the loop station going while another app is in front. */
class DawService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("daw", "Playing in the background", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n: Notification = NotificationCompat.Builder(this, "daw")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Snake's DAW")
            .setContentText("Still running. Tap to go back.")
            .setOngoing(true).setContentIntent(open).build()
        ServiceCompat.startForeground(this, 21, n,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        return START_NOT_STICKY
    }

    companion object {
        fun stop(context: Context) = context.stopService(Intent(context, DawService::class.java))
    }
}
