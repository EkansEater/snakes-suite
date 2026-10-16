package com.snake.suite.compressor

/** The Rust engine (native/compressor). File descriptors passed in are owned and closed by it. */
object NativeSnake {
    init { System.loadLibrary("snake_android") }

    const val KIND_FILE = 1
    const val KIND_DIR = 2
    const val KIND_SYMLINK = 3

    @JvmStatic external fun packBegin(fd: Int, level: Int, threads: Int): Long
    @JvmStatic external fun packDir(handle: Long, name: String, mode: Int, mtime: Long)
    @JvmStatic external fun packFile(handle: Long, name: String, mode: Int, mtime: Long, fd: Int)
    @JvmStatic external fun packEnd(handle: Long): Long
    @JvmStatic external fun packAbort(handle: Long)

    @JvmStatic external fun unpackBegin(fd: Int): Long
    /** "kind\tmode\tmtime\tname[\ttarget]", or null after the last entry. */
    @JvmStatic external fun unpackNext(handle: Long): String?
    /** Stream the current file into fd (-1 to only verify it); returns its size. */
    @JvmStatic external fun unpackFile(handle: Long, fd: Int): Long
    @JvmStatic external fun unpackEnd(handle: Long, verify: Boolean)

    @JvmStatic external fun progress(): Long
    @JvmStatic external fun cancel()
}
