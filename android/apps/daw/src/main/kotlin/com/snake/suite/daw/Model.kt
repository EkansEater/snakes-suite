package com.snake.suite.daw

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.snake.suite.core.Collection
import com.snake.suite.core.publish
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** native/daw: the desktop DAW's engine and controller, compiled for Android. */
object NativeDaw {
    init { System.loadLibrary("snakedaw_android") }

    /** Opens the sound card and the last project. Returns why it failed, or null. */
    @JvmStatic external fun start(context: Any, home: String, config: String): String?
    @JvmStatic external fun stop()
    @JvmStatic external fun state(): String
    @JvmStatic external fun call(op: String, args: String): String
    @JvmStatic external fun peaks(file: String, buckets: Int): String
}

// ------------------------------------------------------------------ the snapshot

data class Clip(val id: Long, val file: String, val start: Long, val offset: Long, val len: Long)

data class FxParam(val name: String, val min: Float, val max: Float, val default: Float, val unit: String, val log: Boolean, val step: Float)

data class Fx(val id: Long, val kind: String, val bypass: Boolean, val params: List<Float>)

data class Track(
    val id: Long, val name: String, val input: Int?, val volumeDb: Float, val pan: Float,
    val mute: Boolean, val solo: Boolean, val arm: Boolean, val monitor: Boolean, val fxOn: Boolean, val color: Int,
    val clips: List<Clip>, val fx: List<Fx>,
)

data class Looper(val state: List<Int>, val gain: List<Float>, val len: Long, val pos: Long, val countIn: Boolean, val click: Boolean) {
    companion object {
        const val EMPTY = 0; const val RECORDING = 1; const val PLAYING = 2; const val OVERDUB = 3; const val STOPPED = 4; const val COUNTING = 5
    }
}

data class AudioInfo(
    val input: String?, val output: String?, val inputProblem: String?,
    val inputDevices: List<Pair<String, String>>, val outputDevices: List<Pair<String, String>>,
    val bufferSize: Int, val recOffsetMs: Float, val deviceIn: String, val deviceOut: String,
)

