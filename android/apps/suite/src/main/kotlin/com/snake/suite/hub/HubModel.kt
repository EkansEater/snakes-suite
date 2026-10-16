package com.snake.suite.hub

import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.snake.suite.BuildConfig
import com.snake.suite.core.Tool
import com.snake.suite.core.Tools
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers

/** What a tile shows while something happens to its tool. */
data class Work(val label: String, val progress: Float?)

class HubModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("hub", Context.MODE_PRIVATE)
    private val installer = Installer(app)
    private val queue = Mutex()   // one install at a time, like the desktop hub

    var index by mutableStateOf<Index?>(null); private set
    var indexError by mutableStateOf<String?>(null); private set
    var checking by mutableStateOf(false); private set
    var message by mutableStateOf<String?>(null)
    val installed = mutableStateMapOf<String, String>()   // tool id -> installed versionName
    val work = mutableStateMapOf<String, Work>()
    private val jobs = mutableMapOf<String, Job>()   // by package: the Studio apps share one

    /** The tools that come with [tool]'s APK (the seven Studio apps share one). */
    private fun siblings(tool: Tool) = Tools.all.filter { it.packageName == tool.packageName }.ifEmpty { listOf(tool) }

    var autoUpdate: Boolean
        get() = prefs.getBoolean("auto_update", true)
        set(v) { prefs.edit().putBoolean("auto_update", v).apply(); autoUpdateState = v }
    var autoUpdateState by mutableStateOf(autoUpdate); private set

    var indexUrl: String
        get() = prefs.getString("index_url", null) ?: BuildConfig.INDEX_URL
        set(v) { prefs.edit().putString("index_url", v.trim().ifEmpty { null }).apply() }

    val hubVersion: String = BuildConfig.VERSION_NAME

    init { refreshInstalled() }

    fun refreshInstalled() {
        val pm = getApplication<Application>().packageManager
        Tools.all.filter { it.android }.forEach { tool ->
            val v = try {
                pm.getPackageInfo(tool.packageName, 0).versionName ?: "?"
            } catch (_: PackageManager.NameNotFoundException) {
                null
            }
            if (v == null) installed.remove(tool.id) else installed[tool.id] = v
        }
    }

    /** Check the release, at most every six hours unless [force]. Updates follow if they are on. */
    fun check(force: Boolean = false) {
        val last = prefs.getLong("last_check", 0)
        if (!force && index != null && System.currentTimeMillis() - last < 6 * 3600_000L) return
        if (checking) return
        checking = true
        viewModelScope.launch {
            runCatching { withContext(Dispatchers.IO) { Index.fetch(indexUrl, BuildConfig.INDEX_PUBKEY) } }
                .onSuccess {
                    index = it
                    indexError = null
                    prefs.edit().putLong("last_check", System.currentTimeMillis()).apply()
                    if (autoUpdate) updateAll(quiet = true)
                }
                .onFailure { index = null; indexError = it.message ?: it.javaClass.simpleName }
            checking = false
        }
    }

    fun offered(tool: Tool): Apk? = if (tool.id == Tool.HUB_ID) index?.hub else index?.tools?.get(tool.id)

    fun hasUpdate(tool: Tool): Boolean = offered(tool)?.let { newer(it.version, installed[tool.id]) } == true

    val hubUpdate: Apk? get() = index?.hub?.takeIf { newer(it.version, hubVersion) }

    /** One per APK: updating Word brings the other Studio apps along. */
    fun updatesAvailable(): List<Tool> = Tools.all.filter { hasUpdate(it) }.distinctBy { it.packageName }

    fun open(tool: Tool) {
        val ctx = getApplication<Application>()
        val launch = if (tool.activity != null && tool.id in installed) {
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .setClassName(tool.packageName, "${tool.packageName}.${tool.activity}")
        } else ctx.packageManager.getLaunchIntentForPackage(tool.packageName)
        if (launch == null) {
            message = "${tool.name} is not installed"
            return
        }
        ctx.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    fun install(tool: Tool, quiet: Boolean = false) {
        if (tool.packageName in jobs) return
        val together = siblings(tool)
        val apk = offered(tool) ?: run {
            message = if (index == null) "Can't reach the release: ${indexError ?: "checking..."}"
            else "${tool.name} has no Android build in the latest release yet"
            return
        }
        if (!installer.canInstall()) {
            if (!quiet) {
                message = "Allow Snake's Master Suite to install apps, then tap ${tool.name} again"
                getApplication<Application>().startActivity(installer.allowInstallsIntent())
            }
            return
        }
        val verb = if (tool.id in installed) "Updating" else "Installing"
        val label = if (together.size > 1) "Snake's Studio (${together.joinToString(", ") { it.name.removePrefix("Snake's ") }})" else tool.name
        fun show(w: Work) = together.forEach { work[it.id] = w }
        show(Work("Waiting...", null))
        jobs[tool.packageName] = viewModelScope.launch {
            try {
                queue.withLock {
                    val file = installer.download(apk, tool.apkFile) { show(Work("Downloading", it)) }
                    show(Work("$verb...", null))
                    val error = installer.install(file, tool.packageName)
                    refreshInstalled()
                    message = error?.let { "$label: $it" } ?: "$label ${apk.version} installed"
                }
            } catch (e: Exception) {
                if (e !is kotlinx.coroutines.CancellationException) message = "$label: ${e.message}"
            } finally {
                together.forEach { work.remove(it.id) }
                jobs.remove(tool.packageName)
            }
        }
    }

    fun cancel(tool: Tool) {
        jobs[tool.packageName]?.cancel()
    }

    fun updateAll(quiet: Boolean = false) {
        val tools = updatesAvailable()
        hubUpdate?.let { updateHub(quiet) }
        if (tools.isEmpty() && !quiet && hubUpdate == null) message = "Everything is up to date"
        tools.forEach { install(it, quiet) }
    }

    /** The hub replaces itself; Android restarts it afterwards. */
    fun updateHub(quiet: Boolean = false) {
        if (hubUpdate == null) return
        install(Tools.hub, quiet)
    }

    fun installAll() {
        Tools.all.filter { it.android && it.id !in installed }.distinctBy { it.packageName }.forEach { install(it) }
    }

    fun uninstall(tool: Tool) = installer.uninstall(tool.packageName)

    fun appInfo(tool: Tool) {
        getApplication<Application>().startActivity(
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${tool.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
