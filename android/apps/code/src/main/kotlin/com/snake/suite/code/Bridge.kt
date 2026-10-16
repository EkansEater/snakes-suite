package com.snake.suite.code

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.FileObserver
import android.os.Handler
import android.os.Looper
import android.provider.DocumentsContract
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.widget.Toast
import androidx.core.content.FileProvider
import com.snake.suite.code.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors

/**
 * The Electron main process of Snake's Code, for Android: answers every channel
 * of src/main/preload.js. The page calls SnakeNative.invoke/send (android-bridge.js);
 * answers and events go back through evaluateJavascript.
 */
class Bridge(private val activity: MainActivity, private val web: WebView) {
    private val main = Handler(Looper.getMainLooper())
    private val pool = Executors.newCachedThreadPool()
    private val terminals = Terminals(activity) { ch, args -> emit(ch, args) }
    private val watchers = HashMap<String, FileObserver>()
    var openPath: String? = null

    val home: String get() = activity.homeDir().path
    private val userDir: File get() = activity.filesDir
    private val storePaths get() = mapOf(
        "settings" to File(userDir, "settings.json").path,
        "keybindings" to File(userDir, "keybindings.json").path,
        "state" to File(userDir, "state.json").path,
    )

    init {
        // Missing, or still empty from before there were phone defaults.
        fun unset(path: String) = !File(path).exists() || File(path).readText().trim() == "{}"
        for ((key, path) in storePaths) if (unset(path) && (key == "settings" || !File(path).exists())) File(path).writeText(
            when (key) {
                "keybindings" -> "[]\n"
                // A phone opens straight into a blank file: no activity bar, status bar,
                // breadcrumbs or minimap. All of it comes back from the View button or Settings.
                "settings" -> PHONE_DEFAULTS.toString(2) + "\n"
                else -> "{}\n"
            },
        )
    }

    // ------------------------------------------------------------------ plumbing

