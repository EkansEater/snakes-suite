package com.snake.suite.terminal

import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** native/pty: openpty + fork + exec, what node-pty is on the desktop. */
object NativePty {
    init { System.loadLibrary("snakepty") }

    @JvmStatic external fun spawn(argv: Array<String>, env: Array<String>, cwd: String, cols: Int, rows: Int): IntArray
    @JvmStatic external fun resize(fd: Int, cols: Int, rows: Int)
    @JvmStatic external fun waitFor(pid: Int): Int
    @JvmStatic external fun hangup(pid: Int)
}

/** Programs on real ptys: Android's own shell, and snakessh for connections. */
class Terminals(private val emit: (String, List<Any?>) -> Unit, private val onCount: (Int) -> Unit = {}) {
    private class Term(val pid: Int, val fd: ParcelFileDescriptor, val out: FileOutputStream, val name: String)

    private val terms = ConcurrentHashMap<Int, Term>()
    private val counter = AtomicInteger()

    fun create(argv: List<String>, cwd: String, cols: Int, rows: Int, env: Map<String, String>): Map<String, Any> {
        require(argv.isNotEmpty()) { "nothing to run" }
        val dir = cwd.takeIf { File(it).isDirectory } ?: env["HOME"] ?: "/"
        val (fdInt, pid) = NativePty.spawn(argv.toTypedArray(), env.map { "${it.key}=${it.value}" }.toTypedArray(), dir, cols, rows)
            .let { it[0] to it[1] }
        val pfd = ParcelFileDescriptor.adoptFd(fdInt)
        val id = counter.incrementAndGet()
        val name = File(argv[0]).name.removePrefix("lib").removeSuffix(".so")
        terms[id] = Term(pid, pfd, FileOutputStream(pfd.fileDescriptor), name)
        onCount(terms.size)
        thread(name = "pty-$id", isDaemon = true) {
            // Decode UTF-8 across reads so a character split between two never breaks.
            val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPLACE)
                .onUnmappableCharacter(CodingErrorAction.REPLACE)
            val input = FileInputStream(pfd.fileDescriptor)
            val bytes = ByteBuffer.allocate(32768)
            val chars = CharBuffer.allocate(32768)
            try {
                while (true) {
                    val n = input.read(bytes.array(), bytes.position(), bytes.remaining())
                    if (n <= 0) break
                    bytes.position(bytes.position() + n)
                    bytes.flip()
                    decoder.decode(bytes, chars, false)
                    bytes.compact()
                    chars.flip()
                    if (chars.hasRemaining()) emit("pty:data", listOf(id, chars.toString()))
                    chars.clear()
                }
            } catch (_: Exception) {
                // EIO when the program ends: the normal end of a pty.
            }
            val code = NativePty.waitFor(pid)
            terms.remove(id)
            onCount(terms.size)
            runCatching { pfd.close() }
            emit("pty:exit", listOf(id, code, null))
        }
        return mapOf("id" to id, "pid" to pid, "file" to name)
    }

    fun write(id: Int, data: String) {
        val t = terms[id] ?: return
        runCatching { synchronized(t) { t.out.write(data.toByteArray()); t.out.flush() } }
    }

    fun resize(id: Int, cols: Int, rows: Int) {
        terms[id]?.let { NativePty.resize(it.fd.fd, cols.coerceAtLeast(2), rows.coerceAtLeast(1)) }
    }

    fun kill(id: Int) {
        terms[id]?.let { NativePty.hangup(it.pid) }
    }

    fun cwd(id: Int): String? = terms[id]?.let { runCatching { File("/proc/${it.pid}/cwd").canonicalPath }.getOrNull() }

    /** The program in the foreground of the terminal (its process group leader). */
    fun process(id: Int): String? {
        val t = terms[id] ?: return null
        val stat = runCatching { File("/proc/${t.pid}/stat").readText() }.getOrNull() ?: return t.name
        val fields = stat.substringAfterLast(") ").split(' ')
        val fg = fields.getOrNull(5)?.toIntOrNull() ?: return t.name // tpgid
        val comm = runCatching { File("/proc/$fg/comm").readText().trim() }.getOrNull()
        return (comm ?: t.name).removePrefix("lib").removeSuffix(".so")
    }

    fun killAll() = terms.keys.toList().forEach(::kill)
}
