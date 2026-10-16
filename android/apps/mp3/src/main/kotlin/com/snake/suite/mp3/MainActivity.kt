package com.snake.suite.mp3

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.snake.suite.core.CardState
import com.snake.suite.core.ChoiceChip
import com.snake.suite.core.DropZone
import com.snake.suite.core.FlatButton
import com.snake.suite.core.PrimaryButton
import com.snake.suite.core.SecondaryButton
import com.snake.suite.core.SectionLabel
import com.snake.suite.core.Snake
import com.snake.suite.core.SnakeCard
import com.snake.suite.core.SnakeProgress
import com.snake.suite.core.SnakeScaffold
import com.snake.suite.core.SnakeTheme
import com.snake.suite.core.Tools
import com.snake.suite.core.openFile

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
        setContent { SnakeTheme { Mp3Screen() } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** A link shared from YouTube, a browser or any app goes straight into the queue. */
    private fun handle(intent: Intent?) {
        val text = when (intent?.action) {
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)
            Intent.ACTION_VIEW -> intent.dataString
            else -> null
        }
        if (text != null) Downloads.add(this, text)
        intent?.action = null
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Mp3Screen() {
    val tool = Tools.byId("mp3")!!
    val context = LocalContext.current
    var link by remember { mutableStateOf("") }
    var showSettings by remember { mutableStateOf(false) }
    val notifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }
    fun submit(text: String) {
        if (Downloads.add(context, text) > 0) link = ""
    }
    fun paste() {
        val clip = context.getSystemService(ClipboardManager::class.java).primaryClip
        val text = clip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
        if (Downloads.links(text).isNotEmpty()) submit(text) else link = text
    }

    SnakeScaffold(
        tool, subtitle = "Video links to tagged MP3s",
        actions = { IconButton({ showSettings = true }) { Icon(Icons.Default.Settings, "Settings", tint = Snake.Fg2) } },
    ) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Spacer(Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        link, { link = it }, Modifier.weight(1f), singleLine = true,
                        placeholder = { Text("Paste a video link") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                        keyboardActions = KeyboardActions(onGo = { submit(link) }),
                    )
                    Spacer(Modifier.width(8.dp))
                    PrimaryButton("Get MP3", { submit(link) }, enabled = Downloads.links(link).isNotEmpty())
                }
            }
            if (Downloads.items.isEmpty()) {
                item {
                    DropZone("Paste a link from the clipboard", Modifier.fillMaxWidth(), icon = Icons.Default.ContentPaste,
                        hint = "Or tap Share → Snake's MP3 Converter in YouTube, SoundCloud, a browser...") { paste() }
                }
            } else {
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        SecondaryButton("Paste link", { paste() }, icon = Icons.Default.ContentPaste)
                        if (Downloads.items.any { it.status != Status.Queued && it.status != Status.Working }) {
                            SecondaryButton("Clear finished", { Downloads.clearFinished() })
                        }
                    }
                }
            }
            items(Downloads.items, key = { it.id }) { DownloadCard(it) }
            item { Spacer(Modifier.height(16.dp)) }
        }
    }
    if (showSettings) SettingsDialog { showSettings = false }
}

