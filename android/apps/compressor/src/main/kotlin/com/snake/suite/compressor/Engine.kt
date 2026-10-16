package com.snake.suite.compressor

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile

/** Something to pack: a picked file, or a picked folder walked recursively. */
data class Input(val uri: Uri, val name: String, val isDir: Boolean, val size: Long)

data class Entry(val kind: Int, val name: String, val size: Long)

data class PackResult(val files: Int, val bytes: Long, val packed: Long)

data class UnpackResult(val entries: List<Entry>, val files: Int, val bytes: Long, val skipped: Int)

/**
 * Runs the Rust engine over content Uris. Kotlin walks folders and opens files;
 * Rust compresses, checksums and writes the .snake format.
 */
class Engine(private val context: Context) {
    private val resolver = context.contentResolver

    private fun fd(uri: Uri, mode: String): Int =
        (resolver.openFileDescriptor(uri, mode) ?: error("Cannot open $uri")).detachFd()

    /** Total bytes of the inputs, walking folders, for the progress bar. */
    fun measure(inputs: List<Input>): Long = inputs.sumOf { input ->
        if (input.isDir) DocumentFile.fromTreeUri(context, input.uri)?.let(::treeSize) ?: 0L else input.size.coerceAtLeast(0)
    }

    private fun treeSize(dir: DocumentFile): Long =
        dir.listFiles().sumOf { if (it.isDirectory) treeSize(it) else it.length() }

    fun pack(inputs: List<Input>, output: Uri, level: Int, onFile: (String) -> Unit): PackResult {
        val threads = Runtime.getRuntime().availableProcessors().coerceIn(1, 4)
        val h = NativeSnake.packBegin(fd(output, "wt"), level, threads)
        var files = 0
        var bytes = 0L
        try {
            fun file(doc: Uri, name: String, mtime: Long, size: Long) {
                onFile(name)
                NativeSnake.packFile(h, name, 0x1A4 /* 0644 */, mtime / 1000, fd(doc, "r"))
                files++
                bytes += size
            }
            fun walk(dir: DocumentFile, prefix: String) {
                NativeSnake.packDir(h, prefix, 0x1ED /* 0755 */, dir.lastModified() / 1000)
                dir.listFiles().sortedBy { it.name }.forEach { child ->
                    val name = "$prefix/${child.name}"
                    if (child.isDirectory) walk(child, name) else file(child.uri, name, child.lastModified(), child.length())
                }
            }
            for (input in inputs) {
                if (input.isDir) {
                    val tree = DocumentFile.fromTreeUri(context, input.uri) ?: continue
                    walk(tree, input.name)
                } else {
                    val doc = DocumentFile.fromSingleUri(context, input.uri)
                    file(input.uri, input.name, doc?.lastModified() ?: 0L, input.size)
                }
            }
            val packed = NativeSnake.packEnd(h)
            return PackResult(files, bytes, packed)
        } catch (e: Throwable) {
            NativeSnake.packAbort(h)
            runCatching { DocumentFile.fromSingleUri(context, output)?.delete() }
            throw e
        }
    }

    /**
     * Read an archive. With [dest] it extracts into that folder; without, it only
     * lists and verifies every checksum (Test).
     */
    fun unpack(archive: Uri, dest: Uri?, onFile: (String) -> Unit): UnpackResult {
        val h = NativeSnake.unpackBegin(fd(archive, "r"))
        val entries = mutableListOf<Entry>()
        var files = 0
        var bytes = 0L
        var skipped = 0
        val root = dest?.let { DocumentFile.fromTreeUri(context, it) ?: error("Cannot open the destination folder") }
        val dirs = HashMap<String, DocumentFile>()
        fun dirFor(path: String): DocumentFile {
            if (path.isEmpty()) return root!!
            dirs[path]?.let { return it }
            val parent = dirFor(path.substringBeforeLast('/', ""))
            val name = path.substringAfterLast('/')
            val dir = parent.findFile(name)?.takeIf { it.isDirectory }
                ?: parent.createDirectory(name) ?: error("Cannot create folder $path")
            dirs[path] = dir
            return dir
        }
        var ok = false
        try {
            while (true) {
                val line = NativeSnake.unpackNext(h) ?: break
                val parts = line.split('\t')
                val kind = parts[0].toInt()
                val name = parts[3]
                check(name.split('/').none { it.isEmpty() || it == "." || it == ".." }) { "Refusing unsafe path in archive: $name" }
                onFile(name)
                when (kind) {
                    NativeSnake.KIND_DIR -> {
                        if (root != null) dirFor(name)
                        entries += Entry(kind, name, 0)
                    }
                    NativeSnake.KIND_SYMLINK -> {
                        skipped++   // shared storage has no symlinks
                        entries += Entry(kind, "$name → ${parts.getOrElse(4) { "" }}", 0)
                    }
                    NativeSnake.KIND_FILE -> {
                        val out = if (root != null) {
                            val parent = dirFor(name.substringBeforeLast('/', ""))
                            val base = name.substringAfterLast('/')
                            parent.findFile(base)?.delete()
                            val doc = parent.createFile("application/octet-stream", base)
                                ?: error("Cannot create $name")
                            fd(doc.uri, "w")
                        } else -1
                        val size = NativeSnake.unpackFile(h, out)
                        entries += Entry(kind, name, size)
                        files++
                        bytes += size
                    }
                }
            }
            ok = true
        } finally {
            NativeSnake.unpackEnd(h, ok)
        }
        return UnpackResult(entries, files, bytes, skipped)
    }
}