    @JavascriptInterface
    fun invoke(id: Int, channel: String, argsJson: String) {
        pool.execute {
            val args = toKotlin(JSONArray(argsJson)) as List<*>
            try {
                val result = handle(channel, args)
                reply(id, true, json(result))
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

    // ------------------------------------------------------------------ channels

    @Suppress("UNCHECKED_CAST")
    private fun handle(channel: String, a: List<*>): Any? {
        fun s(i: Int) = a.getOrNull(i) as? String
        fun n(i: Int) = (a.getOrNull(i) as? Number)?.toInt() ?: 0
        fun m(i: Int) = (a.getOrNull(i) as? Map<String, Any?>).orEmpty()
        return when (channel) {
            "app:init" -> mapOf(
                "openPath" to openPath.also { openPath = null },
                "isFirstWindow" to true,
                "platform" to "linux",
                "homeDir" to home,
                "sep" to "/",
                "userDir" to userDir.path,
                "storePaths" to storePaths,
                "versions" to mapOf(
                    "electron" to "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
                    "chrome" to (WebView.getCurrentWebViewPackage()?.versionName ?: "?"),
                    "node" to "none (Kotlin bridge)",
                    "app" to BuildConfig.VERSION_NAME,
                ),
                "ptyAvailable" to true,
                "shell" to terminals.shell,
            )
            "app:quit", "win:forceClose" -> { main.post { activity.finish() }; null }
            "win:close" -> { emit("app:beforeClose", emptyList()); null }
            "win:minimize" -> { main.post { activity.moveTaskToBack(true) }; null }
            "win:toggleMaximize", "win:toggleDevTools" -> {
                if (channel == "win:toggleDevTools") main.post {
                    WebView.setWebContentsDebuggingEnabled(true)
                    Toast.makeText(activity, "Inspect with chrome://inspect on a computer", Toast.LENGTH_LONG).show()
                }
                null
            }
            "win:isMaximized" -> true
            "win:setTitle" -> { main.post { activity.setTaskTitle(s(0).orEmpty()) }; null }
            "win:new" -> { s(0)?.let { p -> openPath = p; main.post { web.reload() } }; null }
            "win:toggleFullScreen" -> { main.post { activity.setFullScreen(!activity.fullScreen) }; null }
            "win:setFullScreen" -> { main.post { activity.setFullScreen(a.getOrNull(0) == true) }; null }
            "win:reload" -> { main.post { web.reload() }; null }
            "win:setZoom" -> {
                val factor = Math.pow(1.2, (a.getOrNull(0) as? Number)?.toDouble() ?: 0.0)
                main.post { web.evaluateJavascript("document.documentElement.style.zoom='$factor'", null) }
                null
            }

            "store:get" -> readStore(s(0)!!).let { v ->
                if (s(0) == "keybindings") (v as? List<*>).orEmpty() + ANDROID_KEYS else v
            }
            "store:set" -> {
                var value = a.getOrNull(1)
                if (s(0) == "keybindings") value = (value as? List<*>).orEmpty().filterNot { it in ANDROID_KEYS }
                File(storePaths.getValue(s(0)!!)).writeText(JSONObject.wrap(value).let { if (it is JSONObject) it.toString(2) else (it as? JSONArray)?.toString(2) ?: "{}" } + "\n")
                null
            }

            "fs:readDir" -> FileOps.readDir(s(0)!!)
            "fs:readFile" -> FileOps.readFile(s(0)!!, m(1)["force"] == true)
            "fs:writeFile" -> FileOps.writeFile(s(0)!!, s(1).orEmpty(), m(2)["bom"] == true)
            "fs:stat" -> FileOps.stat(s(0)!!)
            "fs:mkdir" -> { File(s(0)!!).mkdirs(); null }
            "fs:createFile" -> { FileOps.createFile(s(0)!!); null }
            "fs:rename" -> { FileOps.rename(s(0)!!, s(1)!!); null }
            "fs:copy" -> { FileOps.copy(s(0)!!, s(1)!!); null }
            "fs:trash" -> { FileOps.trash(s(0)!!, activity.trashDir()); null }
            "fs:delete" -> { FileOps.delete(s(0)!!); null }
            "fs:listFiles" -> FileOps.listFiles(s(0)!!, (a.getOrNull(1) as? List<String>).orEmpty())
            "fs:watchDirs" -> { watch((a.getOrNull(0) as? List<String>).orEmpty()); null }

            "search:run" -> FileOps.search(m(0))
            "search:cancel" -> { FileOps.cancelSearch(); null }

            "pty:create" -> {
                val o = m(0)
                terminals.create(o["cwd"] as? String, (o["cols"] as? Number)?.toInt() ?: 80, (o["rows"] as? Number)?.toInt() ?: 24,
                    (o["env"] as? Map<String, Any?>).orEmpty().mapValues { it.value.toString() }, home)
            }
            "pty:write" -> { terminals.write(n(0), s(1).orEmpty()); null }
            "pty:resize" -> { terminals.resize(n(0), n(1), n(2)); null }
            "pty:kill" -> { terminals.kill(n(0)); null }
            "pty:cwd" -> terminals.cwd(n(0))

            // Android has no git; the Source Control view then shows "no repository".
            "git:run" -> mapOf("code" to 127, "stdout" to "", "stderr" to "git is not available on Android")
            "proc:exec" -> FileOps.exec(s(0)!!, (a.getOrNull(1) as? List<String>).orEmpty(), s(2))

            "dialog:openFolder" -> activity.pickFolder()
            "dialog:openFiles" -> activity.pickFiles()
            "dialog:saveAs" -> activity.pickSaveAs(s(0))
            "dialog:message" -> activity.message(m(0))

            "shell:openExternal" -> { main.post { runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(s(0)))) } }; null }
            "shell:openPath" -> { main.post { openWithOtherApp(File(s(0)!!)) }; null }
            "shell:showItemInFolder" -> { main.post { Toast.makeText(activity, s(0), Toast.LENGTH_LONG).show() }; null }
            "clipboard:write" -> onMain {
                activity.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Snake's Code", s(0).orEmpty()))
            }.let { null }
            "clipboard:read" -> onMain {
                activity.getSystemService(ClipboardManager::class.java).primaryClip?.getItemAt(0)?.coerceToText(activity)?.toString().orEmpty()
            }
            else -> throw IllegalArgumentException("Unknown channel $channel")
        }
    }