data class Snapshot(
    val name: String, val bpm: Float, val beatsPerBar: Int, val masterDb: Float, val metronome: Boolean, val countIn: Boolean,
    val loopOn: Boolean, val loopStart: Long, val loopEnd: Long, val tracks: List<Track>, val loopSources: List<List<Long>>,
    val dir: String, val sr: Int, val pos: Long, val playing: Boolean, val recording: Boolean, val recAt: Long,
    val recFrames: Map<Long, Long>, val status: String, val export: Float?, val meters: Map<Long, Pair<Float, Float>>,
    val master: Pair<Float, Float>, val xruns: Int, val cpu: Float, val buffer: Int, val latency: Long, val inputsAvailable: Int,
    val fxInfo: Map<Long, Pair<String, List<FxParam>>>, val selTrack: Long?, val selClip: Pair<Long, Long>?,
    val tunerOn: Boolean, val tuner: Triple<String, Float, Float>?, val looper: Looper, val audio: AudioInfo,
) {
    fun seconds(frames: Long) = frames.toDouble() / sr.coerceAtLeast(1)
    val beatFrames: Double get() = sr * 60.0 / bpm.coerceAtLeast(20f)
    val end: Long get() = tracks.flatMap { it.clips }.maxOfOrNull { it.start + it.len } ?: 0

    companion object {
        private fun JSONArray.longs() = (0 until length()).map { getLong(it) }
        private fun JSONObject.optLongOrNull(k: String) = if (isNull(k)) null else optLong(k)

        fun parse(text: String): Snapshot? {
            if (text == "null") return null
            val o = JSONObject(text)
            val p = o.getJSONObject("project")
            val tracks = p.getJSONArray("tracks").let { arr ->
                (0 until arr.length()).map { arr.getJSONObject(it) }.map { t ->
                    val input = t.get("input").let { i ->
                        when {
                            i is JSONObject && i.has("Hw") -> i.getInt("Hw")
                            else -> null
                        }
                    }
                    Track(
                        t.getLong("id"), t.getString("name"), input, t.getDouble("volume_db").toFloat(), t.getDouble("pan").toFloat(),
                        t.getBoolean("mute"), t.getBoolean("solo"), t.getBoolean("arm"), t.getBoolean("monitor"), t.getBoolean("fx_on"),
                        t.getInt("color"),
                        t.getJSONArray("clips").let { c ->
                            (0 until c.length()).map { c.getJSONObject(it) }.map {
                                Clip(it.getLong("id"), it.getString("file"), it.getLong("start"), it.getLong("offset"), it.getLong("len"))
                            }
                        },
                        t.getJSONArray("fx").let { c ->
                            (0 until c.length()).map { c.getJSONObject(it) }.map {
                                val ps = it.getJSONArray("params")
                                Fx(it.getLong("id"), it.getString("kind"), it.getBoolean("bypass"), (0 until ps.length()).map { i -> ps.getDouble(i).toFloat() })
                            }
                        },
                    )
                }
            }
            val fxInfo = o.getJSONObject("fxInfo").let { m ->
                m.keys().asSequence().associate { k ->
                    val e = m.getJSONObject(k)
                    val ps = e.getJSONArray("params")
                    k.toLong() to (e.getString("name") to (0 until ps.length()).map { ps.getJSONObject(it) }.map {
                        FxParam(it.getString("name"), it.getDouble("min").toFloat(), it.getDouble("max").toFloat(), it.getDouble("default").toFloat(),
                            it.getString("unit"), it.getBoolean("log"), it.getDouble("step").toFloat())
                    })
                }
            }
            val meters = o.getJSONObject("meters").let { m ->
                m.keys().asSequence().associate { k -> m.getJSONArray(k).let { k.toLong() to (it.getDouble(0).toFloat() to it.getDouble(1).toFloat()) } }
            }
            val lp = o.getJSONObject("looper")
            val au = o.getJSONObject("audio")
            fun devices(a: JSONArray) = (0 until a.length()).map { a.getJSONArray(it).let { d -> d.getString(0) to d.getString(1) } }
            val master = o.getJSONArray("master")
            return Snapshot(
                p.getString("name"), p.getDouble("bpm").toFloat(), p.getInt("beats_per_bar"), p.getDouble("master_db").toFloat(),
                p.getBoolean("metronome"), p.getBoolean("count_in"), p.getBoolean("loop_on"), p.getLong("loop_start"), p.getLong("loop_end"),
                tracks, p.getJSONArray("loop_sources").let { a -> (0 until a.length()).map { a.getJSONArray(it).longs() } },
                o.getString("dir"), o.getInt("sr"), o.getLong("pos"), o.getBoolean("playing"), o.getBoolean("recording"), o.getLong("recAt"),
                o.getJSONArray("recs").let { a -> (0 until a.length()).map { a.getJSONObject(it) }.associate { it.getLong("track") to it.getLong("frames") } },
                o.getString("status"), if (o.isNull("export")) null else o.getDouble("export").toFloat(), meters,
                master.getDouble(0).toFloat() to master.getDouble(1).toFloat(), o.getInt("xruns"), o.getDouble("cpu").toFloat(), o.getInt("buffer"),
                o.getLong("latency"), o.getInt("inputsAvailable"), fxInfo, o.optLongOrNull("selTrack"),
                o.optJSONArray("selClip")?.let { it.getLong(0) to it.getLong(1) }, o.getBoolean("tunerOn"),
                o.optJSONObject("tuner")?.let { Triple(it.getString("note"), it.getDouble("freq").toFloat(), it.getDouble("cents").toFloat()) },
                Looper(
                    lp.getJSONArray("state").let { a -> (0 until a.length()).map { a.getInt(it) } },
                    lp.getJSONArray("gain").let { a -> (0 until a.length()).map { a.getDouble(it).toFloat() } },
                    lp.getLong("len"), lp.getLong("pos"), lp.getBoolean("countIn"), lp.getBoolean("click"),
                ),
                AudioInfo(
                    au.optString("input").takeIf { !au.isNull("input") }, au.optString("output").takeIf { !au.isNull("output") },
                    au.optString("inputProblem").takeIf { !au.isNull("inputProblem") },
                    devices(au.getJSONArray("inputDevices")), devices(au.getJSONArray("outputDevices")),
                    au.getInt("bufferSize"), au.getDouble("recOffsetMs").toFloat(), au.getString("deviceIn"), au.getString("deviceOut"),
                ),
            )
        }
    }
}

