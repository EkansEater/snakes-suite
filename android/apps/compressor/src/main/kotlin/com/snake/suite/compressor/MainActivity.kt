package com.snake.suite.compressor

import android.app.Application
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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Compress
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.FileOpen
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.InsertDriveFile
import androidx.compose.material.icons.filled.NoteAdd
import androidx.compose.material.icons.filled.Unarchive
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SecondaryTabRow
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.snake.suite.core.CardState
import com.snake.suite.core.DangerButton
import com.snake.suite.core.DropZone
import com.snake.suite.core.PickedFile
import com.snake.suite.core.PrimaryButton
import com.snake.suite.core.SecondaryButton
import com.snake.suite.core.SectionLabel
import com.snake.suite.core.Snake
import com.snake.suite.core.SnakeCard
import com.snake.suite.core.SnakeProgress
import com.snake.suite.core.SnakeScaffold
import com.snake.suite.core.SnakeTheme
import com.snake.suite.core.Tools
import com.snake.suite.core.describe
import com.snake.suite.core.formatSize
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Locale

class MainActivity : ComponentActivity() {
    private val model: CompressorModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        openIntent(intent)
        setContent { SnakeTheme { CompressorScreen(model) } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openIntent(intent)
    }

    /** A .snake opened from a file manager goes to the Unpack tab. */
    private fun openIntent(intent: Intent?) {
        intent?.data?.takeIf { intent.action == Intent.ACTION_VIEW }?.let { model.openArchive(it) }
    }
}

class CompressorModel(app: Application) : AndroidViewModel(app) {
    private val engine = Engine(app)
    var tab by mutableStateOf(0)
    var inputs by mutableStateOf<List<Input>>(emptyList()); private set
    var level by mutableStateOf(9)
    var archive by mutableStateOf<PickedFile?>(null); private set
    var busy by mutableStateOf<String?>(null); private set
    var progress by mutableStateOf<Float?>(null); private set
    var current by mutableStateOf(""); private set
    var result by mutableStateOf<String?>(null); private set
    var failed by mutableStateOf(false); private set
    var listing by mutableStateOf<List<Entry>>(emptyList()); private set
    private var job: Job? = null

    fun addFiles(uris: List<Uri>) {
        val ctx = getApplication<Application>()
        inputs = inputs + uris.map { ctx.describe(it).let { f -> Input(it, f.name, false, f.size) } }
            .filter { new -> inputs.none { it.uri == new.uri } }
        result = null
    }

    fun addFolder(uri: Uri) {
        val ctx = getApplication<Application>()
        val name = androidx.documentfile.provider.DocumentFile.fromTreeUri(ctx, uri)?.name ?: "folder"
        if (inputs.none { it.uri == uri }) inputs = inputs + Input(uri, name, true, -1)
        result = null
    }

    fun remove(input: Input) { inputs = inputs - input }
    fun clear() { inputs = emptyList(); result = null }

    fun suggestedName(): String = when {
        inputs.size == 1 -> "${inputs[0].name}.snake"
        else -> "archive.snake"
    }

    fun openArchive(uri: Uri) {
        archive = getApplication<Application>().describe(uri)
        listing = emptyList()
        result = null
        tab = 1
    }

    private fun run(label: String, total: () -> Long, work: suspend () -> String) {
        busy = label
        failed = false
        result = null
        progress = null
        job = viewModelScope.launch {
            val watcher = launch {
                val t = withContext(Dispatchers.IO) { total() }
                while (isActive) {
                    if (t > 0) progress = (NativeSnake.progress().toFloat() / t).coerceIn(0f, 1f)
                    delay(150)
                }
            }
            try {
                result = work()
            } catch (e: Throwable) {
                failed = true
                result = e.message ?: e.javaClass.simpleName
            } finally {
                watcher.cancel()
                busy = null
                current = ""
            }
        }
    }

    fun pack(output: Uri) {
        val start = System.currentTimeMillis()
        run("Compressing", { engine.measure(inputs) }) {
            val r = withContext(Dispatchers.IO) { engine.pack(inputs, output, level) { current = it } }
            val secs = (System.currentTimeMillis() - start) / 1000.0
            val ratio = if (r.bytes > 0) r.packed * 100.0 / r.bytes else 100.0
            "Packed ${r.files} file(s), ${formatSize(r.bytes)} → ${formatSize(r.packed)} " +
                String.format(Locale.ROOT, "(%.1f%%) in %.1f s", ratio, secs)
        }
    }

    fun unpack(dest: Uri?) {
        val a = archive ?: return
        run(if (dest == null) "Testing" else "Unpacking", { a.size }) {
            val r = withContext(Dispatchers.IO) { engine.unpack(a.uri, dest) { current = it } }
            listing = r.entries
            buildString {
                append(if (dest == null) "OK: every checksum matches. " else "Unpacked. ")
                append("${r.files} file(s), ${formatSize(r.bytes)}")
                if (r.skipped > 0) append(" (${r.skipped} symlink(s) skipped)")
            }
        }
    }

    fun cancel() {
        NativeSnake.cancel()
        job?.cancel()
    }
}

@Composable
private fun CompressorScreen(model: CompressorModel) {
    val tool = Tools.byId("compressor")!!
    val busy = model.busy != null
    val context = LocalContext.current
    DisposableEffect(busy) {
        val window = (context as ComponentActivity).window
        if (busy) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
    }
    SnakeScaffold(tool, bottomBar = { if (busy || model.result != null) StatusPanel(model) }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            SecondaryTabRow(model.tab, containerColor = Snake.Bg, contentColor = Snake.Highlight) {
                Tab(model.tab == 0, { if (!busy) model.tab = 0 }, text = { Text("Compress") })
                Tab(model.tab == 1, { if (!busy) model.tab = 1 }, text = { Text("Unpack / test") })
            }
            if (model.tab == 0) PackTab(model, busy) else UnpackTab(model, busy)
        }
    }
}

