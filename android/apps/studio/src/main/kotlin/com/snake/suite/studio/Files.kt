package com.snake.suite.studio

import android.content.Context
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * The files the person picked, as the page knows them: { id, name, ext, size, mtime, writable }.
 * The page reads one at /file/<id>/<name> ([serve], which also answers byte ranges so
 * video can seek) and writes it in pieces ([beginWrite]). Nothing else on the phone is
 * reachable: an id exists only for a file the person chose, or opened this app with.
 */
class Files(private val context: Context) {
    private data class Picked(val uri: Uri, val name: String, val mime: String?)
    private data class Writing(val fileId: String, val temp: File)

    private val open = ConcurrentHashMap<String, Picked>()
    private val writes = ConcurrentHashMap<String, Writing>()
    private val seq = AtomicInteger()
    private val resolver get() = context.contentResolver
    private val prefs = context.getSharedPreferences("studio-files", Context.MODE_PRIVATE)

    // ------------------------------------------------------------------ describing

    private fun <T> query(uri: Uri, vararg cols: String, read: (Cursor) -> T): T? = runCatching {
        resolver.query(uri, cols, null, null, null)?.use { c -> if (c.moveToFirst()) read(c) else null }
    }.getOrNull()

    private fun nameOf(uri: Uri): String =
        query(uri, OpenableColumns.DISPLAY_NAME) { it.getString(0) } ?: uri.lastPathSegment?.substringAfterLast('/') ?: "file"

    /** Make [uri] known to the page; returns its description. */
    fun register(uri: Uri, nameHint: String? = null): JSONObject {
        val name = nameHint ?: nameOf(uri)
        val id = "a${seq.incrementAndGet()}"
        open[id] = Picked(uri, name, resolver.getType(uri))
        return describe(id)
    }

    fun describe(id: String): JSONObject {
        val p = open[id] ?: error("That file is not open.")
        val size = query(p.uri, OpenableColumns.SIZE) { if (it.isNull(0)) -1L else it.getLong(0) } ?: -1L
        val mtime = query(p.uri, DocumentsContract.Document.COLUMN_LAST_MODIFIED) { if (it.isNull(0)) 0L else it.getLong(0) } ?: 0L
        val flags = query(p.uri, DocumentsContract.Document.COLUMN_FLAGS) { it.getInt(0) } ?: 0
        val writable = flags and DocumentsContract.Document.FLAG_SUPPORTS_WRITE != 0 ||
            context.checkUriPermission(p.uri, android.os.Process.myPid(), android.os.Process.myUid(),
                Intent.FLAG_GRANT_WRITE_URI_PERMISSION) == android.content.pm.PackageManager.PERMISSION_GRANTED
        return JSONObject()
            .put("id", id).put("name", p.name).put("ext", p.name.substringAfterLast('.', "").lowercase())
            .put("size", size).put("mtime", mtime).put("writable", writable)
    }

    // ------------------------------------------------------------------ reading

