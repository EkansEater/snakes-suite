package com.snake.suite.mp3

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.compose.runtime.mutableStateListOf
import com.chaquo.python.PyException
import com.chaquo.python.PyObject
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform
import com.snake.suite.core.Collection
import com.snake.suite.core.publish
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger

enum class Status { Queued, Working, Done, Failed, Cancelled }

data class Saved(val uri: Uri, val name: String)

data class Download(
    val id: Int,
    val url: String,
    val title: String = url,
    val uploader: String = "",
    val thumbnail: Bitmap? = null,
    val playlist: String? = null,
    val index: Int = 1,
    val count: Int = 1,
    val status: Status = Status.Queued,
    val stage: String = "Waiting…",
    val percent: Float = -1f,
    val detail: String = "",
    val saved: List<Saved> = emptyList(),
    val error: String? = null,
)

/** Settings, the same choices as the desktop app. */
class Settings(context: Context) {
    private val p = context.getSharedPreferences("mp3", Context.MODE_PRIVATE)
    var quality: String get() = p.getString("quality", "320K")!!; set(v) = p.edit().putString("quality", v).apply()
    var template: String get() = p.getString("template", "%(title)s")!!; set(v) = p.edit().putString("template", v).apply()
    var playlist: Boolean get() = p.getBoolean("playlist", false); set(v) = p.edit().putBoolean("playlist", v).apply()
    var thumbnail: Boolean get() = p.getBoolean("thumbnail", true); set(v) = p.edit().putBoolean("thumbnail", v).apply()
    var metadata: Boolean get() = p.getBoolean("metadata", true); set(v) = p.edit().putBoolean("metadata", v).apply()
    var skipExisting: Boolean get() = p.getBoolean("skip", true); set(v) = p.edit().putBoolean("skip", v).apply()
    var parallel: Int get() = p.getInt("parallel", 2); set(v) = p.edit().putInt("parallel", v).apply()

    companion object {
        val QUALITIES = linkedMapOf("320 kbps (best)" to "320K", "256 kbps" to "256K", "192 kbps" to "192K",
            "128 kbps (small)" to "128K", "VBR V0 (~245 kbps)" to "0")
        val TEMPLATES = linkedMapOf(
            "Title" to "%(title)s",
            "Artist - Title" to "%(artist,creator,uploader|Unknown)s - %(title)s",
            "Title [video ID]" to "%(title)s [%(id)s]",
            "Upload date - Title" to "%(upload_date>%Y-%m-%d|)s - %(title)s",
        )
    }
}

/** Called from Python on yt-dlp's thread. Kept public and unrenamed for Chaquopy (proguard-rules.pro). */
class Listener(private val onMeta: (String) -> Unit, private val onProgress: (Double, String) -> Unit, private val onStage: (String) -> Unit) {
    fun meta(json: String) = onMeta(json)
    fun progress(percent: Double, detail: String) = onProgress(percent, detail)
    fun stage(text: String) = onStage(text)
}

/** The download queue. App-wide, so the foreground service and the screen share it. */
object Downloads {
    const val FOLDER = "Snake's MP3 Converter"
    val items = mutableStateListOf<Download>()
    private val ids = AtomicInteger()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val jobs = mutableMapOf<Int, Pair<Job, PyObject?>>()
    private var slots = Semaphore(2)
    private var slotCount = 2

    val busy: Boolean get() = items.any { it.status == Status.Queued || it.status == Status.Working }

    private fun python(context: Context): Python {
        if (!Python.isStarted()) Python.start(AndroidPlatform(context.applicationContext))
        return Python.getInstance()
    }

    /** Links anywhere in [text], as shared from a browser or the YouTube app. */
    fun links(text: String): List<String> =
        Regex("""https?://[^\s<>"']+""").findAll(text).map { it.value.trimEnd('.', ',', ')', ']') }.distinct().toList()

    fun add(context: Context, text: String): Int {
        val urls = links(text)
        urls.forEach { url ->
            if (items.any { it.url == url && (it.status == Status.Queued || it.status == Status.Working) }) return@forEach
            val d = Download(ids.incrementAndGet(), url)
            items.add(0, d)
            start(context, d)
        }
        return urls.size
    }

    private fun update(id: Int, change: (Download) -> Download) {
        val i = items.indexOfFirst { it.id == id }
        if (i >= 0) items[i] = change(items[i])
    }

    fun retry(context: Context, d: Download) {
        update(d.id) { it.copy(status = Status.Queued, stage = "Waiting…", error = null, percent = -1f, detail = "") }
        start(context, d)
    }

    fun cancel(d: Download) {
        jobs[d.id]?.let { (job, py) -> runCatching { py?.callAttr("cancel") }; if (py == null) job.cancel() }
        if (items.firstOrNull { it.id == d.id }?.status == Status.Queued) update(d.id) { it.copy(status = Status.Cancelled, stage = "Cancelled") }
    }

