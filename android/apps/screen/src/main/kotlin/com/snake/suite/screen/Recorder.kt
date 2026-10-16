package com.snake.suite.screen

import android.annotation.SuppressLint
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.os.Bundle
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.concurrent.thread

/** What to record: the same choices as the desktop recorder. */
data class RecordConfig(
    val mode: Mode = Mode.Video,
    val width: Int,
    val height: Int,
    val dpi: Int,
    val fps: Int = 30,
    val videoBitrate: Int = 8_000_000,
    val systemAudio: Boolean = true,
    val microphone: Boolean = false,
) {
    enum class Mode(val label: String, val ext: String) { Video("Video (MP4)", "mp4"), Gif("GIF", "gif"), Audio("Audio (MP3)", "mp3") }
    val hasVideo get() = mode != Mode.Audio
    val hasAudio get() = mode != Mode.Gif && (systemAudio || microphone)
}

/**
 * Screen and sound into an MP4: the screen through a VirtualDisplay into the
 * hardware H.264 encoder, system sound (AudioPlaybackCapture) and the mic mixed
 * into AAC, both muxed together. Pausing drops input and shifts timestamps so
 * the file plays straight through, like the desktop recorder's joined segments.
 */
class Recorder(private val projection: MediaProjection?, private val config: RecordConfig, private val output: File) {
    private var muxer: MediaMuxer? = null
    private var videoCodec: MediaCodec? = null
    private var audioCodec: MediaCodec? = null
    private var display: VirtualDisplay? = null
    private val records = mutableListOf<AudioRecord>()
    private var videoTrack = -1
    private var audioTrack = -1
    private var muxerStarted = false
    private val pending = mutableListOf<Triple<Int, ByteBuffer, MediaCodec.BufferInfo>>()
    private val lock = Object()
    @Volatile private var running = false
    @Volatile var paused = false
        private set
    private var pausedAt = 0L
    private var pausedTotalUs = 0L
    private var lastVideoPts = 0L
    private var lastAudioPts = -1L
    private var startUs = 0L   // both tracks count from here (screen frames carry System.nanoTime stamps)
    private val threads = mutableListOf<Thread>()
    @Volatile var error: Throwable? = null
        private set

    private val expectedTracks get() = (if (config.hasVideo) 1 else 0) + (if (config.hasAudio) 1 else 0)

