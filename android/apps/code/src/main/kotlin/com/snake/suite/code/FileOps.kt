package com.snake.suite.code

import java.io.File
import java.nio.file.FileSystems
import java.nio.file.Paths
import java.util.regex.Pattern

/** The file system half of src/main/main.js, on java.io.File with real paths. */
object FileOps {
    val IGNORED_DIRS = setOf(".git", "node_modules", ".hg", ".svn", "__pycache__", ".DS_Store", "dist", "build", "target",
        ".next", ".cache", ".venv", "venv")

    fun readDir(dir: String): List<Map<String, Any>> {
        val f = File(dir)
        val entries = f.listFiles() ?: throw java.io.IOException("Cannot read $dir")
        return entries.map { e ->
            val link = runCatching { java.nio.file.Files.isSymbolicLink(e.toPath()) }.getOrDefault(false)
            mapOf("name" to e.name, "path" to e.path, "isDir" to e.isDirectory, "isSymlink" to link)
        }
    }

    private fun isBinary(buf: ByteArray): Boolean {
        val n = minOf(buf.size, 8000)
        for (i in 0 until n) if (buf[i] == 0.toByte()) return true
        return false
    }

    fun readFile(path: String, force: Boolean): Map<String, Any> {
        val f = File(path)
        if (f.isDirectory) throw java.io.IOException("Is a directory")
        if (!f.exists()) throw java.io.FileNotFoundException("ENOENT: no such file or directory, open '$path'")
        val size = f.length()
        if (size > 64L * 1024 * 1024 && !force) return mapOf("tooLarge" to true, "size" to size)
        val buf = f.readBytes()
        if (!force && isBinary(buf)) return mapOf("binary" to true, "size" to size)
        var text = String(buf, Charsets.UTF_8)
        var bom = false
        if (text.startsWith("\uFEFF")) { text = text.substring(1); bom = true }
        return mapOf("content" to text, "size" to size, "mtime" to f.lastModified().toDouble(), "bom" to bom)
    }

    fun writeFile(path: String, content: String, bom: Boolean): Map<String, Any> {
        val f = File(path)
        f.parentFile?.mkdirs()
        f.writeText((if (bom) "\uFEFF" else "") + content)
        return mapOf("mtime" to f.lastModified().toDouble())
    }

    fun stat(path: String): Map<String, Any> {
        val f = File(path)
        if (!f.exists()) return mapOf("exists" to false)
        return mapOf("exists" to true, "isDir" to f.isDirectory, "size" to f.length(), "mtime" to f.lastModified().toDouble(),
            "ctime" to f.lastModified().toDouble())
    }

    fun createFile(path: String) {
        val f = File(path)
        f.parentFile?.mkdirs()
        if (!f.createNewFile()) throw java.io.IOException("EEXIST: file already exists, open '$path'")
    }

    fun rename(from: String, to: String) {
        val a = File(from)
        val b = File(to)
        b.parentFile?.mkdirs()
        if (!a.renameTo(b)) {
            // Across file systems: copy, then delete.
            a.copyRecursively(b, overwrite = false)
            a.deleteRecursively()
        }
    }

    fun copy(from: String, to: String) {
        if (File(to).exists()) throw java.io.IOException("EEXIST: file already exists, cp '$from' -> '$to'")
        File(from).copyRecursively(File(to), overwrite = false)
    }

