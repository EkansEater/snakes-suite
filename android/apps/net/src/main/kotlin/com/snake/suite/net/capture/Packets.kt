package com.snake.suite.net.capture

import java.net.InetAddress

/** IP protocol numbers we handle. */
const val PROTO_TCP = 6
const val PROTO_UDP = 17

const val FIN = 0x01
const val SYN = 0x02
const val RST = 0x04
const val PSH = 0x08
const val ACK = 0x10

/** One connection as the phone's app sees it: the app's end first. */
data class FlowKey(val proto: Int, val appAddr: InetAddress, val appPort: Int, val remoteAddr: InetAddress, val remotePort: Int)

/** A packet read from the VPN interface: an app sending to the network. */
class Packet(
    val proto: Int,
    val src: InetAddress,
    val dst: InetAddress,
    val srcPort: Int,
    val dstPort: Int,
    // TCP only
    val seq: Long = 0,
    val ack: Long = 0,
    val flags: Int = 0,
    val window: Int = 0,
    val mss: Int = 0,
    // payload in [data] from [off], [len] bytes
    val data: ByteArray,
    val off: Int,
    val len: Int,
) {
    val key get() = FlowKey(proto, src, srcPort, dst, dstPort)
    fun has(flag: Int) = flags and flag != 0
}

private fun u16(b: ByteArray, i: Int) = ((b[i].toInt() and 0xff) shl 8) or (b[i + 1].toInt() and 0xff)
private fun u32(b: ByteArray, i: Int) = (u16(b, i).toLong() shl 16) or u16(b, i + 2).toLong()

/** Read an IPv4 or IPv6 packet carrying TCP or UDP; anything else (ICMP, fragments) gives null. */
fun parse(b: ByteArray, n: Int): Packet? {
    if (n < 20) return null
    val version = (b[0].toInt() and 0xff) shr 4
    val proto: Int
    val ipEnd: Int
    val t: Int
    val src: InetAddress
    val dst: InetAddress
    when (version) {
        4 -> {
            val ihl = (b[0].toInt() and 0x0f) * 4
            val total = u16(b, 2)
            val frag = u16(b, 6)
            if (frag and 0x3fff != 0) return null // a fragment: rare, and not worth reassembling
            proto = b[9].toInt() and 0xff
            ipEnd = minOf(total, n)
            t = ihl
            src = InetAddress.getByAddress(b.copyOfRange(12, 16))
            dst = InetAddress.getByAddress(b.copyOfRange(16, 20))
        }
        6 -> {
            if (n < 40) return null
            proto = b[6].toInt() and 0xff // extension headers are rare for TCP/UDP: skipped
            ipEnd = minOf(40 + u16(b, 4), n)
            t = 40
            src = InetAddress.getByAddress(b.copyOfRange(8, 24))
            dst = InetAddress.getByAddress(b.copyOfRange(24, 40))
        }
        else -> return null
    }
    return when (proto) {
        PROTO_TCP -> {
            if (ipEnd < t + 20) return null
            val doff = ((b[t + 12].toInt() and 0xff) shr 4) * 4
            if (doff < 20 || t + doff > ipEnd) return null
            var mss = 0
            var o = t + 20
            while (o < t + doff) { // options: only MSS matters to us
                val kind = b[o].toInt() and 0xff
                if (kind == 0) break
                if (kind == 1) { o++; continue }
                if (o + 1 >= t + doff) break
                val l = b[o + 1].toInt() and 0xff
                if (l < 2) break
                if (kind == 2 && l == 4) mss = u16(b, o + 2)
                o += l
            }
            Packet(PROTO_TCP, src, dst, u16(b, t), u16(b, t + 2), u32(b, t + 4), u32(b, t + 8),
                b[t + 13].toInt() and 0xff, u16(b, t + 14), mss, b, t + doff, ipEnd - t - doff)
        }
        PROTO_UDP -> {
            if (ipEnd < t + 8) return null
            Packet(PROTO_UDP, src, dst, u16(b, t), u16(b, t + 2), data = b, off = t + 8, len = ipEnd - t - 8)
        }
        else -> null
    }
}

