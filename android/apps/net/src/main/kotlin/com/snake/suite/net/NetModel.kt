package com.snake.suite.net

import android.app.AppOpsManager
import android.app.Application
import android.app.usage.NetworkStats
import android.app.usage.NetworkStatsManager
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.drawable.Drawable
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.TrafficStats
import android.net.wifi.WifiInfo
import android.os.Build
import android.os.Process
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

const val HISTORY = 120 // seconds of graph

data class WifiState(val ssid: String?, val rssi: Int, val rxLink: Int, val txLink: Int, val freq: Int)

data class PhoneState(
    val down: Double = 0.0, val up: Double = 0.0,
    val mobileDown: Double = 0.0, val mobileUp: Double = 0.0,
    val histDown: List<Double> = List(HISTORY) { 0.0 }, val histUp: List<Double> = List(HISTORY) { 0.0 },
    val peakDown: Double = 0.0, val peakUp: Double = 0.0,
    val totalDown: Long = 0, val totalUp: Long = 0,
    val wifi: WifiState? = null, val wifiOn: Boolean = false, val mobileOn: Boolean = false, val vpnOn: Boolean = false,
)

data class AppUsage(val uid: Int, val wifiDown: Long, val wifiUp: Long, val mobileDown: Long, val mobileUp: Long) {
    val total get() = wifiDown + wifiUp + mobileDown + mobileUp
}

data class Computer(val name: String, val url: String)

class NetModel(app: Application) : AndroidViewModel(app) {
    private val ctx: Context get() = getApplication()
    private val cm = app.getSystemService(ConnectivityManager::class.java)

    private val _phone = MutableStateFlow(PhoneState())
    val phone: StateFlow<PhoneState> = _phone

    private val _usage = MutableStateFlow<List<AppUsage>?>(null)
    val usage: StateFlow<List<AppUsage>?> = _usage

    private val _computers = MutableStateFlow(loadComputers())
    val computers: StateFlow<List<Computer>> = _computers

    private var wifi: WifiState? = null
    private var wifiOn = false
    private var mobileOn = false
    private var vpnOn = false
    private val callbacks = mutableListOf<ConnectivityManager.NetworkCallback>()

    init {
        watchNetworks()
        viewModelScope.launch { sample() }
    }

    override fun onCleared() {
        callbacks.forEach { runCatching { cm.unregisterNetworkCallback(it) } }
    }

    // ------------------------------------------------------------------ live speed of the phone
    private suspend fun sample() {
        var lastT = System.nanoTime()
        var lastRx = TrafficStats.getTotalRxBytes()
        var lastTx = TrafficStats.getTotalTxBytes()
        var lastMRx = TrafficStats.getMobileRxBytes()
        var lastMTx = TrafficStats.getMobileTxBytes()
        while (true) {
            delay(1000)
            val t = System.nanoTime()
            val rx = TrafficStats.getTotalRxBytes()
            val tx = TrafficStats.getTotalTxBytes()
            val mrx = TrafficStats.getMobileRxBytes()
            val mtx = TrafficStats.getMobileTxBytes()
            val dt = (t - lastT) / 1e9
            fun d(now: Long, before: Long) = if (now < 0 || before < 0) 0L else maxOf(0L, now - before)
            val drx = d(rx, lastRx)
            val dtx = d(tx, lastTx)
            val s = _phone.value
            val down = drx / dt
            val up = dtx / dt
            _phone.value = s.copy(
                down = down, up = up,
                mobileDown = d(mrx, lastMRx) / dt, mobileUp = d(mtx, lastMTx) / dt,
                histDown = (s.histDown + down).takeLast(HISTORY), histUp = (s.histUp + up).takeLast(HISTORY),
                peakDown = maxOf(s.peakDown, down), peakUp = maxOf(s.peakUp, up),
                totalDown = s.totalDown + drx, totalUp = s.totalUp + dtx,
                wifi = wifi, wifiOn = wifiOn, mobileOn = mobileOn, vpnOn = vpnOn,
            )
            lastT = t; lastRx = rx; lastTx = tx; lastMRx = mrx; lastMTx = mtx
        }
    }

    // ------------------------------------------------------------------ Wi-Fi, mobile data, VPN
    private fun watchNetworks() {
        fun register(transport: Int, onCaps: (NetworkCapabilities?) -> Unit) {
            val request = NetworkRequest.Builder().addTransportType(transport)
                .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build()
            val cb = if (Build.VERSION.SDK_INT >= 31) {
                object : ConnectivityManager.NetworkCallback(FLAG_INCLUDE_LOCATION_INFO) {
                    override fun onCapabilitiesChanged(n: Network, c: NetworkCapabilities) = onCaps(c)
                    override fun onLost(n: Network) = onCaps(null)
                }
            } else {
                object : ConnectivityManager.NetworkCallback() {
                    override fun onCapabilitiesChanged(n: Network, c: NetworkCapabilities) = onCaps(c)
                    override fun onLost(n: Network) = onCaps(null)
                }
            }
            runCatching { cm.registerNetworkCallback(request, cb); callbacks += cb }
        }
        register(NetworkCapabilities.TRANSPORT_WIFI) { c ->
            wifiOn = c != null
            val info = c?.transportInfo as? WifiInfo
            wifi = info?.let {
                val ssid = it.ssid?.removeSurrounding("\"")?.takeUnless { s -> s == WifiManagerUnknown || s.isBlank() }
                WifiState(ssid, it.rssi, it.rxLinkSpeedMbps, it.txLinkSpeedMbps, it.frequency)
            }
        }
        register(NetworkCapabilities.TRANSPORT_CELLULAR) { c -> mobileOn = c != null }
        register(NetworkCapabilities.TRANSPORT_VPN) { c -> vpnOn = c != null }
    }

