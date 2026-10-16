package com.snake.suite.hub

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** An APK in the release, as index.json lists it under packages.android. */
data class Apk(val url: String, val size: Long, val sha256: String, val version: String)

/**
 * The release index the desktop hub also reads. Each tool's "packages" map gets
 * Android entries next to "linux-x86_64" and the rest, and "hub" gets them for
 * the hub itself. "android" is one APK for every phone; tools with big
 * native parts (ffmpeg) have one per ABI instead, "android-arm64-v8a" and so on:
 *
 *   "tools": { "daw": { "version": "1.0.0", "packages": { "android": {
 *       "file": "snakes-daw-android.apk", "size": 123, "sha256": "...", "version": "1.0.0" } } } }
 *   "hub": { "android": { ... } }, "hub_version": "1.1.2"
 *
 * The seven Studio apps all point at one APK, snakes-studio-android.apk.
 */
data class Index(val tools: Map<String, Apk>, val hub: Apk?) {
    companion object {
        const val PLATFORM = "android"

        /** This phone's package keys, best first: its own ABIs, then the universal APK. */
        val keys: List<String> = android.os.Build.SUPPORTED_ABIS.map { "$PLATFORM-$it" } + PLATFORM

        private fun pick(packages: JSONObject?): JSONObject? = packages?.let { p -> keys.firstNotNullOfOrNull { p.optJSONObject(it) } }

        /**
         * Download and read the index. With [pubkey] (suite.json's release.index_pubkey) the
         * list must carry the matching signature (index.json.sig), or nothing is used from it.
         */
        fun fetch(indexUrl: String, pubkey: String): Index {
            val base = indexUrl.substringBeforeLast('/')
            val raw = try {
                download(indexUrl)
            } catch (e: IOException) {
                throw IOException("Offline: ${e.message ?: e.javaClass.simpleName}")
            }
            if (pubkey.isNotEmpty()) {
                val sig = runCatching { String(download("$indexUrl.sig"), Charsets.US_ASCII) }.getOrNull()
                if (sig == null || !Signing.verifyBase64(pubkey, raw, sig)) {
                    error("The download list's signature did not match, so nothing is downloaded from it")
                }
            }
            val json = JSONObject(String(raw, Charsets.UTF_8))
            fun apk(pkg: JSONObject?, fallbackVersion: String): Apk? = pkg?.let {
                Apk("$base/${it.getString("file")}", it.optLong("size", -1), it.optString("sha256"),
                    it.optString("version", fallbackVersion))
            }
            val tools = buildMap {
                val t = json.optJSONObject("tools") ?: JSONObject()
                t.keys().forEach { id ->
                    val entry = t.getJSONObject(id)
                    apk(pick(entry.optJSONObject("packages")), entry.optString("version", "0"))
                        ?.let { put(id, it) }
                }
            }
            val hubVersion = json.optString("hub_version", json.optString("version", "0"))
            return Index(tools, apk(pick(json.optJSONObject("hub")), hubVersion))
        }

        private fun download(url: String): ByteArray {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("Cache-Control", "no-cache")
            try {
                if (conn.responseCode !in 200..299) error("HTTP ${conn.responseCode} for $url")
                return conn.inputStream.use { it.readBytes() }
            } finally {
                conn.disconnect()
            }
        }
    }
}

/** "1.10.2" > "1.9.9": compare dotted versions number by number. */
fun newer(offered: String, installed: String?): Boolean {
    if (installed == null) return false
    val a = offered.split('.', '-').map { it.toIntOrNull() ?: 0 }
    val b = installed.split('.', '-').map { it.toIntOrNull() ?: 0 }
    for (i in 0 until maxOf(a.size, b.size)) {
        val x = a.getOrElse(i) { 0 }
        val y = b.getOrElse(i) { 0 }
        if (x != y) return x > y
    }
    return false
}
