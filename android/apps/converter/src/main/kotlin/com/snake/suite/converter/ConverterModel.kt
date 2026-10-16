package com.snake.suite.converter

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.snake.suite.core.PickedFile
import com.snake.suite.core.copyToCache
import com.snake.suite.core.describe
import com.snake.suite.core.publish
import com.snake.suite.core.publishedPath
import com.snake.suite.media.Ffmpeg
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

enum class State { Ready, Waiting, Converting, Done, Failed, Cancelled }

data class Output(val uri: Uri, val name: String, val where: String)

data class Item(
    val id: Int,
    val file: PickedFile,
    val category: Category?,
    val targets: List<String>,
    val target: String?,
    val state: State = State.Ready,
    val progress: Float? = null,
    val outputs: List<Output> = emptyList(),
    val error: String? = null,
)

class ConverterModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("converter", Context.MODE_PRIVATE)
    private val ffmpeg = Ffmpeg(app)
    private val ids = AtomicInteger()
    private val jobs = mutableMapOf<Int, Job>()
    // Two at a time: phones have the cores, but not the memory for many ffmpegs.
    private val slots = Semaphore(2)

    val items = mutableStateListOf<Item>()
    var options by mutableStateOf(
        Options(
            audioBitrate = prefs.getString("audio_bitrate", "192k")!!,
            videoQuality = prefs.getString("video_quality", "balanced")!!,
            imageQuality = prefs.getInt("image_quality", 90),
            pdfDpi = prefs.getInt("pdf_dpi", 150),
        ),
    ); private set

    fun changeOptions(o: Options) {
        options = o
        prefs.edit().putString("audio_bitrate", o.audioBitrate).putString("video_quality", o.videoQuality)
            .putInt("image_quality", o.imageQuality).putInt("pdf_dpi", o.pdfDpi).apply()
    }

    fun add(uris: List<Uri>) {
        val ctx = getApplication<Application>()
        for (uri in uris) {
            if (items.any { it.file.uri == uri && it.state == State.Ready }) continue
            val f = ctx.describe(uri)
            val targets = Formats.targets(f.name)
            val remembered = prefs.getString("last_${Formats.category(f.name)}", null)
            items += Item(ids.incrementAndGet(), f, Formats.category(f.name), targets,
                remembered?.takeIf { it in targets } ?: targets.firstOrNull(),
                error = if (targets.isEmpty()) "Unsupported file type" else null)
        }
    }

    private fun update(id: Int, change: (Item) -> Item) {
        val i = items.indexOfFirst { it.id == id }
        if (i >= 0) items[i] = change(items[i])
    }

    fun setTarget(item: Item, target: String) {
        update(item.id) { it.copy(target = target, state = if (it.state == State.Done || it.state == State.Failed) State.Ready else it.state) }
        prefs.edit().putString("last_${item.category}", target).apply()
    }

    /** Give every ready file of the same kind this format. */
    fun setTargetForAll(category: Category, target: String) {
        items.filter { it.category == category && it.state == State.Ready && target in it.targets }.forEach { setTarget(it, target) }
    }

    fun remove(item: Item) {
        jobs.remove(item.id)?.cancel()
        items.removeAll { it.id == item.id }
    }

    fun clearFinished() = items.removeAll { it.state in setOf(State.Done, State.Failed, State.Cancelled) || it.targets.isEmpty() }

    fun convertAll() = items.filter { it.state == State.Ready && it.target != null }.forEach(::convert)

    fun cancel(item: Item) {
        jobs.remove(item.id)?.cancel()
        update(item.id) { it.copy(state = State.Cancelled, progress = null) }
    }

    val running: Boolean get() = items.any { it.state == State.Converting || it.state == State.Waiting }

    private fun converterFor(category: Category): Converter = when (category) {
        Category.Audio, Category.Video -> MediaConverter(ffmpeg)
        Category.Image -> ImageConverter(ffmpeg)
        Category.Document -> DocumentConverter()
        Category.Spreadsheet -> SheetConverter()
        Category.Pdf -> PdfConverter()
    }

    fun convert(item: Item) {
        val target = item.target ?: return
        val category = item.category ?: return
        update(item.id) { it.copy(state = State.Waiting, progress = null, error = null, outputs = emptyList()) }
        jobs[item.id] = viewModelScope.launch {
            val ctx = getApplication<Application>()
            val work = File(ctx.cacheDir, "work/${item.id}").apply { deleteRecursively(); mkdirs() }
            try {
                slots.withPermit {
                    update(item.id) { it.copy(state = State.Converting) }
                    val src = withContext(Dispatchers.IO) { ctx.copyToCache(item.file, "work/${item.id}/in") }
                    val out = File(work, "out").apply { mkdirs() }
                    val files = converterFor(category).convert(src, out, item.file.baseName, target, options) { p ->
                        update(item.id) { it.copy(progress = p) }
                    }
                    val outputs = withContext(Dispatchers.IO) {
                        files.map { f -> Output(ctx.publish(f, f.name, FOLDER), f.name, publishedPath(f.name, FOLDER)) }
                    }
                    update(item.id) { it.copy(state = State.Done, progress = 1f, outputs = outputs) }
                }
            } catch (e: CancellationException) {
                update(item.id) { it.copy(state = State.Cancelled, progress = null) }
            } catch (e: Throwable) {
                update(item.id) { it.copy(state = State.Failed, progress = null, error = e.message ?: e.javaClass.simpleName) }
            } finally {
                withContext(Dispatchers.IO + kotlinx.coroutines.NonCancellable) { work.deleteRecursively() }
                jobs.remove(item.id)
            }
        }
    }

    companion object {
        const val FOLDER = "Snake's Converter"
    }
}