    /** After the location permission is granted, ask again so the Wi-Fi name shows. */
    fun refreshNetworks() {
        callbacks.forEach { runCatching { cm.unregisterNetworkCallback(it) } }
        callbacks.clear()
        watchNetworks()
    }

    // ------------------------------------------------------------------ usage per app
    fun hasUsageAccess(): Boolean {
        val ops = ctx.getSystemService(AppOpsManager::class.java)
        val mode = ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        return mode == AppOpsManager.MODE_ALLOWED ||
            (mode == AppOpsManager.MODE_DEFAULT &&
                ctx.checkSelfPermission(android.Manifest.permission.PACKAGE_USAGE_STATS) == PackageManager.PERMISSION_GRANTED)
    }

    fun loadUsage(days: Int) {
        if (!hasUsageAccess()) { _usage.value = null; return }
        viewModelScope.launch {
            _usage.value = withContext(Dispatchers.IO) { queryUsage(days) }
        }
    }

    private fun queryUsage(days: Int): List<AppUsage> {
        val nsm = ctx.getSystemService(NetworkStatsManager::class.java)
        val start = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
            add(Calendar.DAY_OF_YEAR, -(days - 1))
        }.timeInMillis
        val end = System.currentTimeMillis() + 60_000
        val acc = HashMap<Int, LongArray>() // wifi down, wifi up, mobile down, mobile up
        for ((type, slot) in listOf(ConnectivityManager.TYPE_WIFI to 0, ConnectivityManager.TYPE_MOBILE to 2)) {
            val stats = try { nsm.querySummary(type, null, start, end) } catch (e: Exception) { continue }
            val b = NetworkStats.Bucket()
            while (stats.hasNextBucket()) {
                stats.getNextBucket(b)
                val a = acc.getOrPut(b.uid) { LongArray(4) }
                a[slot] += b.rxBytes
                a[slot + 1] += b.txBytes
            }
            stats.close()
        }
        return acc.map { (uid, a) -> AppUsage(uid, a[0], a[1], a[2], a[3]) }
            .filter { it.total > 0 }.sortedByDescending { it.total }
    }

    // ------------------------------------------------------------------ computers
    private val prefs get() = ctx.getSharedPreferences("computers", Context.MODE_PRIVATE)

    private fun loadComputers(): List<Computer> = runCatching {
        val arr = JSONArray(app().getSharedPreferences("computers", Context.MODE_PRIVATE).getString("list", "[]"))
        List(arr.length()) { arr.getJSONObject(it).let { o -> Computer(o.getString("name"), o.getString("url")) } }
    }.getOrDefault(emptyList())

    private fun app(): Application = getApplication()

    private fun saveComputers(list: List<Computer>) {
        val arr = JSONArray()
        list.forEach { arr.put(JSONObject().put("name", it.name).put("url", it.url)) }
        prefs.edit().putString("list", arr.toString()).apply()
        _computers.value = list
    }

    fun addComputer(name: String, address: String) {
        val url = computerUrl(address) ?: return
        saveComputers(_computers.value.filter { it.url != url } + Computer(name.ifBlank { address.trim() }, url))
    }

    fun removeComputer(c: Computer) = saveComputers(_computers.value - c)
}

private const val WifiManagerUnknown = "<unknown ssid>"

/** "mainrig", "100.1.2.3", "mainrig:7878" or a full http address -> the page's address. */
fun computerUrl(address: String): String? {
    var a = address.trim().trimEnd('/')
    if (a.isEmpty()) return null
    if (!a.startsWith("http://") && !a.startsWith("https://")) a = "http://$a"
    val hostPart = a.substringAfter("://")
    val hasPort = hostPart.substringAfterLast(']').contains(':')
    return if (hasPort) a else "$a:7878"
}

/** App names and icons for the uids Android reports. */
class AppNames(private val pm: PackageManager) {
    private val names = HashMap<Int, String>()
    private val icons = HashMap<Int, Drawable?>()

    fun name(uid: Int): String = names.getOrPut(uid) {
        when (uid) {
            -1 -> "Unknown"
            0 -> "Android (root)"
            1000 -> "Android system"
            -4 -> "Removed apps"
            -5 -> "Hotspot and tethering"
            1051 -> "Android DNS"
            1073 -> "Android network stack"
            2000 -> "Shell (adb)"
            else -> {
                val pkgs = pm.getPackagesForUid(uid)
                val first = pkgs?.firstOrNull()
                val label = first?.let { runCatching { pm.getApplicationLabel(pm.getApplicationInfo(it, 0)).toString() }.getOrNull() }
                when {
                    label == null -> pm.getNameForUid(uid) ?: "uid $uid"
                    pkgs.size > 1 -> "$label and others"
                    else -> label
                }
            }
        }
    }

    fun icon(uid: Int): Drawable? = icons.getOrPut(uid) {
        val pkg = pm.getPackagesForUid(uid)?.firstOrNull() ?: return@getOrPut null
        runCatching { pm.getApplicationIcon(pkg) }.getOrNull()
    }
}
