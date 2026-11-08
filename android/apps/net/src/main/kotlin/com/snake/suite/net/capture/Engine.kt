package com.snake.suite.net.capture

import android.net.ConnectivityManager
import android.net.VpnService
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructPollfd
import android.util.Log
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.Inet6Address
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.nio.channels.DatagramChannel
import java.nio.channels.SelectionKey
import java.nio.channels.Selector
import java.nio.channels.SocketChannel
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.random.Random

private const val TAG = "SnakesNetCapture"
private const val TO_SERVER_MAX = 512 * 1024   // bytes waiting to go out to the server, per connection
private const val UNACKED_MAX = 256 * 1024     // bytes sent to the app and not yet acknowledged
private const val RTO_MS = 600L
private const val MAX_RETRIES = 10

/**
 * The live capture's engine. Every packet an app sends into the VPN arrives here; each TCP
 * connection is ended here and carried on over a normal socket to where it was going (likewise
 * each UDP flow), and the answers are written back as packets. On the way, it counts the bytes
 * of every connection for [Live], with the app that owns it.
 *
 * One thread does all the work (flows, sockets, writing packets); a second only reads the VPN.
 */
class Engine(private val vpn: VpnService, private val tun: ParcelFileDescriptor) : Thread("snakes-net-engine") {
    @Volatile private var running = true
    private val selector = Selector.open()
    private val inbox = ConcurrentLinkedQueue<ByteArray>()
    private val tunOut = FileOutputStream(tun.fileDescriptor)
    private val tcp = HashMap<FlowKey, TcpFlow>()
    private val udp = HashMap<FlowKey, UdpFlow>()
    private val cm = vpn.getSystemService(ConnectivityManager::class.java)
    private val readBuf = ByteBuffer.allocate(64 * 1024)
    private val reader = Thread({ readLoop() }, "snakes-net-tun")

    fun shutdown() {
        running = false
        selector.wakeup()
    }

    // ------------------------------------------------------------------ the VPN side
    private fun readLoop() {
        val input = FileInputStream(tun.fileDescriptor)
        val buf = ByteArray(32 * 1024)
        val pfd = StructPollfd().apply { fd = tun.fileDescriptor; events = OsConstants.POLLIN.toShort() }
        while (running) {
            try {
                if (Os.poll(arrayOf(pfd), 500) <= 0) continue
                val n = input.read(buf)
                if (n > 0) {
                    inbox.add(buf.copyOf(n))
                    selector.wakeup()
                }
            } catch (e: ErrnoException) {
                if (e.errno == OsConstants.EINTR || e.errno == OsConstants.EAGAIN) continue
                if (running) Log.w(TAG, "VPN read: $e")
                break
            } catch (e: Exception) {
                if (running) Log.w(TAG, "VPN read: $e")
                break
            }
        }
        running = false
        selector.wakeup()
    }

    private fun toApp(packet: ByteArray) {
        try {
            tunOut.write(packet)
        } catch (e: Exception) {
            Log.w(TAG, "VPN write: $e")
        }
    }

    // ------------------------------------------------------------------ main loop
    override fun run() {
        reader.start()
        var lastTimers = 0L
        var lastTick = 0L
        try {
            while (running) {
                selector.select(200)
                while (true) {
                    val p = inbox.poll() ?: break
                    try { handle(p) } catch (e: Exception) { Log.w(TAG, "packet: $e") }
                }
                val keys = selector.selectedKeys()
                for (k in keys) {
                    try {
                        when (val f = k.attachment()) {
                            is TcpFlow -> f.ready(k)
                            is UdpFlow -> f.ready()
                        }
                    } catch (e: Exception) {
                        (k.attachment() as? TcpFlow)?.close(rst = true)
                        (k.attachment() as? UdpFlow)?.close()
                    }
                }
                keys.clear()
                val now = System.currentTimeMillis()
                if (now - lastTimers >= 200) { timers(now); lastTimers = now }
                if (now - lastTick >= 1000) { Live.tick(now); lastTick = now }
            }
        } finally {
            tcp.values.toList().forEach { it.close(rst = true) }
            udp.values.toList().forEach { it.close() }
            try { selector.close() } catch (_: Exception) {}
            try { tun.close() } catch (_: Exception) {}
            reader.interrupt()
        }
    }

    private fun timers(now: Long) {
        tcp.values.toList().forEach { it.timer(now) }
        udp.values.toList().forEach { it.timer(now) }
    }