    fun remove(d: Download) {
        cancel(d)
        items.removeAll { it.id == d.id }
    }

    fun clearFinished() = items.removeAll { it.status == Status.Done || it.status == Status.Cancelled || it.status == Status.Failed }

    private fun start(context: Context, d: Download) {
        val app = context.applicationContext
        val settings = Settings(app)
        if (settings.parallel != slotCount) { slotCount = settings.parallel; slots = Semaphore(slotCount) }
        DownloadService.ensureRunning(app)
        val sem = slots
        val job = scope.launch {
            sem.withPermit {
                if (items.firstOrNull { it.id == d.id }?.status != Status.Queued) return@withPermit
                update(d.id) { it.copy(status = Status.Working, stage = "Starting…") }
                val work = File(app.cacheDir, "mp3/${d.id}").apply { deleteRecursively(); mkdirs() }
                try {
                    val paths = withContext(Dispatchers.IO) { run(app, d, settings, work) }
                    val saved = withContext(Dispatchers.IO) {
                        paths.map { path ->
                            val f = File(path)
                            val sub = f.parentFile?.relativeTo(work)?.path?.takeIf { it.isNotEmpty() && it != "." }
                            Saved(app.publish(f, f.name, if (sub == null) FOLDER else "$FOLDER/$sub", Collection.Music), f.name)
                        }
                    }
                    update(d.id) {
                        it.copy(status = Status.Done, saved = saved, percent = 100f, detail = "",
                            stage = when {
                                saved.isEmpty() -> "Already converted"
                                saved.size == 1 -> "Saved to Music/$FOLDER"
                                else -> "${saved.size} tracks saved to Music/$FOLDER"
                            })
                    }
                } catch (e: PyException) {
                    val msg = e.message.orEmpty()
                    if (msg.startsWith("Cancelled")) update(d.id) { it.copy(status = Status.Cancelled, stage = "Cancelled") }
                    else update(d.id) { it.copy(status = Status.Failed, error = msg.removePrefix("RuntimeError: ").ifEmpty { "Failed" }) }
                } catch (e: Throwable) {
                    update(d.id) { it.copy(status = Status.Failed, error = e.message ?: e.javaClass.simpleName) }
                } finally {
                    work.deleteRecursively()
                    jobs.remove(d.id)
                    DownloadService.refresh(app)
                }
            }
        }
        jobs[d.id] = job to null
    }

    private fun run(context: Context, d: Download, s: Settings, work: File): List<String> {
        val lib = context.applicationInfo.nativeLibraryDir
        val options = JSONObject()
            .put("output_dir", work.path)
            .put("quality", s.quality)
            .put("name_template", s.template)
            .put("whole_playlist", s.playlist)
            .put("embed_thumbnail", s.thumbnail)
            .put("embed_metadata", s.metadata)
            .put("skip_existing", s.skipExisting)
            .put("archive", File(context.filesDir, "downloaded.txt").path)
            .put("ffmpeg", "$lib/libffmpeg.so")
            .put("quickjs", "$lib/libqjs.so")
        cookies(context).takeIf { it.exists() }?.let { options.put("cookies", it.path) }
        val listener = Listener(
            onMeta = { json ->
                val m = JSONObject(json)
                val thumb = m.optString("thumbnail").takeIf { it.isNotEmpty() && it != "null" }
                scope.launch {
                    update(d.id) {
                        it.copy(title = m.optString("title", it.title), uploader = m.optString("uploader"),
                            index = m.optInt("index", 1), count = m.optInt("count", 1),
                            playlist = m.optString("playlist").takeIf { p -> p.isNotEmpty() && p != "null" })
                    }
                    if (thumb != null && items.firstOrNull { it.id == d.id }?.thumbnail == null) {
                        val bmp = withContext(Dispatchers.IO) { runCatching { URL(thumb).openStream().use(BitmapFactory::decodeStream) }.getOrNull() }
                        update(d.id) { it.copy(thumbnail = bmp) }
                    }
                }
            },
            onProgress = { pct, detail -> scope.launch { update(d.id) { it.copy(percent = pct.toFloat(), detail = detail) } } },
            onStage = { text -> scope.launch { update(d.id) { it.copy(stage = text) } } },
        )
        val py = python(context).getModule("snakes_mp3_android").callAttr("Job", d.url, options.toString(), listener)
        jobs[d.id] = (jobs[d.id]?.first ?: Job()) to py
        return py.callAttr("run").asList().map { it.toString() }
    }

    fun cookies(context: Context) = File(context.filesDir, "cookies.txt")

    fun ytDlpVersion(context: Context): String = runCatching {
        python(context).getModule("snakes_mp3_android").callAttr("version").toString()
    }.getOrDefault("?")

    fun share(context: Context, uri: Uri) {
        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("audio/mpeg")
            .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