    /** settings.json and friends, tolerating // comments and trailing commas like the desktop. */
    private fun readStore(key: String): Any? {
        val fallback: Any = if (key == "keybindings") emptyList<Any>() else emptyMap<String, Any>()
        val text = runCatching { File(storePaths.getValue(key)).readText() }.getOrNull() ?: return fallback
        val cleaned = Regex("(\"(?:\\\\.|[^\"\\\\])*\")|//[^\n]*|/\\*[\\s\\S]*?\\*/").replace(text) { it.groupValues[1] }
            .replace(Regex(",(\\s*[}\\]])"), "$1")
        return runCatching { toKotlin(org.json.JSONTokener(cleaned).nextValue()) }.getOrDefault(fallback)
    }

    private fun watch(dirs: List<String>) {
        synchronized(watchers) {
            val want = dirs.toSet()
            watchers.keys.filter { it !in want }.forEach { watchers.remove(it)?.stopWatching() }
            for (dir in want) {
                if (dir in watchers || !File(dir).isDirectory) continue
                val pending = LinkedHashSet<String>()
                var scheduled = false
                val mask = FileObserver.CREATE or FileObserver.DELETE or FileObserver.MOVED_FROM or FileObserver.MOVED_TO or
                    FileObserver.CLOSE_WRITE or FileObserver.DELETE_SELF or FileObserver.MOVE_SELF
                val obs = object : FileObserver(File(dir), mask) {
                    override fun onEvent(event: Int, path: String?) {
                        synchronized(pending) {
                            pending += if (path != null) "$dir/$path" else dir
                            if (scheduled) return
                            scheduled = true
                        }
                        main.postDelayed({
                            val paths = synchronized(pending) { pending.toList().also { pending.clear(); scheduled = false } }
                            emit("fs:changed", listOf(mapOf("dir" to dir, "paths" to paths)))
                        }, 120)
                    }
                }
                obs.startWatching()
                watchers[dir] = obs
            }
        }
    }

    private fun openWithOtherApp(f: File) {
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.files", f)
        val mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "*/*"
        runCatching {
            activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), null))
        }
    }

    fun dispose() {
        terminals.killAll()
        synchronized(watchers) { watchers.values.forEach { it.stopWatching() }; watchers.clear() }
        pool.shutdownNow()
    }

    companion object {
        private val PHONE_DEFAULTS = JSONObject()
            .put("workbench.startupEditor", "newUntitledFile")
            .put("workbench.activityBar.visible", false)
            .put("workbench.statusBar.visible", false)
            .put("workbench.breadcrumbs.enabled", false)
            .put("editor.minimap.enabled", false)
            .put("editor.wordWrap", "on")

        /**
         * Shortcuts for the commands the View button runs that have none of their own.
         * Added to the user's keybindings when the editor reads them, removed when it saves.
         */
        val ANDROID_KEYS: List<Map<String, Any>> = listOf(
            "ctrl+alt+shift+f1" to "workbench.action.toggleActivityBarVisibility",
            "ctrl+alt+shift+f2" to "workbench.action.toggleStatusbarVisibility",
            "ctrl+alt+shift+f3" to "breadcrumbs.toggle",
            "ctrl+alt+shift+f4" to "editor.toggleMinimap",
            "ctrl+alt+shift+f5" to "workbench.action.files.openFolder",
        ).map { (key, command) -> mapOf("key" to key, "command" to command) }

        /**
         * A real path for a document picked with the system picker, when it lives on
         * shared storage ("primary:Projects/x" → /storage/emulated/0/Projects/x).
         */
        fun pathOf(uri: Uri, tree: Boolean): String? {
            val id = runCatching { if (tree) DocumentsContract.getTreeDocumentId(uri) else DocumentsContract.getDocumentId(uri) }.getOrNull()
                ?: return uri.path?.takeIf { uri.scheme == "file" }
            val root = "/storage/emulated/0"
            return when {
                id.startsWith("raw:") -> id.removePrefix("raw:")
                id.startsWith("primary:") -> "$root/${id.removePrefix("primary:")}".trimEnd('/')
                id.startsWith("home:") -> "$root/Documents/${id.removePrefix("home:")}".trimEnd('/')
                id == "downloads" -> "$root/Download"
                ':' in id && uri.authority == "com.android.externalstorage.documents" ->
                    "/storage/${id.substringBefore(':')}/${id.substringAfter(':')}".trimEnd('/')   // SD card
                else -> null
            }
        }
    }
}
