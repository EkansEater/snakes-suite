package com.snake.suite.studio

import android.Manifest
import android.annotation.SuppressLint
import android.app.ActivityManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.print.PrintAttributes
import android.print.PrintManager
import android.util.Base64
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.updatePadding
import androidx.webkit.WebViewAssetLoader
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CompletableFuture
import java.util.concurrent.Executors

/**
 * One Studio app (Word, Spreadsheets, ...): the desktop Studio's page for it in a
 * WebView, served from the APK at https://appassets.androidplatform.net/assets/studio/.
 * The page reaches the phone only through [Bridge] (window.SnakeAndroid): the file
 * pickers, the files picked, printing, and opening the other Studio apps.
 */
open class StudioActivity(private val app: String) : ComponentActivity() {
    private lateinit var web: WebView
    private lateinit var files: Files
    private val main = Handler(Looper.getMainLooper())
    private val pool = Executors.newCachedThreadPool()
    private var startUris: List<Uri> = emptyList()
    private var fullScreen = false

    // The pickers answer on the main thread; the bridge waits for them on its own thread.
    private var pickResult: CompletableFuture<ActivityResult>? = null
    private val picker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { pickResult?.complete(it) }
    private var micResult: CompletableFuture<Boolean>? = null
    private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { micResult?.complete(it) }
    private var chooserCallback: ValueCallback<Array<Uri>>? = null
    private val chooser = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        chooserCallback?.onReceiveValue(uris.toTypedArray())
        chooserCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        files = Files(this)
        startUris = urisFrom(intent)
        web = WebView(this)
        setContentView(web)
        // Clear of the system bars, and above the keyboard while typing.
        ViewCompat.setOnApplyWindowInsetsListener(web) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            if (fullScreen) v.updatePadding(0, 0, 0, ime.bottom)
            else v.updatePadding(left = bars.left, top = bars.top, right = bars.right, bottom = maxOf(bars.bottom, ime.bottom))
            WindowInsetsCompat.CONSUMED
        }
        web.setBackgroundColor(0xFF1A1E1B.toInt())

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true            // settings and crash recovery, as on the website
            allowFileAccess = false             // nothing on the phone but what the person picks
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false
            setSupportZoom(false)               // the apps zoom what is under the fingers themselves
            builtInZoomControls = false
            textZoom = 100                      // the apps have their own interface size (pinch the menus)
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        web.addJavascriptInterface(Bridge(), "SnakeAndroid")
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                android.util.Log.d("SnakesStudio", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                return true
            }

            // An <input type="file"> the apps did not route through the bridge.
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                chooserCallback?.onReceiveValue(null)
                chooserCallback = callback
                chooser.launch(arrayOf("*/*"))
                return true
            }

            // Movie Maker's voice-over is the only thing that asks: the microphone, after Android asks the person.
            override fun onPermissionRequest(request: PermissionRequest) {
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE !in request.resources) { request.deny(); return }
                pool.execute {
                    val ok = ContextCompat.checkSelfPermission(this@StudioActivity, Manifest.permission.RECORD_AUDIO) ==
                        PackageManager.PERMISSION_GRANTED || CompletableFuture<Boolean>().also { f ->
                            micResult = f
                            main.post { askMic.launch(Manifest.permission.RECORD_AUDIO) }
                        }.get()
                    main.post { if (ok) request.grant(arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) else request.deny() }
                }
            }
        }
        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val url = request.url
                if (url.host != HOST) return null
                val path = url.path.orEmpty()
                if (path.startsWith("/file/")) {
                    val id = path.removePrefix("/file/").substringBefore('/')
                    return files.serve(id, request.requestHeaders.entries.firstOrNull { it.key.equals("Range", true) }?.value)
                }
                return assets.shouldInterceptRequest(url)
            }

            // The pages never leave the app; links go to the browser.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                openExternal(request.url.toString())
                return true
            }
        }
        web.loadUrl("https://$HOST/assets/studio/$app/index.html")

        // Back closes what is open on top (a menu, a dialog, a drawer), then the app, asking about unsaved work.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                web.evaluateJavascript("window.__snakeBack ? window.__snakeBack() : 'none'") { r ->
                    if (r == null || r == "\"none\"" || r == "null") finish()
                }
            }
        })
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val uris = urisFrom(intent)
        if (uris.isEmpty()) return
        val list = JSONArray()
        for (u in uris) list.put(files.register(u))
        emit("file:opened", JSONArray().put(list))
    }

    override fun onDestroy() {
        files.closeAll()
        web.destroy()
        pool.shutdown()
        super.onDestroy()
    }

    private fun urisFrom(intent: Intent?): List<Uri> {
        if (intent == null || (intent.action != Intent.ACTION_VIEW && intent.action != Intent.ACTION_EDIT)) return emptyList()
        return listOfNotNull(intent.data).filter { it.scheme == "content" }
    }

    private fun emit(channel: String, args: JSONArray) {
        main.post { web.evaluateJavascript("window.__snakeEmit && window.__snakeEmit(${JSONObject.quote(channel)},${JSONObject.quote(args.toString())})", null) }
    }

    private fun openExternal(url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme !in setOf("https", "http", "mailto")) return
        runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
    }

    private fun pick(intent: Intent): ActivityResult = CompletableFuture<ActivityResult>().also { f ->
        pickResult = f
        main.post { runCatching { picker.launch(intent) }.onFailure { f.complete(ActivityResult(RESULT_CANCELED, null)) } }
    }.get()

    /** The MIME types of a page's filters ({ name, exts }), or every type when one is unknown. */
    private fun mimesOf(filters: JSONArray?): Array<String> {
        val exts = mutableListOf<String>()
        for (i in 0 until (filters?.length() ?: 0)) {
            val e = filters!!.getJSONObject(i).optJSONArray("exts") ?: continue
            for (j in 0 until e.length()) exts += e.getString(j).lowercase()
        }
        if (exts.isEmpty()) return arrayOf("*/*")
        val mimes = exts.map { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) }
        return if (mimes.any { it == null }) arrayOf("*/*") else mimes.filterNotNull().distinct().toTypedArray()
    }

    private fun setFull(on: Boolean) {
        fullScreen = on
        val c = WindowCompat.getInsetsController(window, window.decorView)
        if (on) {
            c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            c.hide(WindowInsetsCompat.Type.systemBars())
        } else c.show(WindowInsetsCompat.Type.systemBars())
        ViewCompat.requestApplyInsets(web)
        emit("win:fullScreen", JSONArray().put(on))
    }

    // ---------------------------------------------------------------------- the page's side

    /** window.SnakeAndroid. invoke() answers through __snakeReply; files are written in pieces. */
    inner class Bridge {
        @JavascriptInterface
        fun invoke(id: Int, channel: String, argsJson: String) {
            pool.execute {
                val (ok, value) = try {
                    true to handle(channel, JSONArray(argsJson))
                } catch (e: Throwable) {
                    false to (e.message ?: e.javaClass.simpleName)
                }
                val json = when (value) {
                    null, Unit -> "null"
                    is String -> JSONObject.quote(value)
                    else -> value.toString()
                }
                main.post { web.evaluateJavascript("window.__snakeReply($id,$ok,${JSONObject.quote(json)})", null) }
            }
        }

        @JavascriptInterface
        fun writeBegin(fileId: String): String? = files.beginWrite(fileId)

        @JavascriptInterface
        fun writeChunk(token: String, base64: String): Boolean =
            runCatching { Base64.decode(base64, Base64.NO_WRAP) }.getOrNull()?.let { files.writeChunk(token, it) } ?: false

        @JavascriptInterface
        fun writeEnd(token: String, keep: Boolean): String = files.endWrite(token, keep).toString()

        private fun handle(channel: String, a: JSONArray): Any? = when (channel) {
            "app:init" -> JSONObject().put("app", app).put("platform", "android")
                .put("files", JSONArray().apply { startUris.forEach { put(files.register(it)) } }.also { startUris = emptyList() })
                .put("recent", files.recent(app))
            "file:open" -> {
                val o = a.optJSONObject(0) ?: JSONObject()
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, mimesOf(o.optJSONArray("filters")))
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, o.optBoolean("multiple"))
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION)
                val r = pick(intent)
                val uris = buildList {
                    r.data?.clipData?.let { c -> for (i in 0 until c.itemCount) add(c.getItemAt(i).uri) }
                    if (isEmpty()) r.data?.data?.let(::add)
                }
                JSONArray().apply {
                    if (r.resultCode == RESULT_OK) for (u in uris) {
                        val f = files.register(u)
                        files.remember(u, f.getString("name"), app)
                        put(f)
                    }
                }
            }
            "file:openFolder" -> {
                val o = a.optJSONObject(0) ?: JSONObject()
                val exts = mutableSetOf<String>()
                o.optJSONArray("filters")?.let { fs ->
                    for (i in 0 until fs.length()) fs.getJSONObject(i).optJSONArray("exts")?.let { e -> for (j in 0 until e.length()) exts += e.getString(j).lowercase() }
                }
                val r = pick(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                val tree = r.data?.data
                JSONArray().apply {
                    if (r.resultCode == RESULT_OK && tree != null) for ((u, name) in files.listTree(tree, exts)) put(files.register(u, name))
                }
            }
            "file:saveAs" -> {
                val o = a.optJSONObject(0) ?: JSONObject()
                val name = o.optString("name", "Untitled")
                val ext = name.substringAfterLast('.', "").lowercase()
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
                val r = pick(Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime)
                    .putExtra(Intent.EXTRA_TITLE, name))
                val uri = r.data?.data
                if (r.resultCode != RESULT_OK || uri == null) null
                else {
                    val f = files.register(uri)
                    files.remember(uri, f.getString("name"), app)
                    f
                }
            }
            "file:recent" -> files.recent(app)
            "file:openRecent" -> files.openRecent(app, a.getString(0))
            "file:forgetRecent" -> files.forgetRecent(app, if (a.isNull(0)) null else a.getString(0))
            "print" -> {
                val title = a.optString(0, "Snake's Studio").ifEmpty { "Snake's Studio" }
                main.post {
                    val pm = getSystemService(PRINT_SERVICE) as PrintManager
                    pm.print(title, web.createPrintDocumentAdapter(title), PrintAttributes.Builder().build())
                }
                null
            }
            "win:title" -> {
                val t = a.optString(0)
                main.post {
                    setTaskDescription(
                        if (Build.VERSION.SDK_INT >= 33) ActivityManager.TaskDescription.Builder().setLabel(t).build()
                        else @Suppress("DEPRECATION") ActivityManager.TaskDescription(t),
                    )
                }
                null
            }
            "win:fullScreen" -> { val on = if (a.isNull(0)) !fullScreen else a.getBoolean(0); main.post { setFull(on) }; null }
            "win:close" -> { main.post { finish() }; null }
            "openExternal" -> { openExternal(a.getString(0)); null }
            "launch" -> {
                val cls = STUDIO_ACTIVITIES[a.getString(0)] ?: error("No such app")
                main.post { startActivity(Intent(this@StudioActivity, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
                null
            }
            else -> error("Unknown request: $channel")
        }
    }

    companion object {
        const val HOST = "appassets.androidplatform.net"
    }
}