// --------------------------------------------------------------------------- writing
private fun put16(b: ByteArray, i: Int, v: Int) { b[i] = (v shr 8).toByte(); b[i + 1] = v.toByte() }
private fun put32(b: ByteArray, i: Int, v: Long) { put16(b, i, (v shr 16).toInt() and 0xffff); put16(b, i + 2, v.toInt() and 0xffff) }

private fun sum(b: ByteArray, from: Int, len: Int, start: Long = 0): Long {
    var s = start
    var i = from
    val end = from + len
    while (i + 1 < end) { s += u16(b, i); i += 2 }
    if (i < end) s += (b[i].toInt() and 0xff) shl 8
    return s
}

private fun fold(s0: Long): Int {
    var s = s0
    while (s shr 16 != 0L) s = (s and 0xffff) + (s shr 16)
    return s.inv().toInt() and 0xffff
}

/**
 * A packet from [from] (the remote end) to [to] (the app), written back into the VPN interface.
 * [header] is the TCP or UDP header without checksum; the checksum is filled in here.
 */
private fun ipPacket(proto: Int, from: InetAddress, to: InetAddress, header: ByteArray, payload: ByteArray?, pOff: Int, pLen: Int): ByteArray {
    val a = from.address
    val bAddr = to.address
    val v6 = a.size == 16
    val ipLen = if (v6) 40 else 20
    val l4 = header.size + pLen
    val out = ByteArray(ipLen + l4)
    if (v6) {
        out[0] = 0x60
        put16(out, 4, l4)
        out[6] = proto.toByte()
        out[7] = 64
        System.arraycopy(a, 0, out, 8, 16)
        System.arraycopy(bAddr, 0, out, 24, 16)
    } else {
        out[0] = 0x45
        put16(out, 2, out.size)
        put16(out, 6, 0x4000) // don't fragment
        out[8] = 64
        out[9] = proto.toByte()
        System.arraycopy(a, 0, out, 12, 4)
        System.arraycopy(bAddr, 0, out, 16, 4)
        put16(out, 10, fold(sum(out, 0, 20)))
    }
    System.arraycopy(header, 0, out, ipLen, header.size)
    if (payload != null && pLen > 0) System.arraycopy(payload, pOff, out, ipLen + header.size, pLen)
    // Pseudo-header: addresses, protocol, length.
    var s = sum(a, 0, a.size) + sum(bAddr, 0, bAddr.size) + proto + l4
    s = sum(out, ipLen, l4, s)
    val ck = fold(s).let { if (proto == PROTO_UDP && it == 0) 0xffff else it }
    put16(out, ipLen + if (proto == PROTO_TCP) 16 else 6, ck)
    return out
}

fun tcpPacket(from: InetAddress, fromPort: Int, to: InetAddress, toPort: Int, seq: Long, ack: Long, flags: Int,
              window: Int, payload: ByteArray? = null, off: Int = 0, len: Int = 0, mss: Int = 0): ByteArray {
    val h = ByteArray(if (mss > 0) 24 else 20)
    put16(h, 0, fromPort)
    put16(h, 2, toPort)
    put32(h, 4, seq and 0xffffffffL)
    put32(h, 8, ack and 0xffffffffL)
    h[12] = ((h.size / 4) shl 4).toByte()
    h[13] = flags.toByte()
    put16(h, 14, window)
    if (mss > 0) { h[20] = 2; h[21] = 4; put16(h, 22, mss) }
    return ipPacket(PROTO_TCP, from, to, h, payload, off, len)
}

fun udpPacket(from: InetAddress, fromPort: Int, to: InetAddress, toPort: Int, payload: ByteArray, off: Int, len: Int): ByteArray {
    val h = ByteArray(8)
    put16(h, 0, fromPort)
    put16(h, 2, toPort)
    put16(h, 4, 8 + len)
    return ipPacket(PROTO_UDP, from, to, h, payload, off, len)
}

/** Sequence numbers wrap at 2^32: compare them as a circle. */
fun seqDiff(a: Long, b: Long): Long {
    val d = (a - b) and 0xffffffffL
    return if (d >= 0x80000000L) d - 0x100000000L else d
}
