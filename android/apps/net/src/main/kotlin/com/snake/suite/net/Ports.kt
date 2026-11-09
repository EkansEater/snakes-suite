package com.snake.suite.net

import androidx.compose.ui.graphics.Color

/** What kind of traffic a port carries: the same table as the desktop Snake's Net. */
object Ports {
    private val services = mapOf(
        "tcp:80" to ("HTTP" to "Web"), "tcp:443" to ("HTTPS" to "Web"), "udp:443" to ("QUIC" to "Web"),
        "tcp:8080" to ("HTTP-alt" to "Web"), "tcp:8443" to ("HTTPS-alt" to "Web"),
        "udp:53" to ("DNS" to "DNS"), "tcp:53" to ("DNS" to "DNS"), "tcp:853" to ("DNS-TLS" to "DNS"),
        "udp:853" to ("DNS-QUIC" to "DNS"), "udp:5353" to ("mDNS" to "Local net"), "udp:1900" to ("SSDP/UPnP" to "Local net"),
        "tcp:8009" to ("Chromecast" to "Local net"), "tcp:445" to ("SMB" to "Files"), "tcp:21" to ("FTP" to "Files"),
        "tcp:22" to ("SSH" to "Remote"), "tcp:3389" to ("RDP" to "Remote"), "tcp:5900" to ("VNC" to "Remote"),
        "tcp:25" to ("SMTP" to "Mail"), "tcp:465" to ("SMTPS" to "Mail"), "tcp:587" to ("SMTP" to "Mail"),
        "tcp:993" to ("IMAPS" to "Mail"), "tcp:143" to ("IMAP" to "Mail"), "tcp:995" to ("POP3S" to "Mail"),
        "udp:123" to ("NTP" to "System"), "udp:67" to ("DHCP" to "System"),
        "tcp:5228" to ("Google Play" to "System"), "tcp:5222" to ("XMPP" to "Chat"), "tcp:5223" to ("Apple Push" to "System"),
        "tcp:22000" to ("Syncthing" to "Sync"), "udp:22000" to ("Syncthing" to "Sync"), "udp:21027" to ("Syncthing" to "Sync"),
        "udp:41641" to ("Tailscale" to "VPN"), "udp:51820" to ("WireGuard" to "VPN"), "udp:1194" to ("OpenVPN" to "VPN"),
        "udp:500" to ("IPsec" to "VPN"), "udp:4500" to ("IPsec" to "VPN"),
        "udp:3478" to ("STUN" to "Calls"), "udp:3479" to ("STUN" to "Calls"),
        "tcp:1935" to ("RTMP" to "Streaming"), "tcp:554" to ("RTSP" to "Streaming"),
    )
    private val ranges = listOf(
        Triple("tcp", 6881..6889, "BitTorrent" to "P2P"), Triple("udp", 6881..6889, "BitTorrent" to "P2P"),
        Triple("udp", 27000..27100, "Steam" to "Gaming"), Triple("tcp", 27015..27050, "Steam" to "Gaming"),
        Triple("udp", 3478..3480, "STUN" to "Calls"), Triple("udp", 19302..19309, "Google Meet" to "Calls"),
        Triple("udp", 50000..50100, "Discord" to "Calls"), Triple("tcp", 47984..48010, "Moonlight" to "Streaming"),
        Triple("udp", 47998..48010, "Moonlight" to "Streaming"),
    )

    /** (service, category) for a connection to [port]. */
    fun classify(proto: String, port: Int): Pair<String, String> {
        services["$proto:$port"]?.let { return it }
        for ((p, r, hit) in ranges) if (p == proto && port in r) return hit
        return "$port" to "Other"
    }

    val order = listOf("Web", "Streaming", "Calls", "Gaming", "P2P", "Sync", "Files", "Remote", "VPN", "DNS",
        "Mail", "Chat", "Dev", "Database", "Local net", "System", "Other")

    val colors = mapOf(
        "Web" to Color(0xFF5FAFFF), "Streaming" to Color(0xFFFF87FF), "Calls" to Color(0xFFAF87FF),
        "Gaming" to Color(0xFFFF5F5F), "P2P" to Color(0xFFFF8700), "Sync" to Color(0xFF87D787),
        "Files" to Color(0xFFD7AF87), "Remote" to Color(0xFFFFD75F), "VPN" to Color(0xFF5FD7FF),
        "DNS" to Color(0xFFAFD787), "Mail" to Color(0xFFFFD7AF), "Chat" to Color(0xFFD787FF),
        "Dev" to Color(0xFF87AFD7), "Database" to Color(0xFFAF875F), "Local net" to Color(0xFF87AFAF),
        "System" to Color(0xFF949494), "Other" to Color(0xFF808080),
    )
}

/** Speeds the way the desktop shows them: bits per second by default. */
fun rate(bytesPerSec: Double, bits: Boolean = true): String {
    var v = if (bits) bytesPerSec * 8 else bytesPerSec
    val units = if (bits) listOf("b/s", "Kb/s", "Mb/s", "Gb/s") else listOf("B/s", "KB/s", "MB/s", "GB/s")
    var i = 0
    while (v >= 1000 && i < units.size - 1) { v /= 1000; i++ }
    return when {
        i == 0 -> "%.0f %s".format(v, units[i])
        v < 100 -> "%.1f %s".format(v, units[i])
        else -> "%.0f %s".format(v, units[i])
    }
}

fun size(n: Long): String {
    var v = n.toDouble()
    val units = listOf("B", "KB", "MB", "GB", "TB")
    var i = 0
    while (v >= 1000 && i < units.size - 1) { v /= 1000; i++ }
    return when {
        i == 0 -> "%.0f %s".format(v, units[i])
        v < 100 -> "%.1f %s".format(v, units[i])
        else -> "%.0f %s".format(v, units[i])
    }
}
