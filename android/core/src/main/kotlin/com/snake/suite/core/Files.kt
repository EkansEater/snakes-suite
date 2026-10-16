package com.snake.suite.core

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import java.io.File
import java.util.Locale

/** What the picker handed us: a content Uri plus its name and size. */
data class PickedFile(val uri: Uri, val name: String, val size: Long, val mime: String?) {
    val extension: String get() = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
    val baseName: String get() = name.substringBeforeLast('.')
}

fun Context.describe(uri: Uri): PickedFile {
    var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
    var size = -1L
    runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getString(0)?.let { name = it }
                if (!c.isNull(1)) size = c.getLong(1)
            }
        }
    }
    return PickedFile(uri, name, size, contentResolver.getType(uri))
}

/** Copy a picked file into the app cache so tools that need a real path (ffmpeg, Rust) can read it. */
fun Context.copyToCache(file: PickedFile, dir: String = "in"): File {
    val folder = File(cacheDir, dir).apply { mkdirs() }
    val out = uniqueFile(folder, file.name)
    contentResolver.openInputStream(file.uri)!!.use { input -> out.outputStream().use { input.copyTo(it, 1 shl 20) } }
    return out
}

fun uniqueFile(folder: File, name: String): File {
    var f = File(folder, name)
    val base = name.substringBeforeLast('.')
    val ext = name.substringAfterLast('.', "").let { if (it.isEmpty()) "" else ".$it" }
    var n = 2
    while (f.exists()) f = File(folder, "$base ($n)$ext").also { n++ }
    return f
}

fun mimeOf(name: String): String =
    MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase(Locale.ROOT))
        ?: "application/octet-stream"

/** Where a tool's output goes, in the shared storage everyone can see. */
enum class Collection(val dir: String) {
    Music(Environment.DIRECTORY_MUSIC),
    Movies(Environment.DIRECTORY_MOVIES),
    Pictures(Environment.DIRECTORY_PICTURES),
    Downloads(Environment.DIRECTORY_DOWNLOADS),
    Documents(Environment.DIRECTORY_DOCUMENTS),
}

private fun Collection.contentUri(): Uri = when (this) {
    Collection.Music -> MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    Collection.Movies -> MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    Collection.Pictures -> MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    Collection.Downloads, Collection.Documents -> MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
}

/** The collection a file of this type belongs in (an MP3 in Music, a GIF in Pictures...). */
fun collectionFor(name: String, fallback: Collection = Collection.Downloads): Collection {
    val mime = mimeOf(name)
    return when {
        mime.startsWith("audio/") -> Collection.Music
        mime.startsWith("video/") -> Collection.Movies
        mime.startsWith("image/") -> Collection.Pictures
        else -> fallback
    }
}

/**
 * Publish [source] into shared storage as <collection>/<folder>/<name> and delete it.
 * Returns the new content Uri. Documents go to Download/<folder> because the
 * Documents collection only takes some types.
 */
fun Context.publish(source: File, name: String, folder: String, collection: Collection = collectionFor(name)): Uri {
    val dir = if (collection == Collection.Documents) Collection.Downloads.dir else collection.dir
    val values = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, name)
        put(MediaStore.MediaColumns.MIME_TYPE, mimeOf(name))
        put(MediaStore.MediaColumns.RELATIVE_PATH, "$dir/$folder")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val resolver = contentResolver
    val uri = resolver.insert(collection.contentUri(), values) ?: error("Could not create $name in $dir/$folder")
    try {
        resolver.openOutputStream(uri)!!.use { out -> source.inputStream().use { it.copyTo(out, 1 shl 20) } }
        resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
    } catch (e: Throwable) {
        resolver.delete(uri, null, null)
        throw e
    }
    source.delete()
    return uri
}

/** Human readable path of where [publish] puts files, for messages. */
fun publishedPath(name: String, folder: String, collection: Collection = collectionFor(name)): String {
    val dir = if (collection == Collection.Documents) Collection.Downloads.dir else collection.dir
    return "$dir/$folder/$name"
}

fun Context.openFile(uri: Uri, mime: String? = null) {
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime ?: contentResolver.getType(uri))
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    runCatching { startActivity(Intent.createChooser(intent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

fun Context.shareFile(uri: Uri, mime: String? = null) {
    val intent = Intent(Intent.ACTION_SEND).setType(mime ?: contentResolver.getType(uri) ?: "*/*")
        .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    startActivity(Intent.createChooser(intent, null).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}

fun formatSize(bytes: Long): String {
    if (bytes < 0) return ""
    val units = arrayOf("B", "KB", "MB", "GB", "TB")
    var v = bytes.toDouble()
    var i = 0
    while (v >= 1024 && i < units.size - 1) { v /= 1024; i++ }
    return if (i == 0) "$bytes B" else String.format(Locale.ROOT, "%.1f %s", v, units[i])
}

fun formatDuration(ms: Long): String {
    val s = ms / 1000
    return if (s >= 3600) String.format(Locale.ROOT, "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
    else String.format(Locale.ROOT, "%d:%02d", s / 60, s % 60)
}