@Composable
private fun PackTab(model: CompressorModel, busy: Boolean) {
    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { model.addFiles(it) }
    val pickFolder = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { it?.let(model::addFolder) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) {
        it?.let(model::pack)
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Spacer(Modifier.height(6.dp))
            if (model.inputs.isEmpty()) {
                DropZone("Add files or a folder", Modifier.fillMaxWidth(), hint = "Everything is checksummed and lossless",
                    icon = Icons.Default.NoteAdd) { pickFiles.launch(arrayOf("*/*")) }
                Spacer(Modifier.height(8.dp))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Files", { pickFiles.launch(arrayOf("*/*")) }, enabled = !busy, icon = Icons.Default.NoteAdd)
                SecondaryButton("Folder", { pickFolder.launch(null) }, enabled = !busy, icon = Icons.Default.CreateNewFolder)
                if (model.inputs.isNotEmpty()) SecondaryButton("Clear", model::clear, enabled = !busy)
            }
        }
        items(model.inputs, key = { it.uri.toString() }) { input ->
            SnakeCard(padding = 10.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (input.isDir) Icons.Default.Folder else Icons.Default.InsertDriveFile, null, tint = Snake.Fg2)
                    Column(Modifier.weight(1f).padding(horizontal = 10.dp)) {
                        Text(input.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (input.isDir) "Folder" else formatSize(input.size), color = Snake.Fg2,
                            style = MaterialTheme.typography.bodySmall)
                    }
                    IconButton({ model.remove(input) }, enabled = !busy) { Icon(Icons.Default.Close, "Remove", tint = Snake.Fg2) }
                }
            }
        }
        item {
            Spacer(Modifier.height(8.dp))
            SectionLabel("Compression level")
            Row(verticalAlignment = Alignment.CenterVertically) {
                Slider(model.level.toFloat(), { model.level = it.toInt() }, Modifier.weight(1f), valueRange = 1f..19f, steps = 17,
                    enabled = !busy, colors = SliderDefaults.colors(thumbColor = Snake.Accent, activeTrackColor = Snake.Accent))
                Text(" ${model.level}", color = Snake.Fg2)
            }
            Text(
                when {
                    model.level <= 3 -> "Fastest"
                    model.level <= 9 -> "Balanced (desktop default is 9)"
                    model.level <= 15 -> "Smaller, slower"
                    else -> "Smallest, much slower"
                },
                color = Snake.Fg3, style = MaterialTheme.typography.bodySmall,
            )
            Spacer(Modifier.height(14.dp))
            PrimaryButton("Compress to .snake", { save.launch(model.suggestedName()) }, Modifier.fillMaxWidth(),
                enabled = !busy && model.inputs.isNotEmpty(), icon = Icons.Default.Compress)
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun UnpackTab(model: CompressorModel, busy: Boolean) {
    val pickArchive = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(model::openArchive) }
    val pickDest = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { it?.let { d -> model.unpack(d) } }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            Spacer(Modifier.height(6.dp))
            val a = model.archive
            if (a == null) {
                DropZone("Open a .snake archive", Modifier.fillMaxWidth(), icon = Icons.Default.FileOpen) {
                    pickArchive.launch(arrayOf("*/*"))
                }
            } else {
                SnakeCard {
                    Text(a.name, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(formatSize(a.size), color = Snake.Fg2, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(10.dp))
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PrimaryButton("Unpack to...", { pickDest.launch(null) }, enabled = !busy, icon = Icons.Default.Unarchive)
                        SecondaryButton("Test", { model.unpack(null) }, enabled = !busy, icon = Icons.Default.Verified)
                    }
                    Spacer(Modifier.height(6.dp))
                    SecondaryButton("Open another", { pickArchive.launch(arrayOf("*/*")) }, enabled = !busy)
                }
            }
            if (model.listing.isNotEmpty()) {
                Spacer(Modifier.height(10.dp))
                SectionLabel("Contents · ${model.listing.count { it.kind == NativeSnake.KIND_FILE }} files")
            }
        }
        items(model.listing) { e ->
            Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                Text(
                    if (e.kind == NativeSnake.KIND_DIR) "${e.name}/" else e.name, Modifier.weight(1f),
                    fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodySmall,
                    color = if (e.kind == NativeSnake.KIND_DIR) Snake.Fg2 else Snake.Fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                if (e.kind == NativeSnake.KIND_FILE) Text(formatSize(e.size), color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun StatusPanel(model: CompressorModel) {
    SnakeCard(
        Modifier.fillMaxWidth().navigationBarsPadding().padding(12.dp),
        state = when { model.busy != null -> CardState.Normal; model.failed -> CardState.Failed; else -> CardState.Done },
    ) {
        if (model.busy != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${model.busy}... ${model.progress?.let { "${(it * 100).toInt()}%" } ?: ""}")
                    Text(model.current, color = Snake.Fg2, style = MaterialTheme.typography.bodySmall, maxLines = 1,
                        overflow = TextOverflow.Ellipsis)
                }
                DangerButton("Cancel", model::cancel)
            }
            Spacer(Modifier.height(8.dp))
            SnakeProgress(model.progress)
        } else {
            Text(model.result.orEmpty(), color = if (model.failed) Snake.ErrorSoft else Snake.Highlight)
        }
    }
}
