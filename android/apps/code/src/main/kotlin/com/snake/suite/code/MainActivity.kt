package com.snake.suite.code

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.ConsoleMessage
import android.webkit.MimeTypeMap
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding
import androidx.webkit.WebViewAssetLoader
import java.io.File
import java.io.FileInputStream
import java.util.concurrent.CompletableFuture

/**
 * Snake's Code: the desktop editor's own renderer (Monaco, explorer, search,
 * terminal, settings...) in a WebView, with [Bridge] standing in for Electron.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var bridge: Bridge
    var fullScreen = false
        private set

    private var folderResult: CompletableFuture<String?>? = null
    private var filesResult: CompletableFuture<List<String>>? = null
    private var saveResult: CompletableFuture<String?>? = null

    private val openTree = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        folderResult?.complete(uri?.let { Bridge.pathOf(it, tree = true) ?: unsupported() })
    }
    private val openDocs = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        filesResult?.complete(uris.mapNotNull { Bridge.pathOf(it, tree = false) ?: unsupported() })
    }
    private val createDoc = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { uri ->
        saveResult?.complete(uri?.let { Bridge.pathOf(it, tree = false) ?: unsupported() })
    }

    private fun unsupported(): String? {
        runOnUiThread {
            Toast.makeText(this, "Pick a folder on the phone's storage. Cloud and app folders can't be opened as files.", Toast.LENGTH_LONG).show()
        }
        return null
    }

    /** With "All files access" the whole shared storage; otherwise the app's own folder there. */
    fun homeDir(): File =
        if (Environment.isExternalStorageManager()) Environment.getExternalStorageDirectory()
        else getExternalFilesDir(null) ?: filesDir

    fun trashDir(): File = File(homeDir(), if (Environment.isExternalStorageManager()) ".snakes-code-trash" else "trash")

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        web = WebView(this)
        setContentView(web)
        // Keep the editor clear of the system bars and above the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(web) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        web.setBackgroundColor(0xFF1A1E1B.toInt())

        bridge = Bridge(this, web)
        bridge.openPath = pathFromIntent(intent)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/fs/", LocalFiles())
            .build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)
        }
        web.addJavascriptInterface(bridge, "SnakeNative")
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                android.util.Log.d("SnakesCode", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == "appassets.androidplatform.net") return false
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")

        // Back closes the way the desktop's window close button does: the editor asks about unsaved files.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = bridge.emit("app:beforeClose", emptyList())
        })

        if (!Environment.isExternalStorageManager() && !getPreferences(MODE_PRIVATE).getBoolean("asked_storage", false)) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("asked_storage", true).apply()
            AlertDialog.Builder(this)
                .setTitle("Open your own folders?")
                .setMessage("Snake's Code edits files where they are, like on the desktop. That needs \"All files access\". " +
                    "Without it, it works in its own folder only (Android/data/com.snake.suite.code).")
                .setPositiveButton("Allow") { _, _ ->
                    runCatching {
                        startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
                    }
                }
                .setNegativeButton("Not now", null)
                .show()
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pathFromIntent(intent)?.let { bridge.openPath = it; web.reload() }
    }

    private fun pathFromIntent(intent: Intent?): String? {
        val uri = intent?.data ?: return null
        return if (uri.scheme == "file") uri.path else Bridge.pathOf(uri, tree = false)
    }

    override fun onDestroy() {
        bridge.dispose()
        web.destroy()
        super.onDestroy()
    }

    fun setTaskTitle(title: String) {
        setTaskDescription(
            if (android.os.Build.VERSION.SDK_INT >= 33) ActivityManager.TaskDescription.Builder().setLabel(title).build()
            else @Suppress("DEPRECATION") ActivityManager.TaskDescription(title),
        )
    }

    fun setFullScreen(on: Boolean) {
        fullScreen = on
        val c = WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
            c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            c.hide(WindowInsetsCompat.Type.systemBars())
        } else c.show(WindowInsetsCompat.Type.systemBars())
        bridge.emit("win:fullscreen", listOf(on))
    }

    // ---------------------------------------------------------------- dialogs (called off the main thread)

    fun pickFolder(): String? = CompletableFuture<String?>().also { f ->
        folderResult = f
        runOnUiThread { openTree.launch(null) }
    }.get()

    fun pickFiles(): List<String> = CompletableFuture<List<String>>().also { f ->
        filesResult = f
        runOnUiThread { openDocs.launch(arrayOf("*/*")) }
    }.get()

    fun pickSaveAs(defaultPath: String?): String? = CompletableFuture<String?>().also { f ->
        saveResult = f
        runOnUiThread { createDoc.launch(defaultPath?.substringAfterLast('/') ?: "untitled.txt") }
    }.get()

    /** dialog:message: returns the index of the button pressed. */
    fun message(opts: Map<String, Any?>): Int {
        @Suppress("UNCHECKED_CAST")
        val buttons = (opts["buttons"] as? List<String>)?.ifEmpty { null } ?: listOf("OK")
        val cancelId = (opts["cancelId"] as? Number)?.toInt() ?: (buttons.size - 1)
        val f = CompletableFuture<Int>()
        runOnUiThread {
            val b = AlertDialog.Builder(this)
                .setTitle(opts["message"] as? String ?: "Snake's Code")
                .setOnCancelListener { f.complete(cancelId) }
            val detail = opts["detail"] as? String
            if (buttons.size <= 3) {
                if (detail != null) b.setMessage(detail)
                b.setPositiveButton(buttons[0]) { _, _ -> f.complete(0) }
                if (buttons.size >= 2) b.setNegativeButton(buttons.last()) { _, _ -> f.complete(buttons.size - 1) }
                if (buttons.size == 3) b.setNeutralButton(buttons[1]) { _, _ -> f.complete(1) }
            } else {
                b.setItems(buttons.toTypedArray()) { _, which -> f.complete(which) }
            }
            b.show()
        }
        return f.get()
    }

    /** Serves /fs/<path> from local storage: images, media and Markdown pictures in the editor. */
    private inner class LocalFiles : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse? {
            val f = File("/" + Uri.decode(path).substringBefore('?'))
            if (!f.isFile || !f.canRead()) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), null)
            val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(f.extension.lowercase()) ?: "application/octet-stream"
            return WebResourceResponse(mime, null, FileInputStream(f))
        }
    }
}
