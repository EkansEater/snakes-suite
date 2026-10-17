package com.snake.suite.core

import androidx.annotation.DrawableRes

/**
 * Every tool of the suite, as suite.json lists them. [android] is false for the
 * tools that only exist on the desktop; the hub shows those as "Desktop only".
 * Tools with a [shared] APK live in one app together (the seven Studio apps are
 * "studio"), each with its own launcher [activity].
 */
data class Tool(
    val id: String,
    val name: String,
    val tagline: String,
    val description: String,
    @DrawableRes val icon: Int,
    val android: Boolean = true,
    val shared: String? = null,
    val activity: String? = null,
) {
    /** Application id of the tool's APK. The hub is com.snake.suite itself. */
    val packageName: String get() = if (id == HUB_ID) "com.snake.suite" else "com.snake.suite.${shared ?: id}"

    /** File name of the tool's APK in a release. */
    val apkFile: String get() = "snakes-${shared ?: id}-android.apk"

    companion object {
        const val HUB_ID = "suite"
    }
}

object Tools {
    val hub = Tool("suite", "Snake's Master Suite", "Every Snake app in one place",
        "Opens, installs and updates every Snake app.", R.drawable.tile_suite)

    private fun studio(id: String, name: String, tagline: String, description: String, icon: Int, activity: String) =
        Tool(id, name, tagline, description, icon, shared = "studio", activity = activity)

    val all: List<Tool> = listOf(
        studio("word", "Snake's Word", "Documents", "Letters, reports and notes; opens and saves Word files.", R.drawable.tile_word, "WordActivity"),
        studio("sheets", "Snake's Spreadsheets", "Numbers and formulas", "Tables, formulas and charts; opens and saves Excel files.", R.drawable.tile_sheets, "SheetsActivity"),
        studio("slides", "Snake's Slides", "Presentations", "Slides with themes, pictures and transitions; PowerPoint files too.", R.drawable.tile_slides, "SlidesActivity"),
        studio("paint", "Snake's Paint", "Quick drawings", "Draw, crop and mark up pictures.", R.drawable.tile_paint, "PaintActivity"),
        studio("photo", "Snake's Photo", "Photo editor", "Layers, selections, adjustments and filters; PSD files too.", R.drawable.tile_photo, "PhotoActivity"),
        studio("player", "Snake's Player", "Video and music", "Plays videos and music with subtitles, playlists and an equaliser.", R.drawable.tile_player, "PlayerActivity"),
        studio("movie", "Snake's Movie Maker", "Video editor", "Cut clips, add titles, music and transitions, export a video.", R.drawable.tile_movie, "MovieActivity"),
        Tool("code", "Snake's Code", "Code editor",
            "A code editor with Monaco, file tree, search and Markdown preview.", R.drawable.tile_code),
        Tool("terminal", "Snake's Terminal", "Terminal and SSH",
            "Tabs and splits, and SSH to your computers: it finds them on your network.", R.drawable.tile_terminal),
        Tool("compressor", "Snake's Compressor", "Lossless archiver",
            "Pack big files and folders into checksummed .snake archives.", R.drawable.tile_compressor),
        Tool("converter", "Snake's Converter", "File converter",
            "Audio, video, images, documents, spreadsheets and PDFs.", R.drawable.tile_converter),
        Tool("recompiler", "Snake's Recompiler", "N64 recompiler",
            "Turns your own N64 ROMs into programs that run natively.", R.drawable.tile_recompiler, android = false),
        Tool("soundpad", "Snake's SoundPad", "Soundboard",
            "A grid of sound clips, one tap to play.", R.drawable.tile_soundpad),
        Tool("mp3", "Snake's MP3 Converter", "Links to MP3",
            "Share a video link from 1000+ sites, get a tagged MP3.", R.drawable.tile_mp3),
        Tool("daw", "Snake's DAW", "Record and practise",
            "Amp, effects, loop station, tuner and multitrack recording.", R.drawable.tile_daw),
        Tool("screen", "Snake's Screen Recorder", "Screen and audio recorder",
            "Record the screen to MP4 or GIF, or audio to MP3.", R.drawable.tile_screen),
    )

    fun byId(id: String): Tool? = if (id == hub.id) hub else all.firstOrNull { it.id == id }
}