    /** A response for /file/<id>/...: the whole file, or the byte range a video asks for. */
    fun serve(id: String, range: String?): WebResourceResponse {
        val p = open[id] ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        val mime = p.mime ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(p.name.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"
        val afd = runCatching { resolver.openAssetFileDescriptor(p.uri, "r") }.getOrNull()
            ?: return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
        val total = afd.length.takeIf { it >= 0 } ?: (query(p.uri, OpenableColumns.SIZE) { it.getLong(0) } ?: -1L)
        val headers = mutableMapOf("Accept-Ranges" to "bytes", "Cache-Control" to "no-store")
        val m = range?.let { Regex("""bytes=(\d*)-(\d*)""").find(it) }
        if (m != null && total > 0) {
            val (a, b) = m.destructured
            val start = if (a.isEmpty()) maxOf(0, total - (b.toLongOrNull() ?: 0)) else a.toLong()
            val end = if (a.isEmpty() || b.isEmpty()) total - 1 else minOf(b.toLong(), total - 1)
            if (start >= total || end < start) {
                afd.close()
                return WebResourceResponse(mime, null, 416, "Range Not Satisfiable", mapOf("Content-Range" to "bytes */$total"), null)
            }
            val input = afd.createInputStream()
            input.channel.position(afd.startOffset + start)
            headers["Content-Range"] = "bytes $start-$end/$total"
            headers["Content-Length"] = (end - start + 1).toString()
            return WebResourceResponse(mime, null, 206, "Partial Content", headers, Limited(input, end - start + 1))
        }
        if (total >= 0) headers["Content-Length"] = total.toString()
        return WebResourceResponse(mime, null, 200, "OK", headers, afd.createInputStream())
    }

    private class Limited(input: FileInputStream, private var left: Long) : FilterInputStream(input) {
        override fun read(): Int = if (left <= 0) -1 else super.read().also { if (it >= 0) left-- }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            val n = super.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) left -= n
            return n
        }
        override fun available(): Int = minOf(super.available().toLong(), left).toInt()
    }

    // ------------------------------------------------------------------ writing

    /** Writing goes to a temporary file first, so a failure halfway leaves the original alone. */
    fun beginWrite(fileId: String): String? {
        if (!open.containsKey(fileId)) return null
        val dir = File(context.cacheDir, "saving").apply { mkdirs() }
        val token = "w${seq.incrementAndGet()}"
        writes[token] = Writing(fileId, File.createTempFile("save", ".part", dir))
        return token
    }

    fun writeChunk(token: String, bytes: ByteArray): Boolean {
        val w = writes[token] ?: return false
        return runCatching { w.temp.appendBytes(bytes) }.isSuccess
    }

    fun endWrite(token: String, keep: Boolean): JSONObject {
        val w = writes.remove(token) ?: return JSONObject().put("error", "Nothing is being saved.")
        try {
            if (!keep) return JSONObject().put("cancelled", true)
            val p = open[w.fileId] ?: return JSONObject().put("error", "That file is not open.")
            // "wt" empties the file first; a few providers only know "w".
            val out = runCatching { resolver.openOutputStream(p.uri, "wt") }.getOrNull() ?: resolver.openOutputStream(p.uri, "w")
                ?: return JSONObject().put("error", "“${p.name}” cannot be written.")
            out.use { o -> w.temp.inputStream().use { it.copyTo(o, 1 shl 16) } }
            val d = describe(w.fileId)
            return JSONObject().put("size", if (d.getLong("size") >= 0) d.getLong("size") else w.temp.length())
                .put("mtime", if (d.getLong("mtime") > 0) d.getLong("mtime") else System.currentTimeMillis())
        } catch (e: Exception) {
            return JSONObject().put("error", e.message ?: "Saving failed.")
        } finally {
            w.temp.delete()
        }
    }

    // ------------------------------------------------------------------ recent files

    /** Keep access to [uri] after a restart (when the picker allows it) and list it as recent. */
    fun remember(uri: Uri, name: String, app: String) {
        val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        runCatching { resolver.takePersistableUriPermission(uri, flags) }
            .onFailure { runCatching { resolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
        val list = recentList(app)
        val out = JSONArray().put(JSONObject().put("uri", uri.toString()).put("name", name).put("time", System.currentTimeMillis()))
        for (i in 0 until list.length()) {
            val r = list.getJSONObject(i)
            if (r.getString("uri") != uri.toString() && out.length() < 20) out.put(r)
        }
        prefs.edit().putString("recent-$app", out.toString()).apply()
    }

    private fun recentList(app: String) = runCatching { JSONArray(prefs.getString("recent-$app", "[]")) }.getOrElse { JSONArray() }

    private fun stillThere(uri: Uri) = runCatching { resolver.openAssetFileDescriptor(uri, "r")?.close() != null }.getOrDefault(false)

    fun recent(app: String): JSONArray {
        val list = recentList(app)
        val out = JSONArray()
        for (i in 0 until list.length()) {
            val r = list.getJSONObject(i)
            out.put(JSONObject().put("key", i.toString()).put("name", r.getString("name")).put("dir", "")
                .put("time", r.getLong("time")).put("exists", stillThere(Uri.parse(r.getString("uri")))))
        }
        return out
    }

    fun openRecent(app: String, key: String): JSONObject {
        val r = recentList(app).optJSONObject(key.toInt()) ?: error("That file is no longer listed.")
        val uri = Uri.parse(r.getString("uri"))
        if (!stillThere(uri)) error("“${r.getString("name")}” is no longer there.")
        remember(uri, r.getString("name"), app)
        return register(uri, r.getString("name"))
    }

    fun forgetRecent(app: String, key: String?): JSONArray {
        val list = recentList(app)
        val out = JSONArray()
        if (key != null) for (i in 0 until list.length()) if (i.toString() != key) out.put(list.get(i))
        if (key == null || out.length() < list.length()) {
            // Give back the access the person no longer needs.
            for (i in 0 until list.length()) {
                val r = list.getJSONObject(i)
                if (key == null || i.toString() == key) runCatching {
                    resolver.releasePersistableUriPermission(Uri.parse(r.getString("uri")),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                }
            }
        }
        prefs.edit().putString("recent-$app", out.toString()).apply()
        return recent(app)
    }

    // ------------------------------------------------------------------ folders

    /** The files in a folder the person picked (and its subfolders), at most [max]. */
    fun listTree(tree: Uri, exts: Set<String>, max: Int = 2000): List<Pair<Uri, String>> {
        val out = mutableListOf<Pair<Uri, String>>()
        val todo = ArrayDeque(listOf(DocumentsContract.getTreeDocumentId(tree)))
        while (todo.isNotEmpty() && out.size < max) {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, todo.removeFirst())
            runCatching {
                resolver.query(children, arrayOf(DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME, DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)
            }.getOrNull()?.use { c ->
                while (c.moveToNext() && out.size < max) {
                    val docId = c.getString(0)
                    val name = c.getString(1) ?: continue
                    if (c.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR) todo.add(docId)
                    else if (exts.isEmpty() || name.substringAfterLast('.', "").lowercase() in exts) {
                        out += DocumentsContract.buildDocumentUriUsingTree(tree, docId) to name
                    }
                }
            }
        }
        return out.sortedBy { it.second.lowercase() }
    }

    fun closeAll() {
        for (w in writes.values) w.temp.delete()
        writes.clear()
    }
}