    fun start() {
        muxer = MediaMuxer(output.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        startUs = System.nanoTime() / 1000
        running = true
        if (config.hasVideo) startVideo()
        if (config.hasAudio) startAudio()
        if (expectedTracks == 0) error("Nothing to record: pick system sound or the microphone")
    }

    // ------------------------------------------------------------- video

    private fun startVideo() {
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, config.width, config.height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, config.videoBitrate)
            setInteger(MediaFormat.KEY_FRAME_RATE, config.fps)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 2)
            // Repeat the last frame when the screen is still, so the video keeps time.
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 1_000_000L / config.fps)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = codec.createInputSurface()
        codec.start()
        videoCodec = codec
        display = projection!!.createVirtualDisplay(
            "Snake's Screen Recorder", config.width, config.height, config.dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, null,
        )
        threads += thread(name = "video-drain") { drain(codec, isVideo = true) }
    }

    // ------------------------------------------------------------- audio

    @SuppressLint("MissingPermission")   // checked before the service starts
    private fun startAudio() {
        val rate = 48_000
        val channels = AudioFormat.CHANNEL_IN_STEREO
        val pcm = AudioFormat.ENCODING_PCM_16BIT
        val min = AudioRecord.getMinBufferSize(rate, channels, pcm)
        val fmt = AudioFormat.Builder().setSampleRate(rate).setChannelMask(channels).setEncoding(pcm).build()
        if (config.systemAudio && projection != null) {
            val capture = AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .build()
            records += AudioRecord.Builder().setAudioFormat(fmt).setBufferSizeInBytes(min * 4)
                .setAudioPlaybackCaptureConfig(capture).build()
        }
        if (config.microphone) {
            records += AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.MIC).setAudioFormat(fmt)
                .setBufferSizeInBytes(min * 4).build()
        }
        if (records.isEmpty()) return
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, rate, 2).apply {
            setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
            setInteger(MediaFormat.KEY_BIT_RATE, 192_000)
            setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
        codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        codec.start()
        audioCodec = codec
        records.forEach { it.startRecording() }
        threads += thread(name = "audio-mix") { mixAudio(codec, rate) }
        threads += thread(name = "audio-drain") { drain(codec, isVideo = false) }
    }

    /** Read every source in step, add them up (clipping), and feed the AAC encoder. */
    private fun mixAudio(codec: MediaCodec, rate: Int) {
        val frames = 1024
        val bytes = frames * 4
        val bufs = records.map { ByteArray(bytes) }
        val mix = ShortArray(frames * 2)
        var samples = 0L
        var offsetUs = -1L
        try {
            while (running) {
                bufs.forEachIndexed { i, b -> readFully(records[i], b) }
                if (offsetUs < 0) offsetUs = System.nanoTime() / 1000 - startUs
                if (paused) continue
                mix.fill(0)
                for (b in bufs) {
                    val s = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                    for (k in mix.indices) mix[k] = (mix[k] + s.get(k)).coerceIn(-32768, 32767).toShort()
                }
                val index = codec.dequeueInputBuffer(10_000)
                if (index < 0) continue
                val input = codec.getInputBuffer(index)!!
                input.clear()
                input.order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(mix)
                val pts = offsetUs + samples * 1_000_000L / rate
                codec.queueInputBuffer(index, 0, bytes, pts, 0)
                samples += frames
            }
            val index = codec.dequeueInputBuffer(100_000)
            if (index >= 0) codec.queueInputBuffer(index, 0, 0, offsetUs.coerceAtLeast(0) + samples * 1_000_000L / rate, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        } catch (e: Throwable) {
            fail(e)
        }
    }

    private fun readFully(r: AudioRecord, b: ByteArray) {
        var off = 0
        while (off < b.size && running) {
            val n = r.read(b, off, b.size - off)
            if (n <= 0) break
            off += n
        }
    }

    // ------------------------------------------------------------- muxing

    private fun drain(codec: MediaCodec, isVideo: Boolean) {
        val info = MediaCodec.BufferInfo()
        try {
            while (true) {
                val index = codec.dequeueOutputBuffer(info, 10_000)
                when {
                    index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> synchronized(lock) {
                        val track = muxer!!.addTrack(codec.outputFormat)
                        if (isVideo) videoTrack = track else audioTrack = track
                        if ((videoTrack >= 0 || !config.hasVideo) && (audioTrack >= 0 || audioCodec == null)) {
                            muxer!!.start()
                            muxerStarted = true
                            pending.forEach { (t, b, i) -> muxer!!.writeSampleData(t, b, i) }
                            pending.clear()
                        }
                    }
                    index >= 0 -> {
                        val buf = codec.getOutputBuffer(index)!!
                        val eos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                        if (info.size > 0) write(isVideo, buf, info)
                        codec.releaseOutputBuffer(index, false)
                        if (eos) break
                    }
                }
            }
        } catch (e: Throwable) {
            fail(e)
        }
    }

    private fun write(isVideo: Boolean, buf: ByteBuffer, info: MediaCodec.BufferInfo) {
        synchronized(lock) {
            if (isVideo) {
                // Video frames keep arriving while paused: drop them, and close the gap afterwards.
                if (paused) return
                info.presentationTimeUs -= startUs + pausedTotalUs
                if (info.presentationTimeUs < 0) return
                if (info.presentationTimeUs <= lastVideoPts) info.presentationTimeUs = lastVideoPts + 1
                lastVideoPts = info.presentationTimeUs
            } else {
                if (info.presentationTimeUs <= lastAudioPts) info.presentationTimeUs = lastAudioPts + 1
                lastAudioPts = info.presentationTimeUs
            }
            val track = if (isVideo) videoTrack else audioTrack
            if (muxerStarted) {
                muxer!!.writeSampleData(track, buf, info)
            } else {
                val copy = ByteBuffer.allocate(info.size).put(buf.apply { position(info.offset); limit(info.offset + info.size) }).flip() as ByteBuffer
                val i = MediaCodec.BufferInfo().apply { set(0, info.size, info.presentationTimeUs, info.flags) }
                pending += Triple(track, copy, i)
            }
        }
    }

    // ------------------------------------------------------------- control

    fun pause() {
        if (paused) return
        synchronized(lock) {
            paused = true
            pausedAt = System.nanoTime() / 1000
        }
    }

    fun resume() {
        if (!paused) return
        synchronized(lock) {
            pausedTotalUs += System.nanoTime() / 1000 - pausedAt
            paused = false
        }
        videoCodec?.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
    }

    private fun fail(e: Throwable) {
        Log.e("SnakeScreen", "recording failed", e)
        if (error == null) error = e
        running = false
    }

    /** Finish the file. Returns false when nothing usable was recorded. */
    fun stop(): Boolean {
        if (paused) resume()
        running = false
        runCatching { videoCodec?.signalEndOfInputStream() }
        threads.forEach { it.join(3000) }
        display?.release()
        records.forEach { runCatching { it.stop() }; it.release() }
        listOfNotNull(videoCodec, audioCodec).forEach { runCatching { it.stop() }; it.release() }
        val ok = muxerStarted
        runCatching { if (muxerStarted) muxer?.stop() }
        muxer?.release()
        return ok && output.length() > 0
    }
}