@Composable
private fun DownloadCard(d: Download) {
    val context = LocalContext.current
    SnakeCard(state = when (d.status) { Status.Done -> CardState.Done; Status.Failed -> CardState.Failed; else -> CardState.Normal }) {
        Row {
            Box(Modifier.size(64.dp).clip(RoundedCornerShape(6.dp)).background(Snake.Bg), contentAlignment = Alignment.Center) {
                if (d.thumbnail != null) {
                    Image(d.thumbnail.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                } else Icon(Icons.Default.MusicNote, null, tint = Snake.Fg3)
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(d.title, maxLines = 2, overflow = TextOverflow.Ellipsis)
                val sub = listOfNotNull(d.uploader.ifEmpty { null }, d.playlist?.let { "${d.index} of ${d.count} · $it" }).joinToString(" · ")
                if (sub.isNotEmpty()) Text(sub, color = Snake.Fg2, style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            when (d.status) {
                Status.Queued, Status.Working -> IconButton({ Downloads.cancel(d) }) { Icon(Icons.Default.Close, "Cancel", tint = Snake.ErrorSoft) }
                else -> IconButton({ Downloads.remove(d) }) { Icon(Icons.Default.Close, "Remove", tint = Snake.Fg2) }
            }
        }
        Spacer(Modifier.height(8.dp))
        when (d.status) {
            Status.Queued, Status.Working -> {
                Text(listOf(d.stage, d.detail).filter { it.isNotEmpty() }.joinToString("  ·  "), color = Snake.Fg2,
                    style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(6.dp))
                SnakeProgress(if (d.percent < 0 || d.status == Status.Queued) null else d.percent / 100f)
            }
            Status.Done -> Column {
                Text(d.stage, color = Snake.Highlight, style = MaterialTheme.typography.bodySmall)
                d.saved.take(1).forEach { s ->
                    Row {
                        FlatButton("Play", { context.openFile(s.uri, "audio/mpeg") }, icon = Icons.Default.PlayArrow, color = Snake.Fg)
                        FlatButton("Share", { Downloads.share(context, s.uri) }, icon = Icons.Default.Share, color = Snake.Fg)
                    }
                }
            }
            Status.Failed -> Column {
                Text(d.error.orEmpty(), color = Snake.ErrorSoft, style = MaterialTheme.typography.bodySmall, maxLines = 4, overflow = TextOverflow.Ellipsis)
                FlatButton("Retry", { Downloads.retry(context, d) }, icon = Icons.Default.Refresh, color = Snake.Fg)
            }
            Status.Cancelled -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Cancelled", Modifier.weight(1f), color = Snake.Warning, style = MaterialTheme.typography.bodySmall)
                FlatButton("Retry", { Downloads.retry(context, d) }, icon = Icons.Default.Refresh, color = Snake.Fg)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SettingsDialog(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val s = remember { Settings(context) }
    var quality by remember { mutableStateOf(s.quality) }
    var template by remember { mutableStateOf(s.template) }
    var playlist by remember { mutableStateOf(s.playlist) }
    var thumbnail by remember { mutableStateOf(s.thumbnail) }
    var metadata by remember { mutableStateOf(s.metadata) }
    var skip by remember { mutableStateOf(s.skipExisting) }
    var parallel by remember { mutableStateOf(s.parallel) }
    var hasCookies by remember { mutableStateOf(Downloads.cookies(context).exists()) }
    val pickCookies = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        uri ?: return@rememberLauncherForActivityResult
        context.contentResolver.openInputStream(uri)?.use { i -> Downloads.cookies(context).outputStream().use { i.copyTo(it) } }
        hasCookies = true
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Snake.Widget,
        title = { Text("Settings") },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                item {
                    SectionLabel("Quality")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Settings.QUALITIES.forEach { (label, v) -> ChoiceChip(label, quality == v, { quality = v; s.quality = v }) }
                    }
                }
                item {
                    SectionLabel("File names")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Settings.TEMPLATES.forEach { (label, v) -> ChoiceChip(label, template == v, { template = v; s.template = v }) }
                    }
                }
                item {
                    Toggle("Whole playlist (numbered subfolder)", playlist) { playlist = it; s.playlist = it }
                    Toggle("Cover art from the thumbnail", thumbnail) { thumbnail = it; s.thumbnail = it }
                    Toggle("Title, artist and date tags", metadata) { metadata = it; s.metadata = it }
                    Toggle("Skip links already converted", skip) { skip = it; s.skipExisting = it }
                }
                item {
                    SectionLabel("At once")
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        (1..3).forEach { n -> ChoiceChip("$n", parallel == n, { parallel = n; s.parallel = n }) }
                    }
                }
                item {
                    SectionLabel("Cookies (age-restricted or members-only videos)")
                    Text("Export cookies.txt from a desktop browser and pick it here.", color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
                    Row {
                        FlatButton(if (hasCookies) "Replace cookies.txt" else "Choose cookies.txt", { pickCookies.launch(arrayOf("text/*", "*/*")) })
                        if (hasCookies) FlatButton("Remove", { Downloads.cookies(context).delete(); hasCookies = false }, color = Snake.ErrorSoft)
                    }
                }
                item {
                    Text("Files go to Music/${Downloads.FOLDER}. yt-dlp ${remember { Downloads.ytDlpVersion(context) }}",
                        color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Done") } },
    )
}

@Composable
private fun Toggle(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!value) }, verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Switch(value, onChange, colors = SwitchDefaults.colors(checkedTrackColor = Snake.Accent))
    }
}