    /** Android has no trash for files: deleted things go into Snake's Code's own, to be restored by hand. */
    fun trash(path: String, trashDir: File) {
        val f = File(path)
        trashDir.mkdirs()
        val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.ROOT).format(java.util.Date())
        var target = File(trashDir, "${f.name} ($stamp)")
        var n = 2
        while (target.exists()) target = File(trashDir, "${f.name} ($stamp-${n++})")
        rename(path, target.path)
    }

    fun delete(path: String) {
        File(path).deleteRecursively()
    }

    fun listFiles(root: String, excludes: List<String>): List<String> {
        val out = ArrayList<String>()
        val matchers = excludes.map(::globMatcher)
        fun walk(dir: File, rel: String) {
            if (out.size > 100_000) return
            val entries = dir.listFiles() ?: return
            for (e in entries) {
                if (e.name in IGNORED_DIRS) continue
                val r = if (rel.isEmpty()) e.name else "$rel/${e.name}"
                if (matchers.any { it(r) }) continue
                if (e.isDirectory) walk(e, r) else out += r
            }
        }
        walk(File(root), "")
        return out
    }

    // A VS Code style glob: "*.js" or "dist" match a name anywhere; a glob with a slash matches from the root.
    fun globMatcher(glob: String): (String) -> Boolean {
        val g = glob.trim().removePrefix("./")
        if (g.isEmpty()) return { false }
        val pattern = if ('/' in g) g else "**/$g"
        val full = FileSystems.getDefault().getPathMatcher("glob:$pattern")
        val inside = FileSystems.getDefault().getPathMatcher("glob:$pattern/**")
        val top = if ('/' in g) null else FileSystems.getDefault().getPathMatcher("glob:$g")
        return { rel ->
            val p = Paths.get(rel)
            full.matches(p) || inside.matches(p) || (top?.matches(p) ?: false) || (top != null && rel.split('/').any { part -> top.matches(Paths.get(part)) })
        }
    }

    @Volatile private var searchToken = 0

    fun cancelSearch() { searchToken++ }

    /** Search in files: the pure-JS fallback of main.js (the desktop prefers ripgrep), ported. */
    fun search(q: Map<String, Any?>): Map<String, Any?> {
        val token = ++searchToken
        val root = q["root"] as String
        val maxResults = (q["maxResults"] as? Number)?.toInt() ?: 20000
        val matchCase = q["matchCase"] == true
        val wholeWord = q["wholeWord"] == true
        val isRegex = q["isRegex"] == true
        val query = q["query"] as? String ?: ""
        val includes = (q["include"] as? String).orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }.map(::globMatcher)
        val excludes = (q["exclude"] as? String).orEmpty().split(',').map { it.trim() }.filter { it.isNotEmpty() }.map(::globMatcher)
        val pattern = try {
            var src = if (isRegex) query else Pattern.quote(query)
            if (wholeWord) src = "\\b(?:$src)\\b"
            Pattern.compile(src, if (matchCase) 0 else Pattern.CASE_INSENSITIVE or Pattern.UNICODE_CASE)
        } catch (e: Exception) {
            return mapOf("files" to emptyList<Any>(), "count" to 0, "error" to (e.message ?: "Invalid pattern"))
        }
        val files = ArrayList<Map<String, Any>>()
        var count = 0
        fun walk(dir: File, rel: String) {
            if (count >= maxResults || token != searchToken) return
            val entries = dir.listFiles()?.sortedBy { it.name } ?: return
            for (e in entries) {
                val r = if (rel.isEmpty()) e.name else "$rel/${e.name}"
                if (e.isDirectory) {
                    if (e.name !in IGNORED_DIRS && excludes.none { it(r) }) walk(e, r)
                    continue
                }
                if (excludes.any { it(r) } || (includes.isNotEmpty() && includes.none { it(r) })) continue
                if (e.length() > 4L * 1024 * 1024) continue
                val buf = runCatching { e.readBytes() }.getOrNull() ?: continue
                if (isBinary(buf)) continue
                val matches = ArrayList<Map<String, Any>>()
                String(buf, Charsets.UTF_8).split(Regex("\r?\n")).forEachIndexed { i, text ->
                    if (count >= maxResults) return@forEachIndexed
                    val m = pattern.matcher(text)
                    while (m.find()) {
                        matches += mapOf("line" to i + 1, "start" to m.start(), "end" to m.end(), "text" to text)
                        if (++count >= maxResults) break
                        if (m.end() == m.start() && m.end() >= text.length) break
                    }
                }
                if (matches.isNotEmpty()) files += mapOf("path" to e.path, "rel" to r, "matches" to matches)
                if (count >= maxResults) return
            }
        }
        walk(File(root), "")
        return mapOf("files" to files, "count" to count, "limitHit" to (count >= maxResults))
    }

    /** Run a program and capture its output (task discovery and the like). */
    fun exec(cmd: String, args: List<String>, cwd: String?): Map<String, Any> = try {
        val p = ProcessBuilder(listOf(cmd) + args).apply { cwd?.let { directory(File(it)) } }.start()
        val out = p.inputStream.bufferedReader().readText()
        val err = p.errorStream.bufferedReader().readText()
        mapOf("code" to p.waitFor(), "stdout" to out, "stderr" to err)
    } catch (e: Exception) {
        mapOf("code" to 127, "stdout" to "", "stderr" to (e.message ?: "cannot run $cmd"))
    }
}
