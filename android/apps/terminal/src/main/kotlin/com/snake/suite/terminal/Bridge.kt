package com.snake.suite.terminal

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors

/**
 * The Electron main process of Snake's Terminal, for Android: answers every channel of
 * src/main/preload.js. The page calls SnakeNative.invoke/send (android-bridge.js); answers
 * and events go back through evaluateJavascript.
 */
class Bridge(private val activity: MainActivity, private val web: WebView) {
    private val main = Handler(Looper.getMainLooper())
    private val pool = Executors.newCachedThreadPool()
    private val terminals = Terminals({ ch, args -> emit(ch, args) }) { count -> KeepAlive.update(activity, count) }
    private val files: File = activity.filesDir
    private val sshHome = File(files, "ssh").apply { mkdirs() }
    private val home = File(files, "home").apply { mkdirs() }
    /** snakessh: the SSH client, shipped as a native "library" so Android lets it run. */
    val ssh: String = File(activity.applicationInfo.nativeLibraryDir, "libsnakessh.so").path
    private val devices = Devices(activity, sshHome, ssh) { ch, args -> emit(ch, args) }
    private val settingsFile = File(files, "settings.json")
    private val stateFile = File(files, "state.json")
    private var first = true

    // ------------------------------------------------------------------ plumbing

    @JavascriptInterface
    fun invoke(id: Int, channel: String, argsJson: String) {
        pool.execute {
            val args = toKotlin(JSONArray(argsJson)) as List<*>
            try {
                reply(id, true, json(handle(channel, args)))
            } catch (e: Throwable) {
                reply(id, false, JSONObject.quote(e.message ?: e.javaClass.simpleName))
            }
        }
    }

    @JavascriptInterface
    fun send(channel: String, argsJson: String) {
        val args = toKotlin(JSONArray(argsJson)) as List<*>
        pool.execute { runCatching { handle(channel, args) } }
    }

    private fun reply(id: Int, ok: Boolean, json: String) {
        main.post { web.evaluateJavascript("window.__snakeReply($id,$ok,${JSONObject.quote(json)})", null) }
    }

    fun emit(channel: String, args: List<Any?>) {
        val payload = JSONObject.quote(JSONArray(args.map(JSONObject::wrap)).toString())
        main.post { web.evaluateJavascript("window.__snakeEmit(${JSONObject.quote(channel)},$payload)", null) }
    }

    private fun json(v: Any?): String = when (v) {
        null, Unit -> "null"
        is String -> JSONObject.quote(v)
        else -> JSONObject.wrap(v)?.toString() ?: "null"
    }

    private fun toKotlin(v: Any?): Any? = when (v) {
        is JSONObject -> v.keys().asSequence().associateWith { toKotlin(v.get(it)) }
        is JSONArray -> (0 until v.length()).map { toKotlin(v.get(it)) }
        JSONObject.NULL -> null
        else -> v
    }

    private fun <T> onMain(block: () -> T): T {
        val f = CompletableFuture<T>()
        main.post { runCatching(block).onSuccess(f::complete).onFailure(f::completeExceptionally) }
        return f.get()
    }

    private fun readJson(f: File): Any? = runCatching { toKotlin(org.json.JSONTokener(f.readText()).nextValue()) }.getOrNull()
    private fun writeJson(f: File, v: Any?) {
        val tmp = File(f.path + ".tmp")
        tmp.writeText((JSONObject.wrap(v) as? JSONObject)?.toString(2) ?: "{}")
        tmp.renameTo(f)
    }

    private val shellEnv: Map<String, String>
        get() = mapOf(
            "TERM" to "xterm-256color",
            "COLORTERM" to "truecolor",
            "TERM_PROGRAM" to "SnakesTerminal",
            "HOME" to home.path,
            "TMPDIR" to activity.cacheDir.path,
            "LANG" to "en_US.UTF-8",
            "PATH" to (System.getenv("PATH") ?: "/system/bin:/system/xbin:/vendor/bin"),
            "ANDROID_DATA" to (System.getenv("ANDROID_DATA") ?: "/data"),
            "ANDROID_ROOT" to (System.getenv("ANDROID_ROOT") ?: "/system"),
            "EXTERNAL_STORAGE" to (System.getenv("EXTERNAL_STORAGE") ?: "/sdcard"),
            "PS1" to "\\w \$ ",
            "SNAKESSH_HOME" to sshHome.path,
            "USER" to "android",
        )

    // ------------------------------------------------------------------ channels

