package com.snake.suite.media

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import java.io.File

class FfmpegError(message: String) : Exception(message)

/**
 * The ffmpeg executable built by native/ffmpeg/build.sh. It ships as
 * libffmpeg.so so Android unpacks it into the app's native library folder,
 * the one place an app may run its own programs from.
 */
class Ffmpeg(context: Context) {
    val path: String = File(context.applicationInfo.nativeLibraryDir, "libffmpeg.so").path

    val available: Boolean get() = File(path).canExecute()

    /** Length of [input] in seconds, or 0 when ffmpeg can't tell. */
    suspend fun duration(input: String): Double = withContext(Dispatchers.IO) {
        val out = runCatching {
            val p = ProcessBuilder(path, "-hide_banner", "-nostdin", "-i", input).redirectErrorStream(true).start()
            p.inputStream.bufferedReader().readText().also { p.waitFor() }
        }.getOrDefault("")
        DURATION.find(out)?.destructured?.let { (h, m, s) -> h.toInt() * 3600 + m.toInt() * 60 + s.toDouble() } ?: 0.0
    }

    /**
     * Run ffmpeg with [args] (without the program name). [onProgress] gets 0..1
     * when [totalSeconds] is known. Cancelling the coroutine kills ffmpeg.
     * Throws [FfmpegError] with ffmpeg's last messages when it fails.
     */
    suspend fun run(args: List<String>, totalSeconds: Double = 0.0, onProgress: (Float) -> Unit = {}) =
        withContext(Dispatchers.IO) {
            val cmd = listOf(path, "-y", "-hide_banner", "-loglevel", "error", "-nostdin") + args.dropLast(1) +
                listOf("-progress", "pipe:1", "-nostats", args.last())
            val proc = ProcessBuilder(cmd).redirectErrorStream(true).start()
            val messages = ArrayDeque<String>()
            try {
                proc.inputStream.bufferedReader().useLines { lines ->
                    for (raw in lines) {
                        if (!currentCoroutineContext().isActive) break
                        val line = raw.trim()
                        val t = OUT_TIME.matchEntire(line)
                        if (t != null) {
                            if (totalSeconds > 0) onProgress((t.groupValues[1].toLong() / 1e6 / totalSeconds).toFloat().coerceIn(0f, 0.99f))
                        } else if (line.isNotEmpty() && !KEY_VALUE.matches(line)) {
                            messages.addLast(line)
                            if (messages.size > 8) messages.removeFirst()
                        }
                    }
                }
                if (!currentCoroutineContext().isActive) {
                    proc.destroyForcibly()
                    throw kotlinx.coroutines.CancellationException("Cancelled")
                }
                val code = proc.waitFor()
                if (code != 0) throw FfmpegError(messages.takeLast(5).joinToString("\n").ifEmpty { "ffmpeg exited with code $code" })
                onProgress(1f)
            } finally {
                if (proc.isAlive) proc.destroyForcibly()
            }
        }

    companion object {
        private val DURATION = Regex("""Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)""")
        private val OUT_TIME = Regex("""out_time_(?:us|ms)=(\d+)""")
        private val KEY_VALUE = Regex("""[a-z_0-9]+=.*""")
    }
}