    private fun handle(raw: ByteArray) {
        val p = parse(raw, raw.size) ?: return
        if (p.proto == PROTO_TCP) {
            val flow = tcp[p.key]
            if (flow != null) flow.fromApp(p)
            else if (p.has(SYN) && !p.has(ACK)) openTcp(p)
            else if (!p.has(RST)) resetUnknown(p)
        } else {
            (udp[p.key] ?: openUdp(p))?.fromApp(p)
        }
    }

    private fun owner(p: Packet): Int = try {
        cm.getConnectionOwnerUid(p.proto, InetSocketAddress(p.src, p.srcPort), InetSocketAddress(p.dst, p.dstPort))
    } catch (_: Exception) { -1 }

    private fun resetUnknown(p: Packet) {
        val seqLen = p.len + (if (p.has(SYN)) 1 else 0) + (if (p.has(FIN)) 1 else 0)
        if (p.has(ACK)) toApp(tcpPacket(p.dst, p.dstPort, p.src, p.srcPort, p.ack, 0, RST, 0))
        else toApp(tcpPacket(p.dst, p.dstPort, p.src, p.srcPort, 0, p.seq + seqLen, RST or ACK, 0))
    }

    // ------------------------------------------------------------------ TCP
    private fun openTcp(p: Packet) {
        val stats = FlowStats(p.key, owner(p))
        val ch = try {
            SocketChannel.open().apply {
                configureBlocking(false)
                vpn.protect(socket())
                connect(InetSocketAddress(p.dst, p.dstPort))
            }
        } catch (e: Exception) {
            resetUnknown(p)
            return
        }
        val flow = TcpFlow(p, ch, stats)
        flow.key = ch.register(selector, SelectionKey.OP_CONNECT, flow)
        tcp[p.key] = flow
        Live.add(stats)
    }

    private enum class TcpState { CONNECTING, SYN_SENT_TO_APP, OPEN }

    /** A growing buffer of bytes sent to the app and not yet acknowledged, to send again if lost. */
    private class Unacked {
        var buf = ByteArray(16 * 1024)
        var size = 0
        fun add(src: ByteArray, off: Int, len: Int) {
            if (size + len > buf.size) buf = buf.copyOf(maxOf(buf.size * 2, size + len))
            System.arraycopy(src, off, buf, size, len)
            size += len
        }
        fun drop(n: Int) {
            val k = minOf(n, size)
            System.arraycopy(buf, k, buf, 0, size - k)
            size -= k
        }
    }

