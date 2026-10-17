package com.snake.suite.terminal

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import java.io.File
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/**
 * The phone side of the Devices panel: its addresses, keys (made by snakessh), the network
 * scan and Bonjour/mDNS discovery (Android's NsdManager) of computers with SSH on.
 */
class Devices(private val context: Context, private val sshHome: File, private val ssh: String, private val emit: (String, List<Any?>) -> Unit) {

    // ---------------------------------------------------------------- this phone
    private fun addresses(): List<Map<String, Any>> = runCatching {
        NetworkInterface.getNetworkInterfaces().toList().filter { it.isUp && !it.isLoopback }.flatMap { ni ->
            ni.interfaceAddresses.filter { it.address is Inet4Address && !it.address.isLinkLocalAddress }.map { ia ->
                mapOf("iface" to ni.name, "address" to ia.address.hostAddress.orEmpty(), "prefix" to ia.networkPrefixLength.toInt(),
                    "tailscale" to (ni.name.startsWith("tun") && ia.address.hostAddress.orEmpty().startsWith("100.")))
            }
        }
    }.getOrDefault(emptyList())

    fun local(): Map<String, Any> = mapOf(
        "hostname" to "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".trim(),
        "user" to "android",
        "os" to "android",
        "addresses" to addresses(),
        "sshServer" to false,
        "sshBanner" to "",
        "sshClient" to File(ssh).canExecute(),
    )

    // ---------------------------------------------------------------- keys
    fun keys(): List<Map<String, String>> = (sshHome.listFiles { f -> f.name.endsWith(".pub") } ?: emptyArray()).sortedBy { it.name }.mapNotNull { f ->
        val line = safeKeyLine(f.readText()) ?: return@mapNotNull null
        val parts = line.split(' ')
        mapOf("file" to f.path, "name" to f.name.removeSuffix(".pub"), "type" to parts[0], "comment" to parts.drop(2).joinToString(" "), "line" to line)
    }

    private fun safeKeyLine(text: String): String? {
        val parts = text.trim().split(Regex("\\s+"))
        if (parts.size < 2 || !Regex("^(ssh-|ecdsa-|sk-)[\\w@.-]+$").matches(parts[0]) || !Regex("^[A-Za-z0-9+/=]+$").matches(parts[1])) return null
        val comment = parts.drop(2).joinToString(" ").replace(Regex("[^\\w@.\\-() ]"), "").take(80)
        return listOf(parts[0], parts[1], comment).filter { it.isNotEmpty() }.joinToString(" ")
    }

    fun makeKey(): Map<String, Any?> {
        keys().firstOrNull()?.let { return mapOf("ok" to true, "key" to it, "created" to false) }
        sshHome.mkdirs()
        val comment = "${Build.MODEL} (Snake's Terminal)".replace(Regex("[^\\w@.\\-() ]"), "")
        val p = ProcessBuilder(ssh, "keygen", File(sshHome, "id_ed25519").path, comment).redirectErrorStream(true).start()
        val out = p.inputStream.bufferedReader().readText()
        if (p.waitFor() != 0) return mapOf("ok" to false, "error" to out.trim().ifEmpty { "Could not make a key." })
        return mapOf("ok" to true, "key" to keys().firstOrNull(), "created" to true)
    }

    fun installKeyCommand(host: Map<String, Any?>): Map<String, Any?> {
        val made = makeKey()
        if (made["ok"] != true) return made
        @Suppress("UNCHECKED_CAST")
        val key = (made["key"] as Map<String, String>)["line"]!!
        val remote = if (host["os"] == "windows") {
            val ps = listOf(
                "\$k = '$key'",
                "\$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)",
                "if (\$admin) { \$f = Join-Path \$env:ProgramData \"ssh\\administrators_authorized_keys\" } else { New-Item -Force -ItemType Directory (Join-Path \$HOME \".ssh\") | Out-Null; \$f = Join-Path \$HOME \".ssh\\authorized_keys\" }",
                "if (-not (Test-Path \$f) -or -not (Select-String -Quiet -SimpleMatch -Pattern \$k -Path \$f)) { Add-Content -Path \$f -Value \$k }",
                "if (\$admin) { icacls \$f /inheritance:r /grant \"Administrators:F\" /grant \"SYSTEM:F\" | Out-Null }",
                "Write-Output \"Key login is set up.\"",
            ).joinToString("; ")
            "powershell -NoProfile -EncodedCommand " + Base64.getEncoder().encodeToString(ps.toByteArray(Charsets.UTF_16LE))
        } else {
            "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF '$key' ~/.ssh/authorized_keys || echo '$key' >> ~/.ssh/authorized_keys) && echo 'Key login is set up.'"
        }
        return mapOf("ok" to true, "file" to ssh, "args" to sshArgs(host) + remote, "created" to made["created"], "key" to made["key"])
    }

    private fun sshArgs(h: Map<String, Any?>): List<String> {
        val args = mutableListOf<String>()
        val port = (h["port"] as? Number)?.toInt() ?: (h["port"] as? String)?.toIntOrNull() ?: 22
        if (port != 22) args += listOf("-p", port.toString())
        (h["identity"] as? String)?.takeIf { it.isNotBlank() }?.let { args += listOf("-i", it) }
        val user = (h["user"] as? String).orEmpty()
        val host = (h["host"] as? String).orEmpty()
        args += if (user.isNotEmpty()) "$user@$host" else host
        return args
    }

    fun enableSshCommand(): Map<String, Any?> = mapOf(
        "os" to "android",
        "steps" to listOf("A phone does not take SSH connections: connect from it to your computers instead."),
    )

