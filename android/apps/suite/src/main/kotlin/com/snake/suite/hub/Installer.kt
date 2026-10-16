package com.snake.suite.hub

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Downloads APKs from the release and hands them to the system installer. */
class Installer(private val context: Context) {

    /** Download [apk] into the cache, reporting 0..1, and check its sha256. */
    suspend fun download(apk: Apk, name: String, progress: (Float) -> Unit): File = withContext(Dispatchers.IO) {
        val dir = File(context.cacheDir, "apk").apply { mkdirs() }
        val out = File(dir, name)
        val conn = URL(apk.url).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 60_000
        try {
            if (conn.responseCode !in 200..299) error("HTTP ${conn.responseCode} downloading $name")
            val total = conn.contentLengthLong.takeIf { it > 0 } ?: apk.size
            val digest = MessageDigest.getInstance("SHA-256")
            conn.inputStream.use { input ->
                out.outputStream().use { output ->
                    val buf = ByteArray(1 shl 16)
                    var done = 0L
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val n = input.read(buf)
                        if (n < 0) break
                        output.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        done += n
                        if (total > 0) progress(done.toFloat() / total)
                    }
                }
            }
            val hash = digest.digest().joinToString("") { "%02x".format(it) }
            if (apk.sha256.isNotEmpty() && !hash.equals(apk.sha256, ignoreCase = true)) {
                out.delete()
                error("$name is damaged (checksum mismatch). Try again.")
            }
            out
        } finally {
            conn.disconnect()
        }
    }

    /** May this app install packages? On Android 8+ the user allows it once per installer app. */
    fun canInstall(): Boolean = context.packageManager.canRequestPackageInstalls()

    fun allowInstallsIntent(): Intent =
        Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /**
     * Install [apk] and wait for the result. Returns null on success, else the reason.
     * Updates of tools this app installed go through without a prompt on Android 12+.
     */
    suspend fun install(apk: File, packageName: String): String? = withContext(Dispatchers.IO) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(packageName)
            setSize(apk.length())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                setPackageSource(PackageInstaller.PACKAGE_SOURCE_DOWNLOADED_FILE)
            }
        }
        val sessionId = installer.createSession(params)
        val action = "${context.packageName}.INSTALL_RESULT.$sessionId"
        val result = CompletableDeferred<String?>()
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                    PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                        @Suppress("DEPRECATION")
                        val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                        confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let(c::startActivity)
                    }
                    PackageInstaller.STATUS_SUCCESS -> result.complete(null)
                    else -> result.complete(
                        intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: describe(status),
                    )
                }
            }
        }
        ContextCompat.registerReceiver(context, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
        try {
            installer.openSession(sessionId).use { session ->
                session.openWrite("base.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out, 1 shl 16) }
                    session.fsync(out)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
                val pending = PendingIntent.getBroadcast(
                    context, sessionId, Intent(action).setPackage(context.packageName), flags,
                )
                session.commit(pending.intentSender)
            }
            result.await()
        } finally {
            context.unregisterReceiver(receiver)
            apk.delete()
        }
    }

    private fun describe(status: Int) = when (status) {
        PackageInstaller.STATUS_FAILURE_ABORTED -> "Cancelled"
        PackageInstaller.STATUS_FAILURE_BLOCKED -> "Blocked by the system"
        PackageInstaller.STATUS_FAILURE_CONFLICT -> "Conflicts with an installed app (signed with another key?)"
        PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> "Not compatible with this device"
        PackageInstaller.STATUS_FAILURE_INVALID -> "The download is not a valid APK"
        PackageInstaller.STATUS_FAILURE_STORAGE -> "Not enough storage"
        else -> "Install failed ($status)"
    }

    fun uninstall(packageName: String) {
        @Suppress("DEPRECATION")
        context.startActivity(
            Intent(Intent.ACTION_UNINSTALL_PACKAGE, Uri.parse("package:$packageName")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }
}
