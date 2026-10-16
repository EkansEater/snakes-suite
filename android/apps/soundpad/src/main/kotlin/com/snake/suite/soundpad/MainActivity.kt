package com.snake.suite.soundpad

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.GridView
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Shuffle
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.snake.suite.core.EmptyState
import com.snake.suite.core.SecondaryButton
import com.snake.suite.core.Snake
import com.snake.suite.core.SnakeScaffold
import com.snake.suite.core.SnakeTheme
import com.snake.suite.core.Tools

class MainActivity : ComponentActivity() {
    private val model: SoundPadModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handleShare(intent)
        setContent { SnakeTheme { SoundPadScreen(model) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleShare(intent)
    }

    /** Audio shared from another app is added to the pad. */
    private fun handleShare(intent: Intent?) {
        val uris = when (intent?.action) {
            Intent.ACTION_SEND -> listOfNotNull(intent.parcelable(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> intent.parcelables(Intent.EXTRA_STREAM)
            Intent.ACTION_VIEW -> listOfNotNull(intent.data)
            else -> emptyList()
        }
        if (uris.isNotEmpty()) model.add(uris)
        intent?.action = null
    }
}

@Suppress("DEPRECATION")
private fun Intent.parcelable(key: String): Uri? = getParcelableExtra(key)

@Suppress("DEPRECATION")
private fun Intent.parcelables(key: String): List<Uri> = getParcelableArrayListExtra<Uri>(key).orEmpty()

@Composable
private fun SoundPadScreen(model: SoundPadModel) {
    val tool = Tools.byId("soundpad")!!
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf<Sound?>(null) }
    var showColumns by remember { mutableStateOf(false) }
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { model.add(it) }
    val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { if (it != null) model.add(emptyList(), it) }

    SnakeScaffold(
        tool,
        subtitle = "${model.sounds.size} sounds",
        actions = {
            IconButton({ searching = !searching; if (!searching) query = "" }) { Icon(Icons.Default.Search, "Search", tint = Snake.Fg2) }
            IconButton(model::playRandom) { Icon(Icons.Default.Shuffle, "Random", tint = Snake.Fg2) }
            Box {
                IconButton({ showColumns = true }) { Icon(Icons.Default.GridView, "Columns", tint = Snake.Fg2) }
                DropdownMenu(showColumns, { showColumns = false }) {
                    (1..6).forEach { n ->
                        DropdownMenuItem({ Text("$n per row") }, { model.setColumns(n); showColumns = false })
                    }
                }
            }
            IconButton(model::stop) { Icon(Icons.Default.Stop, "Stop", tint = if (model.playing.isEmpty()) Snake.Fg2 else Snake.Record) }
        },
        bottomBar = { BottomControls(model) },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (searching) {
                OutlinedTextField(
                    query, { query = it }, Modifier.fillMaxWidth().padding(12.dp, 8.dp),
                    placeholder = { Text("Search sounds") }, singleLine = true,
                )
            }
            Row(Modifier.padding(12.dp, 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Add sounds", { pickFiles.launch(arrayOf("audio/*", "video/*")) }, icon = Icons.Default.Add)
                SecondaryButton("Add folder", { pickFolder.launch(null) }, icon = Icons.Default.CreateNewFolder)
            }
            val shown = model.sounds.withIndex().filter { query.isBlank() || it.value.name.contains(query, ignoreCase = true) }
            if (model.sounds.isEmpty()) {
                EmptyState("No sounds yet", Modifier.fillMaxWidth(),
                    hint = "Add files or a folder, or share audio to Snake's SoundPad from another app.")
            }
            LazyVerticalGrid(
                GridCells.Fixed(model.settings.columns),
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                itemsIndexed(shown, key = { _, it -> it.value.file }) { _, (index, sound) ->
                    Pad(index + 1, sound, sound.file in model.playing, { model.play(sound) }, { editing = sound })
                }
            }
        }
    }
    editing?.let { s -> EditDialog(model, s) { editing = null } }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Pad(number: Int, sound: Sound, playing: Boolean, onPlay: () -> Unit, onEdit: () -> Unit) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        Modifier
            .aspectRatio(1.15f)
            .clip(shape)
            .background(if (playing) Snake.Selection else Snake.Side)
            .border(1.dp, if (playing) Snake.Accent else Snake.Border, shape)
            .combinedClickable(onClick = onPlay, onLongClick = onEdit)
            .padding(10.dp),
    ) {
        Text("$number", Modifier.align(Alignment.TopStart), color = Snake.Fg3, style = MaterialTheme.typography.labelSmall)
        if (sound.volume != 100) {
            Text("${sound.volume}%", Modifier.align(Alignment.TopEnd), color = Snake.Fg3, style = MaterialTheme.typography.labelSmall)
        }
        Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
            Icon(Icons.Default.MusicNote, null, tint = if (playing) Snake.Highlight else Snake.Fg3)
            Text(
                sound.name, color = if (playing) Snake.Highlight else Snake.Fg, textAlign = TextAlign.Center,
                maxLines = 3, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium,
            )
        }
    }
}

@Composable
private fun BottomControls(model: SoundPadModel) {
    Column(Modifier.background(Snake.Title).navigationBarsPadding().padding(14.dp, 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Volume", color = Snake.Fg2, modifier = Modifier.width(64.dp))
            Slider(
                model.settings.volume.toFloat(), { model.setMasterVolume(it.toInt()) }, Modifier.weight(1f),
                valueRange = 0f..100f, colors = SliderDefaults.colors(thumbColor = Snake.Accent, activeTrackColor = Snake.Accent),
            )
            Text("${model.settings.volume}%", color = Snake.Fg2, modifier = Modifier.width(48.dp), textAlign = TextAlign.End)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(model.status.ifEmpty { "Tap to play, hold to edit" }, Modifier.weight(1f), color = Snake.Fg2,
                maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall)
            Text("Overlap", color = Snake.Fg2, style = MaterialTheme.typography.bodySmall)
            Spacer(Modifier.width(8.dp))
            Switch(model.settings.overlap, model::setOverlap,
                colors = SwitchDefaults.colors(checkedTrackColor = Snake.Accent))
        }
    }
}

@Composable
private fun EditDialog(model: SoundPadModel, sound: Sound, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(sound.name) }
    var volume by remember { mutableStateOf(sound.volume.toFloat()) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Snake.Widget,
        title = { Text("Edit sound") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true)
                Text("Volume ${volume.toInt()}%", color = Snake.Fg2)
                Slider(volume, { volume = it }, valueRange = 0f..200f, steps = 39,
                    colors = SliderDefaults.colors(thumbColor = Snake.Accent, activeTrackColor = Snake.Accent))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton("◀ Earlier", { model.move(sound, -1) })
                    SecondaryButton("Later ▶", { model.move(sound, 1) })
                }
            }
        },
        confirmButton = {
            TextButton({ model.rename(sound, name); model.setVolume(sound, volume.toInt()); onDismiss() }) { Text("Save") }
        },
        dismissButton = {
            Row {
                TextButton({ model.remove(sound); onDismiss() }) { Text("Remove", color = Snake.ErrorSoft) }
                TextButton(onDismiss) { Text("Cancel") }
            }
        },
    )
}
