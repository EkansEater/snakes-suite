package com.snake.suite.soundpad

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import java.io.File

/** Plays clips. Each play gets its own MediaPlayer so overlapping clips can mix. */
class Player(private val context: Context, private val onChange: (playing: Set<String>) -> Unit) {
    private val active = mutableMapOf<MediaPlayer, String>()

    val playing: Set<String> get() = active.values.toSet()

    fun play(key: String, file: File, volume: Float, overlap: Boolean) {
        if (!overlap) stopAll(notify = false)
        val mp = MediaPlayer()
        try {
            mp.setAudioAttributes(
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build(),
            )
            mp.setDataSource(file.path)
            mp.setVolume(volume, volume)
            mp.setOnCompletionListener { release(it) }
            mp.setOnErrorListener { p, _, _ -> release(p); true }
            mp.prepare()
            mp.start()
            active[mp] = key
        } catch (e: Exception) {
            mp.release()
            throw e
        } finally {
            onChange(playing)
        }
    }

    private fun release(mp: MediaPlayer) {
        active.remove(mp)
        mp.release()
        onChange(playing)
    }

    fun stop(key: String) {
        active.filterValues { it == key }.keys.toList().forEach { it.stop(); release(it) }
    }

    fun stopAll(notify: Boolean = true) {
        active.keys.toList().forEach { runCatching { it.stop() }; it.release() }
        active.clear()
        if (notify) onChange(playing)
    }
}
