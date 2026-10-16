package com.snake.suite.studio

// One activity per Studio app, so each has its own icon, task and place in Recents.
class WordActivity : StudioActivity("word")
class SheetsActivity : StudioActivity("sheets")
class SlidesActivity : StudioActivity("slides")
class PaintActivity : StudioActivity("paint")
class PhotoActivity : StudioActivity("photo")
class PlayerActivity : StudioActivity("player")
class MovieActivity : StudioActivity("movie")

/** The activity of each app id, for "open in another Studio app". */
val STUDIO_ACTIVITIES: Map<String, Class<out StudioActivity>> = mapOf(
    "word" to WordActivity::class.java,
    "sheets" to SheetsActivity::class.java,
    "slides" to SlidesActivity::class.java,
    "paint" to PaintActivity::class.java,
    "photo" to PhotoActivity::class.java,
    "player" to PlayerActivity::class.java,
    "movie" to MovieActivity::class.java,
)