// ------------------------------------------------------------------ the view model

class DawModel(app: Application) : AndroidViewModel(app) {
    var state by mutableStateOf<Snapshot?>(null); private set
    var error by mutableStateOf<String?>(null); private set
    var message by mutableStateOf<String?>(null)
    var fxKinds by mutableStateOf<List<Pair<String, String>>>(emptyList()); private set
    private var poll: Job? = null
    private val peakCache = HashMap<String, Pair<Long, FloatArray>>()
    private var lastStatus = ""

    /** Projects live in the app's folder on shared storage; exports are also copied to Music. */
    private val home: File get() = getApplication<Application>().getExternalFilesDir(null) ?: getApplication<Application>().filesDir

    fun start() {
        if (poll != null) return
        poll = viewModelScope.launch {
            val err = withContext(Dispatchers.IO) {
                NativeDaw.start(getApplication(), home.path, File(getApplication<Application>().filesDir, "config").path)
            }
            error = err
            if (err != null) return@launch
            fxKinds = runCatching {
                val arr = JSONObject(NativeDaw.call("fx_kinds", "{}")).getJSONArray("ok")
                (0 until arr.length()).map { arr.getJSONObject(it).let { o -> o.getString("kind") to o.getString("name") } }
            }.getOrDefault(emptyList())
            while (isActive) {
                val s = withContext(Dispatchers.IO) { Snapshot.parse(NativeDaw.state()) }
                state = s
                s?.status?.let { st ->
                    if (st != lastStatus) {
                        lastStatus = st
                        if (st.startsWith("Exported to ")) publishExport(st.removePrefix("Exported to "))
                        else if (st.isNotEmpty()) message = st
                    }
                }
                delay(33)
            }
        }
    }

    /** Close the sound card; the engine saves the project on the way out. */
    fun stop() {
        poll?.cancel()
        poll = null
        NativeDaw.stop()
    }

    val busy: Boolean get() = state?.let { it.playing || it.recording || it.looper.state.any { s -> s == Looper.RECORDING || s == Looper.PLAYING || s == Looper.OVERDUB } } == true

    /** Send one operation to the engine (see native/daw/src/api.rs). */
    fun op(name: String, vararg args: Pair<String, Any?>): JSONObject {
        val o = JSONObject()
        args.forEach { (k, v) -> o.put(k, v ?: JSONObject.NULL) }
        val r = JSONObject(NativeDaw.call(name, o.toString()))
        r.optString("error").takeIf { it.isNotEmpty() }?.let { message = it }
        return r
    }

    fun track(id: Long, field: String, value: Any?) = op("track", "id" to id, "field" to field, "value" to value)
    fun project(field: String, value: Any?) = op("project", "field" to field, "value" to value)

    /** A file's length in frames and its waveform (min/max pairs), fetched once per file. */
    fun peaks(file: String): Pair<Long, FloatArray> = peakCache[file] ?: run {
        val o = JSONObject(NativeDaw.peaks(file, 2048))
        val arr = o.getJSONArray("peaks")
        val v = o.getLong("frames") to FloatArray(arr.length()) { arr.getDouble(it).toFloat() }
        if (v.first > 0) peakCache[file] = v
        v
    }

    fun projects(): List<Pair<String, String>> = runCatching {
        val arr = op("projects").getJSONArray("ok")
        (0 until arr.length()).map { arr.getJSONObject(it).let { o -> o.getString("path") to o.getString("name") } }
    }.getOrDefault(emptyList())

    fun restartAudio() {
        stop()
        peakCache.clear()
        start()
    }

    /** Copy a finished mixdown into Music/Snake's DAW, where music players see it. */
    private fun publishExport(path: String) {
        viewModelScope.launch(Dispatchers.IO) {
            val src = File(path)
            runCatching {
                val ctx = getApplication<Application>()
                val copy = File(ctx.cacheDir, src.name)
                src.copyTo(copy, overwrite = true)
                ctx.publish(copy, src.name, "Snake's DAW", Collection.Music)
            }.onSuccess { message = "Exported to Music/Snake's DAW/${src.name}" }
                .onFailure { message = "Exported to ${src.path}" }
        }
    }

    override fun onCleared() {
        stop()
    }
}