    private inner class TcpFlow(syn: Packet, val ch: SocketChannel, val stats: FlowStats) {
        val id = syn.key
        lateinit var key: SelectionKey
        var state = TcpState.CONNECTING
        val myIsn = Random.nextLong(0, 0xffffffffL)
        var myNext = (myIsn + 1) and 0xffffffffL     // next sequence number we send
        var myAcked = myNext                          // the app has everything before this
        var appNext = (syn.seq + 1) and 0xffffffffL   // next byte we expect from the app
        var appWindow = syn.window
        val ourMss = if (syn.dst is Inet6Address) 1440 else 1460
        val mss = minOf(if (syn.mss > 0) syn.mss else 536, ourMss)
        val unacked = Unacked()
        val toServer = ArrayDeque<ByteBuffer>()
        var toServerBytes = 0
        var appFin = false
        var outShut = false
        var serverEof = false
        var finSent = false
        var finAcked = false
        var lastSent = 0L
        var retries = 0
        var lastActivity = System.currentTimeMillis()
        var closed = false

        var lastWindow = 65535

        private fun window() = maxOf(0, minOf(65535, TO_SERVER_MAX - toServerBytes))

        private fun send(flags: Int, seq: Long = myNext, payload: ByteArray? = null, off: Int = 0, len: Int = 0, mssOpt: Int = 0) {
            val window = window()
            lastWindow = window
            toApp(tcpPacket(id.remoteAddr, id.remotePort, id.appAddr, id.appPort, seq, appNext, flags, window, payload, off, len, mssOpt))
        }

        private fun sendSynAck() {
            toApp(tcpPacket(id.remoteAddr, id.remotePort, id.appAddr, id.appPort, myIsn, appNext, SYN or ACK, 65535, mss = ourMss))
            lastSent = System.currentTimeMillis()
        }

        private fun inFlight() = seqDiff(myNext, myAcked) - (if (finSent && !finAcked) 1 else 0)

        fun ready(k: SelectionKey) {
            if (!k.isValid) return
            if (k.isConnectable) {
                try {
                    if (!ch.finishConnect()) return
                } catch (e: Exception) {
                    close(rst = true)
                    return
                }
                state = TcpState.SYN_SENT_TO_APP
                sendSynAck()
                interest()
                return
            }
            if (k.isValid && k.isWritable) flush()
            if (k.isValid && k.isReadable) fromServer()
        }

        fun fromApp(p: Packet) {
            lastActivity = System.currentTimeMillis()
            if (p.has(RST)) { close(rst = false); return }
            if (p.has(SYN)) {
                if (state == TcpState.SYN_SENT_TO_APP) sendSynAck() // the app didn't get ours
                return
            }
            if (p.has(ACK)) {
                if (state == TcpState.SYN_SENT_TO_APP && seqDiff(p.ack, myNext) == 0L) {
                    state = TcpState.OPEN
                    retries = 0
                } else if (state == TcpState.OPEN) {
                    val d = seqDiff(p.ack, myAcked)
                    if (d > 0 && seqDiff(p.ack, myNext) <= 0) {
                        unacked.drop(d.toInt())
                        myAcked = p.ack
                        retries = 0
                        lastSent = System.currentTimeMillis()
                        if (finSent && seqDiff(p.ack, myNext) == 0L) finAcked = true
                    }
                }
                appWindow = p.window
            }
            if (state != TcpState.OPEN) return
            var acceptedFinPos = true
            if (p.len > 0) {
                val d = seqDiff(p.seq, appNext)
                val skip = if (d < 0) (-d).toInt() else 0
                if (d <= 0 && skip < p.len) {
                    val n = p.len - skip
                    if (toServerBytes + n <= TO_SERVER_MAX) {
                        toServer.addLast(ByteBuffer.wrap(p.data.copyOfRange(p.off + skip, p.off + p.len)))
                        toServerBytes += n
                        appNext = (appNext + n) and 0xffffffffL
                        flush()
                    } else acceptedFinPos = false // full: no ACK, the app sends it again
                } else if (d > 0) acceptedFinPos = false // a gap: ask again for what's missing
                send(ACK)
            }
            if (p.has(FIN) && acceptedFinPos && !appFin && seqDiff((p.seq + p.len) and 0xffffffffL, appNext) == 0L) {
                appFin = true
                appNext = (appNext + 1) and 0xffffffffL
                send(ACK)
                shutOutIfDone()
            }
            interest()
            doneYet()
        }

        private fun flush() {
            try {
                while (toServer.isNotEmpty()) {
                    val b = toServer.first()
                    val n = ch.write(b)
                    toServerBytes -= n
                    stats.sent += n
                    if (b.hasRemaining()) break
                    toServer.removeFirst()
                }
            } catch (e: Exception) {
                close(rst = true)
                return
            }
            // The app stops sending when our window closes: tell it when there is room again.
            if (state == TcpState.OPEN && lastWindow < 16 * 1024 && window() >= lastWindow + 2 * mss) send(ACK)
            shutOutIfDone()
            interest()
        }

        private fun shutOutIfDone() {
            if (appFin && toServer.isEmpty() && !outShut) {
                outShut = true
                try { ch.shutdownOutput() } catch (_: Exception) {}
            }
        }

        private fun fromServer() {
            val room = minOf(appWindow.toLong() - inFlight(), (UNACKED_MAX - unacked.size).toLong())
            if (room <= 0) { interest(); return }
            readBuf.clear()
            readBuf.limit(minOf(room, readBuf.capacity().toLong()).toInt())
            val n = try { ch.read(readBuf) } catch (e: Exception) { close(rst = true); return }
            if (n < 0) {
                serverEof = true
                sendFin()
                interest()
                doneYet()
                return
            }
            if (n == 0) return
            stats.recv += n
            val arr = readBuf.array()
            unacked.add(arr, 0, n)
            var off = 0
            while (off < n) {
                val seg = minOf(mss, n - off)
                send(ACK or PSH, myNext, arr, off, seg)
                myNext = (myNext + seg) and 0xffffffffL
                off += seg
            }
            lastSent = System.currentTimeMillis()
            interest()
        }

        private fun sendFin() {
            if (finSent) return
            send(FIN or ACK, myNext)
            myNext = (myNext + 1) and 0xffffffffL
            finSent = true
            lastSent = System.currentTimeMillis()
        }

        private fun interest() {
            if (closed || !key.isValid) return
            var ops = 0
            if (state == TcpState.CONNECTING) ops = SelectionKey.OP_CONNECT
            else if (state == TcpState.OPEN) {
                if (!serverEof && appWindow - inFlight() > 0 && unacked.size < UNACKED_MAX) ops = ops or SelectionKey.OP_READ
                if (toServer.isNotEmpty()) ops = ops or SelectionKey.OP_WRITE
            }
            key.interestOps(ops)
        }

        private fun doneYet() {
            if (appFin && finSent && finAcked && toServer.isEmpty()) close(rst = false)
        }

        fun timer(now: Long) {
            if (closed) return
            when (state) {
                TcpState.CONNECTING -> if (now - lastActivity > 30_000) close(rst = true)
                TcpState.SYN_SENT_TO_APP -> if (now - lastSent > RTO_MS) {
                    if (++retries > MAX_RETRIES) close(rst = true) else sendSynAck()
                }
                TcpState.OPEN -> {
                    val waiting = inFlight() > 0 || (finSent && !finAcked)
                    if (waiting && now - lastSent > RTO_MS * (1 shl minOf(retries, 4))) {
                        if (++retries > MAX_RETRIES) { close(rst = true); return }
                        // Send again what the app hasn't acknowledged (as much as its window takes).
                        var off = 0
                        val limit = minOf(unacked.size, maxOf(appWindow, mss))
                        while (off < limit) {
                            val seg = minOf(mss, limit - off)
                            send(ACK or PSH, (myAcked + off) and 0xffffffffL, unacked.buf, off, seg)
                            off += seg
                        }
                        if (finSent && !finAcked && unacked.size == 0) send(FIN or ACK, (myNext - 1) and 0xffffffffL)
                        lastSent = now
                    }
                    if (appWindow - inFlight() > 0) interest() // the window opened again
                    if (now - lastActivity > 15 * 60_000 && inFlight() == 0L) close(rst = true)
                }
            }
        }

        fun close(rst: Boolean) {
            if (closed) return
            closed = true
            if (rst) toApp(tcpPacket(id.remoteAddr, id.remotePort, id.appAddr, id.appPort, myNext, appNext, RST or ACK, 0))
            try { key.cancel() } catch (_: Exception) {}
            try { ch.close() } catch (_: Exception) {}
            tcp.remove(id)
            stats.closedAt = System.currentTimeMillis()
        }
    }

