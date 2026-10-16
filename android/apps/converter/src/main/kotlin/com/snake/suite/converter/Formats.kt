package com.snake.suite.converter

import java.io.File

enum class Category(val label: String) {
    Audio("Audio"), Video("Video"), Image("Image"), Document("Document"), Spreadsheet("Spreadsheet"), Pdf("PDF")
}

class ConversionError(message: String) : Exception(message)

/** Conversion settings, the same choices as the desktop app's options. */
data class Options(
    val audioBitrate: String = "192k",
    val videoQuality: String = "balanced",   // high | balanced | small
    val imageQuality: Int = 90,              // JPEG / WebP
    val pdfDpi: Int = 150,                   // PDF pages rendered to images
)

/** The file formats, as in snakes_converter/converters (presentations need LibreOffice, so not here). */
object Formats {
    val AUDIO_IN = setOf("mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "wma", "aiff", "aif",
        "ac3", "amr", "mka", "mp2", "ape", "wv", "caf", "au", "3gpp")
    val VIDEO_IN = setOf("mp4", "mkv", "webm", "mov", "avi", "flv", "wmv", "m4v", "mpg", "mpeg", "ts",
        "m2ts", "3gp", "ogv", "vob")
    val AUDIO_OUT = listOf("wav", "mp3", "flac", "ogg", "opus", "m4a", "aac", "aiff", "wma")
    val VIDEO_OUT = listOf("mp4", "mkv", "webm", "mov", "avi", "gif")
    val IMAGE_IN = setOf("png", "jpg", "jpeg", "jfif", "webp", "bmp", "gif", "heic", "heif", "avif", "ico",
        "tif", "tiff", "tga", "ppm", "pgm", "dng")
    val IMAGE_OUT = listOf("png", "jpg", "webp", "pdf", "gif", "bmp", "tiff", "ico")
    val DOCUMENT_IN = setOf("docx", "txt", "md", "markdown", "html", "htm", "rtf")
    val DOCUMENT_OUT = listOf("pdf", "docx", "txt", "html", "md")
    val SHEET_IN = setOf("xlsx", "xlsm", "csv", "tsv", "json")
    val SHEET_OUT = listOf("xlsx", "csv", "tsv", "json", "pdf")
    val PDF_OUT = listOf("png", "jpg", "txt", "docx")

    /** Different spellings of the same format. */
    private val SAME = mapOf("jpeg" to "jpg", "jfif" to "jpg", "tif" to "tiff", "aif" to "aiff", "oga" to "ogg",
        "markdown" to "md", "htm" to "html", "xlsm" to "xlsx", "heif" to "heic")

    fun normal(ext: String) = SAME[ext.lowercase()] ?: ext.lowercase()

    fun category(name: String): Category? {
        val ext = name.substringAfterLast('.', "").lowercase()
        return when {
            ext == "pdf" -> Category.Pdf
            ext in AUDIO_IN -> Category.Audio
            ext in VIDEO_IN -> Category.Video
            ext in IMAGE_IN -> Category.Image
            ext in DOCUMENT_IN -> Category.Document
            ext in SHEET_IN -> Category.Spreadsheet
            else -> null
        }
    }

    /** Formats this file can become, best default first. */
    fun targets(name: String): List<String> {
        val ext = normal(name.substringAfterLast('.', ""))
        val out = when (category(name)) {
            Category.Audio -> AUDIO_OUT
            Category.Video -> VIDEO_OUT + AUDIO_OUT
            Category.Image -> IMAGE_OUT
            Category.Document -> DOCUMENT_OUT
            Category.Spreadsheet -> SHEET_OUT
            Category.Pdf -> PDF_OUT
            null -> emptyList()
        }
        return out.filter { it != ext }
    }
}

/** Progress callback, 0..1. */
typealias Progress = (Float) -> Unit

/** A converter turns [src] into one or more files in [outDir], named after [stem]. */
interface Converter {
    suspend fun convert(src: File, outDir: File, stem: String, target: String, opts: Options, progress: Progress): List<File>
}