    // ---------------------------------------------------------------- scan
    @Volatile private var scanning = false

    fun scan(): Map<String, Any> {
        if (scanning) return mapOf("scanned" to 0, "found" to emptyList<Any>())
        scanning = true
        try {
            val targets = LinkedHashSet<String>()
            for (a in addresses()) {
                if (a["tailscale"] == true) continue
                val ip = (a["address"] as String).split('.').map { it.toInt() }
                val prefix = (a["prefix"] as Int).coerceIn(22, 30).let { if (it < 24) 24 else it }
                val size = 1 shl (32 - prefix)
                val self = (ip[0] shl 24) or (ip[1] shl 16) or (ip[2] shl 8) or ip[3]
                val net = self and (-1 shl (32 - prefix))
                for (i in 1 until size - 1) {
                    val n = net + i
                    if (n != self) targets += "${(n ushr 24) and 255}.${(n ushr 16) and 255}.${(n ushr 8) and 255}.${n and 255}"
                }
            }
            val found = java.util.Collections.synchronizedList(mutableListOf<Map<String, Any?>>())
            val pool = Executors.newFixedThreadPool(48)
            val left = AtomicInteger(targets.size)
            for (host in targets) pool.execute {
                try {
                    Socket().use { s ->
                        s.connect(InetSocketAddress(host, 22), 700)
                        s.soTimeout = 600
                        val banner = runCatching { s.getInputStream().bufferedReader().readLine().orEmpty() }.getOrDefault("").removePrefix("SSH-2.0-")
                        val os = when {
                            Regex("windows", RegexOption.IGNORE_CASE).containsMatchIn(banner) -> "windows"
                            Regex("ubuntu|debian|raspbian|fedora|arch|linux", RegexOption.IGNORE_CASE).containsMatchIn(banner) -> "linux"
                            Regex("apple|darwin", RegexOption.IGNORE_CASE).containsMatchIn(banner) -> "macos"
                            else -> ""
                        }
                        val name = runCatching { java.net.InetAddress.getByName(host).canonicalHostName }.getOrNull()?.takeIf { it != host }
                        found += mapOf("address" to host, "banner" to banner, "os" to os, "name" to name)
                        emit("devices:scanFound", listOf(found.toList()))
                    }
                } catch (_: Exception) {
                } finally {
                    left.decrementAndGet()
                }
            }
            pool.shutdown()
            pool.awaitTermination(60, java.util.concurrent.TimeUnit.SECONDS)
            return mapOf("scanned" to targets.size, "found" to found.toList())
        } finally {
            scanning = false
        }
    }

    // ---------------------------------------------------------------- mDNS
    private val nsd = context.getSystemService(NsdManager::class.java)
    private val listeners = mutableListOf<NsdManager.DiscoveryListener>()
    private val seen = ConcurrentHashMap<String, Map<String, Any?>>()
    private val resolving = Executors.newSingleThreadExecutor()
    private var multicast: WifiManager.MulticastLock? = null

    fun browse(on: Boolean) {
        synchronized(listeners) {
            listeners.forEach { runCatching { nsd.stopServiceDiscovery(it) } }
            listeners.clear()
            multicast?.let { if (it.isHeld) it.release() }
            if (!on) return
            multicast = context.getSystemService(WifiManager::class.java)?.createMulticastLock("snake-terminal")?.apply { setReferenceCounted(false); acquire() }
            for (type in listOf("_ssh._tcp", "_snaketerm._tcp")) {
                val l = object : NsdManager.DiscoveryListener {
                    override fun onDiscoveryStarted(serviceType: String) {}
                    override fun onDiscoveryStopped(serviceType: String) {}
                    override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
                    override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
                    override fun onServiceFound(info: NsdServiceInfo) { resolving.execute { resolve(info, type) } }
                    override fun onServiceLost(info: NsdServiceInfo) {
                        if (seen.remove("${info.serviceName}.$type") != null) report()
                    }
                }
                runCatching { nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, l) }.onSuccess { listeners += l }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun resolve(info: NsdServiceInfo, type: String) {
        val done = java.util.concurrent.CountDownLatch(1)
        nsd.resolveService(info, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) { done.countDown() }
            override fun onServiceResolved(s: NsdServiceInfo) {
                val txt = s.attributes.mapValues { String(it.value ?: ByteArray(0)) }
                val address = s.host?.hostAddress
                val mine = addresses().any { it["address"] == address }
                if (address != null && !mine) {
                    seen["${s.serviceName}.$type"] = mapOf(
                        "id" to "${s.serviceName}.$type",
                        "name" to (txt["name"] ?: s.serviceName),
                        "host" to address,
                        "address" to address,
                        "port" to s.port,
                        "user" to txt["user"],
                        "os" to txt["os"],
                        "snake" to (type == "_snaketerm._tcp"),
                        "seen" to System.currentTimeMillis(),
                    )
                    report()
                }
                done.countDown()
            }
        })
        done.await(5, java.util.concurrent.TimeUnit.SECONDS) // NsdManager resolves one at a time
    }

    private fun report() {
        // One row per computer: a Snake's Terminal announcement wins over the plain SSH one.
        val merged = LinkedHashMap<String, Map<String, Any?>>()
        for (d in seen.values) {
            val k = d["address"] as String
            val prev = merged[k]
            if (prev == null || (d["snake"] == true && prev["snake"] != true)) merged[k] = d
        }
        emit("devices:nearby", listOf(merged.values.sortedBy { (it["name"] as? String).orEmpty() }))
    }

    fun dispose() {
        browse(false)
        resolving.shutdownNow()
    }
}