    // ------------------------------------------------------------------ UDP
    private fun openUdp(p: Packet): UdpFlow? {
        val ch = try {
            DatagramChannel.open().apply {
                configureBlocking(false)
                vpn.protect(socket())
                connect(InetSocketAddress(p.dst, p.dstPort))
            }
        } catch (e: Exception) {
            return null // multicast, broadcast or no route: dropped
        }
        val stats = FlowStats(p.key, owner(p))
        val flow = UdpFlow(p.key, ch, stats)
        flow.key = ch.register(selector, SelectionKey.OP_READ, flow)
        udp[p.key] = flow
        Live.add(stats)
        return flow
    }

    private inner class UdpFlow(val id: FlowKey, val ch: DatagramChannel, val stats: FlowStats) {
        lateinit var key: SelectionKey
        var lastActivity = System.currentTimeMillis()
        val timeout = if (id.remotePort == 53) 20_000L else 120_000L

        fun fromApp(p: Packet) {
            lastActivity = System.currentTimeMillis()
            try {
                ch.write(ByteBuffer.wrap(p.data, p.off, p.len))
                stats.sent += p.len
            } catch (e: Exception) {
                close()
            }
        }

        fun ready() {
            while (true) {
                readBuf.clear()
                val n = try { ch.read(readBuf) } catch (e: Exception) { close(); return }
                if (n <= 0) return
                lastActivity = System.currentTimeMillis()
                stats.recv += n
                toApp(udpPacket(id.remoteAddr, id.remotePort, id.appAddr, id.appPort, readBuf.array(), 0, n))
            }
        }

        fun timer(now: Long) {
            if (now - lastActivity > timeout) close()
        }

        fun close() {
            try { key.cancel() } catch (_: Exception) {}
            try { ch.close() } catch (_: Exception) {}
            udp.remove(id)
            stats.closedAt = System.currentTimeMillis()
        }
    }
}
