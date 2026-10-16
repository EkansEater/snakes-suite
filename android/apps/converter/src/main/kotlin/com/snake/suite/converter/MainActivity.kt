package com.snake.suite.converter

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.OpenInNew
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
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
import com.snake.suite.core.formatSize
import com.snake.suite.core.openFile
import com.snake.suite.core.shareFile

class MainActivity : ComponentActivity() {
    private val model: ConverterModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
        setContent { SnakeTheme { ConverterScreen(model) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    /** Files shared or opened from other apps land in the list. */
    private fun handle(intent: Intent?) {
        @Suppress("DEPRECATION")
        val uris = when (intent?.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            else -> emptyList()
        }
        if (uris.isNotEmpty()) model.add(uris)
        intent?.action = null
    }
}

@Composable
private fun ConverterScreen(model: ConverterModel) {
    val tool = Tools.byId("converter")!!
    var showOptions by remember { mutableStateOf(false) }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { model.add(it) }
    val context = LocalContext.current
    val running = model.running
    DisposableEffect(running) {
        val window = (context as ComponentActivity).window
        if (running) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
    SnakeScaffold(
        tool,
        subtitle = "Audio · Video · Images · Documents · Sheets · PDF",
        actions = { IconButton({ showOptions = true }) { Icon(Icons.Default.Tune, "Options", tint = Snake.Fg2) } },
        bottomBar = {
            if (model.items.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().navigationBarsPadding().padding(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
                ) {
                    SecondaryButton("Add", { pick.launch(arrayOf("*/*")) }, icon = Icons.Default.Add)
                    SecondaryButton("Clear done", model::clearFinished)
                    Spacer(Modifier.weight(1f))
                    PrimaryButton("Convert", model::convertAll, enabled = model.items.any { it.state == State.Ready && it.target != null },
                        icon = Icons.Default.PlayArrow)
                }
            }
        },
    ) { pad ->
        LazyColumn(Modifier.padding(pad).fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { Spacer(Modifier.height(4.dp)) }
            if (model.items.isEmpty()) {
                item {
                    DropZone("Choose files to convert", Modifier.fillMaxWidth(), icon = Icons.Default.Add,
                        hint = "Or share files to Snake's Converter from any app") { pick.launch(arrayOf("*/*")) }
                }
                item {
                    Text(
                        "MP3, WAV, FLAC, OGG, Opus, M4A · MP4, MKV, WebM, MOV, AVI, GIF · PNG, JPG, WebP, HEIC, PDF · " +
                            "DOCX, Markdown, HTML, TXT · XLSX, CSV, JSON",
                        color = Snake.Fg3, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(4.dp),
                    )
                }
            }
            items(model.items, key = { it.id }) { ItemCard(model, it) }
            item { Spacer(Modifier.height(12.dp)) }
        }
    }
    if (showOptions) OptionsDialog(model) { showOptions = false }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ItemCard(model: ConverterModel, item: Item) {
    val context = LocalContext.current
    val state = when (item.state) {
        State.Done -> CardState.Done
        State.Failed -> CardState.Failed
        else -> CardState.Normal
    }
    SnakeCard(state = state) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(item.file.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    listOfNotNull(item.category?.label, formatSize(item.file.size).ifEmpty { null }).joinToString(" · "),
                    color = Snake.Fg2, style = MaterialTheme.typography.bodySmall,
                )
            }
            if (item.state == State.Converting || item.state == State.Waiting) {
                IconButton({ model.cancel(item) }) { Icon(Icons.Default.Close, "Cancel", tint = Snake.ErrorSoft) }
            } else {
                IconButton({ model.remove(item) }) { Icon(Icons.Default.Close, "Remove", tint = Snake.Fg2) }
            }
        }
        if (item.targets.isNotEmpty() && item.state in setOf(State.Ready, State.Failed, State.Cancelled, State.Done)) {
            Spacer(Modifier.height(8.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                item.targets.forEach { t ->
                    ChoiceChip(t.uppercase(), t == item.target, { model.setTarget(item, t) })
                }
            }
            if (model.items.count { it.category == item.category && it.state == State.Ready } > 1 && item.target != null) {
                FlatButton("Use ${item.target.uppercase()} for every ${item.category?.label?.lowercase()} file",
                    { model.setTargetForAll(item.category!!, item.target) }, color = Snake.Fg2)
            }
        }
        when (item.state) {
            State.Waiting, State.Converting -> {
                Spacer(Modifier.height(10.dp))
                Text(if (item.state == State.Waiting) "Waiting..." else "Converting to ${item.target?.uppercase()}" +
                    (item.progress?.let { " · ${(it * 100).toInt()}%" } ?: ""), color = Snake.Fg2, style = MaterialTheme.typography.bodySmall)
                Spacer(Modifier.height(6.dp))
                SnakeProgress(item.progress)
            }
            State.Done -> {
                Spacer(Modifier.height(8.dp))
                item.outputs.forEach { out ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(out.where, Modifier.weight(1f), color = Snake.Highlight, style = MaterialTheme.typography.bodySmall,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                        IconButton({ context.openFile(out.uri) }) { Icon(Icons.Default.OpenInNew, "Open", tint = Snake.Fg2) }
                        IconButton({ context.shareFile(out.uri) }) { Icon(Icons.Default.Share, "Share", tint = Snake.Fg2) }
                    }
                }
            }
            State.Failed -> {
                Spacer(Modifier.height(6.dp))
                Text(item.error.orEmpty(), color = Snake.ErrorSoft, style = MaterialTheme.typography.bodySmall)
            }
            State.Cancelled -> Text("Cancelled", color = Snake.Warning, style = MaterialTheme.typography.bodySmall)
            State.Ready -> if (item.error != null) Text(item.error, color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OptionsDialog(model: ConverterModel, onDismiss: () -> Unit) {
    val o = model.options
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Snake.Widget,
        title = { Text("Options") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionLabel("Audio bitrate")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("128k", "192k", "256k", "320k").forEach {
                        ChoiceChip(it, o.audioBitrate == it, { model.changeOptions(o.copy(audioBitrate = it)) })
                    }
                }
                Spacer(Modifier.height(4.dp))
                SectionLabel("Video quality")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("high" to "High", "balanced" to "Balanced", "small" to "Small").forEach { (k, v) ->
                        ChoiceChip(v, o.videoQuality == k, { model.changeOptions(o.copy(videoQuality = k)) })
                    }
                }
                Spacer(Modifier.height(4.dp))
                SectionLabel("JPEG / WebP quality · ${o.imageQuality}")
                Slider(o.imageQuality.toFloat(), { model.changeOptions(o.copy(imageQuality = it.toInt())) }, valueRange = 50f..100f,
                    colors = SliderDefaults.colors(thumbColor = Snake.Accent, activeTrackColor = Snake.Accent))
                SectionLabel("PDF pages to images · ${o.pdfDpi} dpi")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(72, 150, 300).forEach { ChoiceChip("$it", o.pdfDpi == it, { model.changeOptions(o.copy(pdfDpi = it)) }) }
                }
                Spacer(Modifier.width(1.dp))
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Done") } },
    )
}
