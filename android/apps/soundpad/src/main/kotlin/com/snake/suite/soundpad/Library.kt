package com.snake.suite.soundpad

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** One clip. [file] is the app's own copy, so it keeps working when the original moves. */
data class Sound(val file: String, val name: String, val volume: Int = 100)

data class Settings(
    val volume: Int = 100,          // master volume, percent
    val overlap: Boolean = false,   // let clips play over each other instead of stopping the last
    val columns: Int = 3,
)

/** The sound list and settings, stored as JSON in the app's files folder (like ~/.config/snakepad/). */
class Library(private val context: Context) {
    val soundsDir = File(context.filesDir, "sounds").apply { mkdirs() }
    private val file = File(context.filesDir, "library.json")

    fun load(): Pair<List<Sound>, Settings> {
        val data = runCatching { JSONObject(file.readText()) }.getOrNull() ?: return emptyList<Sound>() to Settings()
        val sounds = data.optJSONArray("sounds")?.let { arr ->
            (0 until arr.length()).map { arr.getJSONObject(it) }.map {
                Sound(it.getString("file"), it.optString("name"), it.optInt("volume", 100))
            }
        }.orEmpty()
        val s = data.optJSONObject("settings") ?: JSONObject()
        return sounds to Settings(s.optInt("volume", 100), s.optBoolean("overlap", false), s.optInt("columns", 3))
    }

    fun save(sounds: List<Sound>, settings: Settings) {
        val arr = JSONArray()
        sounds.forEach { arr.put(JSONObject().put("file", it.file).put("name", it.name).put("volume", it.volume)) }
        val data = JSONObject().put("sounds", arr).put(
            "settings",
            JSONObject().put("volume", settings.volume).put("overlap", settings.overlap).put("columns", settings.columns),
        )
        val tmp = File(file.path + ".tmp")
        tmp.writeText(data.toString(2))
        tmp.renameTo(file)
    }

    fun path(sound: Sound): File = File(soundsDir, sound.file)

    companion object {
        val AUDIO_EXTS = setOf(
            "mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "wma",
            "aiff", "aif", "webm", "mka", "mp4", "mkv", "amr", "3gp",
        )
    }
}
