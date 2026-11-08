package com.snake.suite.net.capture

import com.snake.suite.net.Ports
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.net.InetAddress

/** Byte counts of one connection; the capture engine adds to them, the screen reads them. */
class FlowStats(val key: FlowKey, val uid: Int) {
    @Volatile var recv = 0L
    @Volatile var sent = 0L
    @Volatile var closedAt = 0L
    val proto get() = if (key.proto == PROTO_TCP) "tcp" else "udp"
}

data class LiveConn(val proto: String, val remote: InetAddress, val port: Int, val service: String, val category: String,
                    val down: Double, val up: Double, val recv: Long, val sent: Long, val open: Boolean)

data class LiveApp(val uid: Int, val down: Double, val up: Double, val recv: Long, val sent: Long,
                   val conns: List<LiveConn>, val category: String, val service: String)

data class LiveType(val category: String, val rate: Double, val total: Long)

data class LiveState(
    val running: Boolean = false,
    val since: Long = 0,
    val apps: List<LiveApp> = emptyList(),
    val types: List<LiveType> = emptyList(),
    val down: Double = 0.0,
    val up: Double = 0.0,
    val error: String? = null,
)

/** What live capture has seen, for the screen. */
object Live {
    private val _state = MutableStateFlow(LiveState())
    val state: StateFlow<LiveState> = _state

    private val flows = java.util.concurrent.ConcurrentHashMap<FlowKey, FlowStats>()
    private val prev = HashMap<FlowKey, Pair<Long, Long>>()
    private val typeTotals = HashMap<String, Long>()
    private var lastTick = 0L
    private var since = 0L

    fun started() {
        flows.clear(); prev.clear(); typeTotals.clear()
        since = System.currentTimeMillis()
        lastTick = 0L
        _state.value = LiveState(running = true, since = since)
    }

    fun stopped(error: String? = null) {
        _state.value = _state.value.copy(running = false, down = 0.0, up = 0.0, error = error,
            apps = _state.value.apps.map { it.copy(down = 0.0, up = 0.0) })
    }

    fun add(stats: FlowStats) { flows[stats.key] = stats }

    /** Called about once a second by the engine: speeds since the last call. */
    @Synchronized
    fun tick(now: Long) {
        val dt = if (lastTick == 0L) 0.0 else (now - lastTick) / 1000.0
        lastTick = now
        val byUid = HashMap<Int, MutableList<LiveConn>>()
        val typeRate = HashMap<String, Double>()
        var down = 0.0
        var up = 0.0
        val it = flows.values.iterator()
        while (it.hasNext()) {
            val f = it.next()
            val (pr, ps) = prev[f.key] ?: (0L to 0L)
            val dr = f.recv - pr
            val ds = f.sent - ps
            prev[f.key] = f.recv to f.sent
            val (svc, cat) = Ports.classify(f.proto, f.key.remotePort)
            if (dr + ds > 0) typeTotals[cat] = (typeTotals[cat] ?: 0L) + dr + ds
            val d = if (dt > 0) dr / dt else 0.0
            val u = if (dt > 0) ds / dt else 0.0
            down += d; up += u
            if (dt > 0) typeRate[cat] = (typeRate[cat] ?: 0.0) + d + u
            if (f.closedAt != 0L && now - f.closedAt > 30_000) {
                it.remove(); prev.remove(f.key); continue
            }
            byUid.getOrPut(f.uid) { mutableListOf() }.add(
                LiveConn(f.proto, f.key.remoteAddr, f.key.remotePort, svc, cat, d, u, f.recv, f.sent, f.closedAt == 0L))
        }
        val apps = byUid.map { (uid, conns) ->
            val main = conns.maxByOrNull { it.recv + it.sent + (it.down + it.up) * 1e6 }
            LiveApp(uid, conns.sumOf { it.down }, conns.sumOf { it.up }, conns.sumOf { it.recv }, conns.sumOf { it.sent },
                conns.sortedByDescending { it.down + it.up + (it.recv + it.sent) * 1e-6 }, main?.category ?: "Other",
                main?.service ?: "")
        }.sortedWith(compareByDescending<LiveApp> { it.down + it.up }.thenByDescending { it.recv + it.sent })
        val types = typeTotals.map { (c, t) -> LiveType(c, typeRate[c] ?: 0.0, t) }
            .sortedWith(compareByDescending<LiveType> { it.rate }.thenByDescending { it.total })
        _state.value = LiveState(true, since, apps, types, down, up)
    }
}
