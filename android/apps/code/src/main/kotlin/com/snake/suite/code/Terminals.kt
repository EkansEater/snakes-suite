package com.snake.suite.code

import android.content.Context
import android.os.ParcelFileDescriptor
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** native/pty: openpty + fork + exec, the node-pty of the desktop app. */
object NativePty {
    init { System.loadLibrary("snakepty") }

    @JvmStatic external fun spawn(argv: Array<String>, env: Array<String>, cwd: String, cols: Int, rows: Int): IntArray
    @JvmStatic external fun resize(fd: Int, cols: Int, rows: Int)
    @JvmStatic external fun waitFor(pid: Int): Int
    @JvmStatic external fun hangup(pid: Int)
}

/** The terminals of the integrated terminal panel: Android's own shell (toybox) on real ptys. */
class Terminals(private val context: Context, private val emit: (String, List<Any?>) -> Unit) {
    private class Term(val pid: Int, val fd: ParcelFileDescriptor, val out: FileOutputStream)

    private val terms = ConcurrentHashMap<Int, Term>()
    private val counter = AtomicInteger()

    val shell = "/system/bin/sh"

    fun create(cwd: String?, cols: Int, rows: Int, extraEnv: Map<String, String>, home: String): Map<String, Any> {
        val dir = cwd?.takeIf { File(it).isDirectory } ?: home
        val env = linkedMapOf(
            "TERM" to "xterm-256color",
            "COLORTERM" to "truecolor",
            "TERM_PROGRAM" to "snakes-code",
            "HOME" to home,
            "TMPDIR" to context.cacheDir.path,
            "LANG" to "en_US.UTF-8",
            "PATH" to (System.getenv("PATH") ?: "/system/bin:/system/xbin:/vendor/bin"),
            "ANDROID_DATA" to (System.getenv("ANDROID_DATA") ?: "/data"),
            "ANDROID_ROOT" to (System.getenv("ANDROID_ROOT") ?: "/system"),
            "EXTERNAL_STORAGE" to (System.getenv("EXTERNAL_STORAGE") ?: "/sdcard"),
            "PS1" to "\\w \$ ",
        )
        env.putAll(extraEnv)
        val (fdInt, pid) = NativePty.spawn(arrayOf(shell, "-i"), env.map { "${it.key}=${it.value}" }.toTypedArray(), dir, cols, rows)
            .let { it[0] to it[1] }
        val pfd = ParcelFileDescriptor.adoptFd(fdInt)
        val id = counter.incrementAndGet()
        val term = Term(pid, pfd, FileOutputStream(pfd.fileDescriptor))
        terms[id] = term
        thread(name = "pty-$id", isDaemon = true) {
            // Decode UTF-8 across read boundaries so multi-byte characters never split.
            val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPLACE)
                .onUnmappableCharacter(CodingErrorAction.REPLACE)
            val input = java.io.FileInputStream(pfd.fileDescriptor)
            val bytes = ByteBuffer.allocate(16384)
            val chars = CharBuffer.allocate(16384)
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
                // EIO when the shell exits: the normal end of a pty.
            }
            val code = NativePty.waitFor(pid)
            terms.remove(id)
            runCatching { pfd.close() }
            emit("pty:exit", listOf(id, code))
        }
        return mapOf("id" to id, "pid" to pid, "shell" to "sh")
    }

    fun write(id: Int, data: String) {
        val t = terms[id] ?: return
        runCatching { synchronized(t) { t.out.write(data.toByteArray()); t.out.flush() } }
    }

    fun resize(id: Int, cols: Int, rows: Int) {
        terms[id]?.let { NativePty.resize(it.fd.fd, cols.coerceAtLeast(1), rows.coerceAtLeast(1)) }
    }

    fun kill(id: Int) {
        terms[id]?.let { NativePty.hangup(it.pid) }
    }

    fun cwd(id: Int): String? = terms[id]?.let { runCatching { File("/proc/${it.pid}/cwd").canonicalPath }.getOrNull() }

    fun killAll() = terms.keys.toList().forEach(::kill)
}
