package com.snake.suite.converter

import com.snake.suite.media.Ffmpeg
import com.snake.suite.media.FfmpegError
import java.io.File

/** Audio and video through the bundled ffmpeg, with the desktop app's settings. */
class MediaConverter(private val ffmpeg: Ffmpeg) : Converter {

    private fun audioArgs(target: String, opts: Options): List<String> {
        val rate = opts.audioBitrate
        val codec = when (target) {
            "wav" -> listOf("-c:a", "pcm_s16le")
            "aiff" -> listOf("-c:a", "pcm_s16be")
            "flac" -> listOf("-c:a", "flac")
            "mp3" -> listOf("-c:a", "libmp3lame", "-b:a", rate)
            "ogg" -> listOf("-c:a", "libvorbis", "-b:a", rate)
            "opus" -> listOf("-c:a", "libopus", "-b:a", rate)
            "m4a", "aac" -> listOf("-c:a", "aac", "-b:a", rate)
            "wma" -> listOf("-c:a", "wmav2", "-b:a", rate)
            else -> throw ConversionError("Unsupported audio format: $target")
        }
        return listOf("-vn") + codec
    }

    private fun videoArgs(target: String, opts: Options): List<String> {
        val rate = opts.audioBitrate
        // OpenH264 has no CRF, so quality is a bitrate ceiling on a 1080p-ish picture.
        val h264Rate = mapOf("high" to "8M", "balanced" to "4M", "small" to "1500k")[opts.videoQuality] ?: "4M"
        val crf = mapOf("high" to 18, "balanced" to 23, "small" to 28)[opts.videoQuality] ?: 23
        return when (target) {
            "mp4", "mov", "mkv" -> buildList {
                addAll(listOf("-c:v", "libopenh264", "-b:v", h264Rate, "-maxrate", h264Rate, "-allow_skip_frames", "1",
                    "-pix_fmt", "yuv420p", "-vf", EVEN, "-c:a", "aac", "-b:a", rate))
                if (target != "mkv") addAll(listOf("-movflags", "+faststart"))
            }
            "webm" -> listOf("-c:v", "libvpx-vp9", "-crf", "${crf + 9}", "-b:v", "0", "-row-mt", "1", "-deadline", "good",
                "-cpu-used", "4", "-c:a", "libopus", "-b:a", rate)
            "avi" -> {
                val q = mapOf("high" to 3, "balanced" to 5, "small" to 8)[opts.videoQuality] ?: 5
                listOf("-c:v", "mpeg4", "-q:v", "$q", "-c:a", "libmp3lame", "-b:a", rate)
            }
            "gif" -> {
                val width = mapOf("high" to 640, "balanced" to 480, "small" to 320)[opts.videoQuality] ?: 480
                listOf("-an", "-vf", "fps=12,scale='min($width,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse")
            }
            else -> throw ConversionError("Unsupported video format: $target")
        }
    }

    override suspend fun convert(src: File, outDir: File, stem: String, target: String, opts: Options, progress: Progress): List<File> {
        if (!ffmpeg.available) throw ConversionError("ffmpeg is missing from this build")
        val dst = File(outDir, "$stem.$target")
        val args = if (target in Formats.AUDIO_OUT) audioArgs(target, opts) else videoArgs(target, opts)
        val total = ffmpeg.duration(src.path)
        try {
            ffmpeg.run(listOf("-i", src.path) + args + dst.path, total, progress)
        } catch (e: FfmpegError) {
            dst.delete()
            throw ConversionError(e.message ?: "ffmpeg failed")
        } catch (e: Throwable) {
            dst.delete()
            throw e
        }
        return listOf(dst)
    }

    companion object {
        private const val EVEN = "scale=trunc(iw/2)*2:trunc(ih/2)*2"   // H.264 needs even dimensions
    }
}
