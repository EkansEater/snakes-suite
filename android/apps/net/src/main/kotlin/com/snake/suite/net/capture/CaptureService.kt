package com.snake.suite.net.capture

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.VpnService
import android.util.Log

/**
 * Live capture as a local VPN: Android sends every app's traffic here, [Engine] counts it per
 * app and passes it on. Nothing goes anywhere else. Android allows one VPN at a time, so
 * starting this one turns off another (Tailscale) until it stops.
 */
class CaptureService : VpnService() {
    companion object {
        private const val ACTION_START = "com.snake.suite.net.START"
        private const val ACTION_STOP = "com.snake.suite.net.STOP"
        @Volatile private var engine: Engine? = null

        val running get() = engine != null

        /** Start after [VpnService.prepare] gave null (or the user agreed). */
        fun start(ctx: Context) {
            ctx.startService(Intent(ctx, CaptureService::class.java).setAction(ACTION_START))
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, CaptureService::class.java).setAction(ACTION_STOP))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopCapture(null)
            stopSelf()
            return START_NOT_STICKY
        }
        startCapture()
        return START_NOT_STICKY
    }

    private fun startCapture() {
        if (engine != null) return
        val cm = getSystemService(ConnectivityManager::class.java)
        val dns = cm.activeNetwork?.let { cm.getLinkProperties(it)?.dnsServers }.orEmpty()
        val builder = Builder()
            .setSession("Snake's Net live capture")
            .setMtu(1500)
            .addAddress("10.215.173.1", 32)
            .addRoute("0.0.0.0", 0)
            .addAddress("fd00:736e:6574::1", 128)
            .addRoute("::", 0)
            .setMetered(false) // as metered as the Wi-Fi or mobile data under it
        try { builder.addDisallowedApplication(packageName) } catch (_: Exception) {}
        for (d in dns) try { builder.addDnsServer(d) } catch (_: Exception) {}
        if (dns.isEmpty()) builder.addDnsServer("1.1.1.1")
        val tun = try { builder.establish() } catch (e: Exception) { null }
        if (tun == null) {
            Live.stopped("Android didn't allow the VPN.")
            stopSelf()
            return
        }
        Live.started()
        engine = Engine(this, tun).also {
            it.setUncaughtExceptionHandler { _, e ->
                Log.e("SnakesNetCapture", "engine stopped", e)
                stopCapture("Live capture stopped: ${e.message}")
            }
            it.start()
        }
    }

    private fun stopCapture(error: String?) {
        val e = engine ?: return
        engine = null
        e.shutdown()
        Live.stopped(error)
    }

    /** Another VPN took over, or the user turned this one off in Settings. */
    override fun onRevoke() {
        stopCapture(null)
        stopSelf()
    }

    override fun onDestroy() {
        stopCapture(null)
        super.onDestroy()
    }
}