    @Suppress("UNCHECKED_CAST")
    private fun handle(channel: String, a: List<*>): Any? {
        fun s(i: Int) = a.getOrNull(i) as? String
        fun n(i: Int) = (a.getOrNull(i) as? Number)?.toInt() ?: 0
        fun m(i: Int) = (a.getOrNull(i) as? Map<String, Any?>).orEmpty()
        return when (channel) {
            "app:init" -> mapOf(
                "platform" to "android",
                "home" to home.path,
                "user" to "android",
                "hostname" to Build.MODEL,
                "defaultShell" to "/system/bin/sh",
                "shells" to listOf(mapOf("name" to "sh", "file" to "/system/bin/sh", "args" to listOf("-i"))),
                "ssh" to ssh,
                "settings" to (readJson(settingsFile) ?: emptyMap<String, Any>()),
                "state" to (readJson(stateFile) ?: emptyMap<String, Any>()),
                "first" to mapOf("restore" to first.also { first = false }),
                "ptyAvailable" to true,
                "versions" to mapOf(
                    "app" to BuildConfig.VERSION_NAME,
                    "electron" to "Android ${Build.VERSION.RELEASE}",
                    "chrome" to (WebView.getCurrentWebViewPackage()?.versionName ?: "?"),
                    "node" to "none",
                ),
            )
            "settings:set" -> { writeJson(settingsFile, a.getOrNull(0)); mapOf("ok" to true) }
            "state:set" -> {
                val state = (readJson(stateFile) as? Map<String, Any?>).orEmpty() + m(0)
                writeJson(stateFile, state); null
            }

            "win:minimize" -> { main.post { activity.moveTaskToBack(true) }; null }
            "win:close" -> { emit("app:beforeClose", emptyList()); null }
            "win:forceClose" -> { main.post { activity.finishAndRemoveTask() }; null }
            "win:toggleMaximize", "win:flash", "win:new" -> null
            "win:isMaximized" -> true
            "win:setTitle" -> { main.post { activity.setTaskTitle(s(0).orEmpty()) }; null }
            "win:toggleFullScreen" -> { main.post { activity.setFullScreen(!activity.fullScreen) }; null }

            "pty:create" -> {
                val o = m(0)
                val file = (o["file"] as? String) ?: "/system/bin/sh"
                val args = (o["args"] as? List<*>).orEmpty().map { it.toString() }
                val env = shellEnv + (o["env"] as? Map<String, Any?>).orEmpty().mapValues { it.value.toString() }
                terminals.create(listOf(file) + args, (o["cwd"] as? String) ?: home.path,
                    (o["cols"] as? Number)?.toInt() ?: 80, (o["rows"] as? Number)?.toInt() ?: 24, env)
            }
            "pty:write" -> { terminals.write(n(0), s(1).orEmpty()); null }
            "pty:resize" -> { terminals.resize(n(0), n(1), n(2)); null }
            "pty:kill" -> { terminals.kill(n(0)); null }
            "pty:cwd" -> terminals.cwd(n(0))
            "pty:process" -> terminals.process(n(0))

            "clipboard:write" -> {
                if (s(1) != "selection") onMain {
                    activity.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Snake's Terminal", s(0).orEmpty()))
                }
                null
            }
            "clipboard:read" -> onMain {
                activity.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(activity)?.toString().orEmpty()
            }
            "shell:openExternal" -> {
                val uri = Uri.parse(s(0) ?: return null)
                if (uri.scheme in listOf("http", "https", "mailto")) main.post { runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, uri)) } }
                null
            }
            "edit:native", "notify" -> null
            "dialog:openScheme" -> activity.pickSchemes()
            "dialog:confirm" -> activity.confirm(m(0))

            "devices:local" -> devices.local()
            "devices:sshConfig" -> emptyList<Any>()
            "devices:keys" -> devices.keys()
            "devices:makeKey" -> devices.makeKey()
            "devices:tailscale" -> mapOf("installed" to false, "peers" to emptyList<Any>())
            "devices:scan" -> devices.scan()
            "devices:browse" -> { devices.browse(a.getOrNull(0) == true); null }
            "devices:installKeyCommand" -> devices.installKeyCommand(m(0))
            "devices:enableSshCommand" -> devices.enableSshCommand()
            "devices:openSharingSettings" -> null
            else -> throw IllegalArgumentException("Unknown channel $channel")
        }
    }

    fun dispose() {
        terminals.killAll()
        devices.dispose()
        pool.shutdownNow()
    }
}
