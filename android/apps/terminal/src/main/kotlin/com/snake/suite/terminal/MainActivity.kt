package com.snake.suite.terminal

import android.annotation.SuppressLint
import android.app.ActivityManager
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.TextView
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
import java.util.concurrent.CompletableFuture

/**
 * Snake's Terminal: the desktop app's own page (tabs, splits, devices, settings) in a
 * WebView, with [Bridge] standing in for Electron.
 */
class MainActivity : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var bridge: Bridge
    var fullScreen = false
        private set

    private var schemesResult: CompletableFuture<List<Map<String, String>>>? = null
    private val openDocs = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val out = uris.take(50).mapNotNull { uri ->
            runCatching {
                val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) c.getString(0) else null
                } ?: "Imported"
                val text = contentResolver.openInputStream(uri)!!.use { it.readNBytes(1_000_000).toString(Charsets.UTF_8) }
                mapOf("name" to name.substringBeforeLast('.'), "text" to text)
            }.getOrNull()
        }
        schemesResult?.complete(out)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        web = WebView(this)
        setContentView(web)
        // Keep the terminal clear of the system bars and above the keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(web) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        web.setBackgroundColor(0xFF151916.toInt())
        bridge = Bridge(this, web)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
        }
        web.addJavascriptInterface(bridge, "SnakeNative")
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                android.util.Log.d("SnakesTerminal", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == "appassets.androidplatform.net") return false
                if (request.url.scheme in listOf("http", "https", "mailto")) runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
        }
        web.loadUrl("https://appassets.androidplatform.net/assets/www/index.html")

        // The notification that says terminals are open (Android 13 and later ask first).
        if (android.os.Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        // Back leaves the terminals running, like switching to another app.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { moveTaskToBack(true) }
        })
    }

    override fun onDestroy() {
        KeepAlive.update(this, 0)
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

    /** dialog:openScheme: colour scheme files picked by the person. Called off the main thread. */
    fun pickSchemes(): List<Map<String, String>> = CompletableFuture<List<Map<String, String>>>().also { f ->
        schemesResult = f
        runOnUiThread { openDocs.launch(arrayOf("*/*")) }
    }.get()

    /** dialog:confirm: {response: button index, checked: the checkbox}. Called off the main thread. */
    fun confirm(opts: Map<String, Any?>): Map<String, Any> {
        @Suppress("UNCHECKED_CAST")
        val buttons = (opts["buttons"] as? List<String>)?.ifEmpty { null } ?: listOf("OK", "Cancel")
        val cancelId = (opts["cancelId"] as? Number)?.toInt() ?: (buttons.size - 1)
        val f = CompletableFuture<Map<String, Any>>()
        runOnUiThread {
            val box = (opts["checkbox"] as? String)?.let { CheckBox(this).apply { text = it } }
            val view = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(64, 16, 64, 0)
                (opts["detail"] as? String)?.let { addView(TextView(context).apply { text = it }) }
                box?.let { addView(it) }
            }
            val result = { i: Int -> f.complete(mapOf("response" to i, "checked" to (box?.isChecked == true))) }
            val b = AlertDialog.Builder(this)
                .setTitle(opts["message"] as? String ?: "Snake's Terminal")
                .setView(view)
                .setOnCancelListener { result(cancelId) }
                .setPositiveButton(buttons[0]) { _, _ -> result(0) }
            if (buttons.size >= 2) b.setNegativeButton(buttons.last()) { _, _ -> result(buttons.size - 1) }
            b.show()
        }
        return f.get()
    }
}
