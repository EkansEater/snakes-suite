package com.snake.suite.net

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Bundle
import android.provider.Settings
import android.view.ViewGroup
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.graphics.drawable.toBitmap
import com.snake.suite.core.ChoiceChip
import com.snake.suite.core.EmptyState
import com.snake.suite.core.PrimaryButton
import com.snake.suite.core.SecondaryButton
import com.snake.suite.core.SectionLabel
import com.snake.suite.core.Snake
import com.snake.suite.core.SnakeCard
import com.snake.suite.core.SnakeScaffold
import com.snake.suite.core.SnakeTheme
import com.snake.suite.core.Tools
import com.snake.suite.net.capture.CaptureService
import com.snake.suite.net.capture.Live
import com.snake.suite.net.capture.LiveApp
import com.snake.suite.net.capture.LiveState

private val Down = Color(0xFF6FD18A)
private val Up = Color(0xFFF277A8)
private val Mono = FontFamily.Monospace

class MainActivity : ComponentActivity() {
    private val model: NetModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { SnakeTheme { NetScreen(model) } }
    }
}

@Composable
fun NetScreen(model: NetModel) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var open by remember { mutableStateOf<Computer?>(null) }
    val tool = Tools.byId("net")!!
    open?.let { c ->
        ComputerView(c) { open = null }
        return
    }
    SnakeScaffold(
        tool,
        subtitle = listOf("This phone", "Apps", "Computers")[tab],
        bottomBar = {
            NavigationBar(containerColor = Snake.Title, modifier = Modifier.navigationBarsPadding()) {
                val colors = NavigationBarItemDefaults.colors(selectedIconColor = Snake.Highlight, selectedTextColor = Snake.Highlight,
                    indicatorColor = Snake.Selection, unselectedIconColor = Snake.Fg2, unselectedTextColor = Snake.Fg2)
                NavigationBarItem(tab == 0, { tab = 0 }, { Icon(Icons.Default.PhoneAndroid, null) }, label = { Text("Phone") }, colors = colors)
                NavigationBarItem(tab == 1, { tab = 1 }, { Icon(Icons.Default.Apps, null) }, label = { Text("Apps") }, colors = colors)
                NavigationBarItem(tab == 2, { tab = 2 }, { Icon(Icons.Default.Computer, null) }, label = { Text("Computers") }, colors = colors)
            }
        },
    ) { pad ->
        Box(Modifier.padding(pad).fillMaxSize()) {
            when (tab) {
                0 -> PhoneTab(model)
                1 -> AppsTab(model)
                else -> ComputersTab(model) { open = it }
            }
        }
    }
}

// ====================================================================== Phone
@Composable
private fun PhoneTab(model: NetModel) {
    val s by model.phone.collectAsState()
    val ctx = LocalContext.current
    val askLocation = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { model.refreshNetworks() }
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            SnakeCard {
                SectionLabel("Speed")
                Row(Modifier.fillMaxWidth()) {
                    Column(Modifier.weight(1f)) {
                        Text("▼ Download", color = Snake.Fg2, fontSize = 12.sp)
                        Text(rate(s.down), color = Down, fontSize = 24.sp, fontWeight = FontWeight.Bold, fontFamily = Mono)
                        Text("peak ${rate(s.peakDown)}", color = Snake.Fg3, fontSize = 11.sp)
                    }
                    Column(Modifier.weight(1f)) {
                        Text("▲ Upload", color = Snake.Fg2, fontSize = 12.sp)
                        Text(rate(s.up), color = Up, fontSize = 24.sp, fontWeight = FontWeight.Bold, fontFamily = Mono)
                        Text("peak ${rate(s.peakUp)}", color = Snake.Fg3, fontSize = 11.sp)
                    }
                }
                Spacer(Modifier.height(8.dp))
                SpeedGraph(s.histDown, s.histUp, Modifier.fillMaxWidth().height(170.dp))
                Text("last 2 minutes · since opened: ▼ ${size(s.totalDown)}  ▲ ${size(s.totalUp)}",
                    color = Snake.Fg3, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
                if (s.vpnOn) {
                    Text("A VPN is on, so these totals count its traffic as well as Wi-Fi or mobile data.",
                        color = Snake.Warning, fontSize = 11.sp, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
        item {
            SnakeCard {
                SectionLabel("Connections")
                Line("Wi-Fi", if (s.wifiOn) "connected" else "off", if (s.wifiOn) Snake.Highlight else Snake.Fg3)
                s.wifi?.let { w ->
                    val quality = (2 * (w.rssi + 100)).coerceIn(0, 100)
                    Line("  Network", w.ssid ?: "name hidden", Snake.Fg)
                    Line("  Signal", "${w.rssi} dBm · $quality%", Snake.Fg)
                    if (w.rxLink > 0 || w.txLink > 0) Line("  Link", "▼ ${w.rxLink} / ▲ ${w.txLink} Mb/s", Snake.Fg)
                    if (w.freq > 0) Line("  Band", if (w.freq >= 5925) "6 GHz" else if (w.freq >= 4900) "5 GHz" else "2.4 GHz", Snake.Fg)
                    if (w.ssid == null && ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                        TextButton({ askLocation.launch(Manifest.permission.ACCESS_FINE_LOCATION) }) {
                            Text("Show network name", color = Snake.Highlight)
                        }
                        Text("Android shows Wi-Fi names only to apps with location access.", color = Snake.Fg3, fontSize = 11.sp)
                    }
                }
                Line("Mobile data", if (s.mobileOn) "▼ ${rate(s.mobileDown)}  ▲ ${rate(s.mobileUp)}" else "off",
                    if (s.mobileOn) Snake.Fg else Snake.Fg3)
                val other = (s.down - s.mobileDown).coerceAtLeast(0.0) to (s.up - s.mobileUp).coerceAtLeast(0.0)
                Line("Wi-Fi and other", "▼ ${rate(other.first)}  ▲ ${rate(other.second)}", Snake.Fg)
                Line("VPN", if (s.vpnOn) "on" else "off", if (s.vpnOn) Snake.Info else Snake.Fg3)
            }
        }
    }
}

@Composable
private fun Line(label: String, value: String, color: Color) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(label, color = Snake.Fg2, modifier = Modifier.weight(1f))
        Text(value, color = color, fontFamily = Mono, fontSize = 13.sp)
    }
}

/** Download grows up from the middle, upload down, each on its own scale: like the desktop. */
@Composable
fun SpeedGraph(down: List<Double>, up: List<Double>, modifier: Modifier) {
    Canvas(modifier.clip(RoundedCornerShape(6.dp)).background(Snake.Input)) {
        val mid = size.height / 2
        drawLine(Snake.Border2, Offset(0f, mid), Offset(size.width, mid))
        fun niceMax(v: Double): Double {
            val m = maxOf(v, 1000.0)
            var p = 1.0
            while (p * 10 <= m) p *= 10
            for (k in listOf(1.0, 2.0, 5.0, 10.0)) if (k * p >= m) return k * p
            return 10 * p
        }
        fun area(data: List<Double>, upward: Boolean, color: Color) {
            if (data.size < 2) return
            val max = niceMax(data.max())
            val step = size.width / (data.size - 1)
            val line = Path()
            val fill = Path().apply { moveTo(0f, mid) }
            data.forEachIndexed { i, v ->
                val h = (v / max).coerceAtMost(1.0).toFloat() * (mid - 2)
                val y = if (upward) mid - h else mid + h
                if (i == 0) line.moveTo(0f, y) else line.lineTo(i * step, y)
                fill.lineTo(i * step, y)
            }
            fill.lineTo(size.width, mid); fill.close()
            drawPath(fill, Brush.verticalGradient(
                if (upward) listOf(color.copy(alpha = .8f), color.copy(alpha = .12f)) else listOf(color.copy(alpha = .12f), color.copy(alpha = .8f)),
                startY = if (upward) 0f else mid, endY = if (upward) mid else size.height))
            drawPath(line, color, style = Stroke(width = 3f))
        }
        area(down, true, Down)
        area(up, false, Up)
    }
}

// ====================================================================== Apps
@Composable
private fun AppsTab(model: NetModel) {
    val ctx = LocalContext.current
    val live by Live.state.collectAsState()
    val usage by model.usage.collectAsState()
    var days by rememberSaveable { mutableIntStateOf(1) }
    var access by remember { mutableStateOf(model.hasUsageAccess()) }
    val names = remember { AppNames(ctx.packageManager) }
    var expanded by remember { mutableStateOf<Int?>(null) }
    val askVpn = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (VpnService.prepare(ctx) == null) CaptureService.start(ctx)
    }
    var confirm by remember { mutableStateOf(false) }

    LaunchedEffect(days, access) { model.loadUsage(days) }
    // Coming back from Settings: check usage access again.
    androidx.lifecycle.compose.LifecycleResumeEffect(Unit) {
        access = model.hasUsageAccess()
        onPauseOrDispose { }
    }

    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Start live capture?") },
            text = {
                Text("Snake's Net becomes a VPN on this phone, so it sees every app's connections and speeds as they happen. " +
                    "Nothing is sent anywhere else: each connection goes on to where it was going.\n\n" +
                    "Android allows one VPN at a time: Tailscale (or another VPN) turns off while this runs. " +
                    "Ping doesn't work during capture.")
            },
            confirmButton = {
                TextButton({
                    confirm = false
                    val intent = VpnService.prepare(ctx)
                    if (intent != null) askVpn.launch(intent) else CaptureService.start(ctx)
                }) { Text("Start", color = Snake.Highlight) }
            },
            dismissButton = { TextButton({ confirm = false }) { Text("Cancel", color = Snake.Fg2) } },
            containerColor = Snake.Widget,
        )
    }

    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            SnakeCard {
                SectionLabel("Live")
                if (!live.running) {
                    Text("See which apps are using the network right now, with their speeds and connections.",
                        color = Snake.Fg2, fontSize = 13.sp)
                    live.error?.let { Text(it, color = Snake.ErrorSoft, fontSize = 12.sp) }
                    Spacer(Modifier.height(8.dp))
                    PrimaryButton("Start live capture", { confirm = true })
                } else {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("▼ ${rate(live.down)}   ▲ ${rate(live.up)}", color = Snake.Fg, fontFamily = Mono)
                            Text("${live.apps.size} apps · Tailscale is off while this runs", color = Snake.Fg3, fontSize = 11.sp)
                        }
                        SecondaryButton("Stop", { CaptureService.stop(ctx) })
                    }
                }
            }
        }
        if (live.running || live.apps.isNotEmpty()) {
            if (live.apps.isEmpty()) item { EmptyState("Waiting for traffic…") }
            items(live.apps, key = { "live-${it.uid}" }) { a ->
                LiveAppRow(a, names, expanded == a.uid) { expanded = if (expanded == a.uid) null else a.uid }
            }
            if (live.types.isNotEmpty()) item { TypesCard(live) }
        }
        item {
            SnakeCard {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SectionLabel("Usage", Modifier.weight(1f))
                    if (access) IconButton({ model.loadUsage(days) }) { Icon(Icons.Default.Refresh, "Refresh", tint = Snake.Fg2) }
                }
                if (!access) {
                    Text("Android keeps how much data each app used. Snake's Net needs usage access to show it.",
                        color = Snake.Fg2, fontSize = 13.sp)
                    Spacer(Modifier.height(8.dp))
                    PrimaryButton("Allow usage access", {
                        ctx.startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
                    })
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        ChoiceChip("Today", days == 1, { days = 1 })
                        ChoiceChip("7 days", days == 7, { days = 7 })
                        ChoiceChip("30 days", days == 30, { days = 30 })
                    }
                }
            }
        }
        if (access) {
            val list = usage
            if (list == null) item { EmptyState("Loading…") }
            else if (list.isEmpty()) item { EmptyState("No data used yet.") }
            else {
                val max = list.first().total.coerceAtLeast(1)
                items(list.take(80), key = { "use-${it.uid}" }) { u -> UsageRow(u, names, max) }
            }
        }
    }
}

@Composable
private fun AppIcon(uid: Int, names: AppNames) {
    val icon = remember(uid) { names.icon(uid)?.toBitmap(64, 64)?.asImageBitmap() }
    if (icon != null) Image(icon, null, Modifier.size(32.dp))
    else Box(Modifier.size(32.dp).clip(RoundedCornerShape(8.dp)).background(Snake.Button2))
}

@Composable
private fun LiveAppRow(a: LiveApp, names: AppNames, open: Boolean, onClick: () -> Unit) {
    SnakeCard(onClick = onClick, padding = 10.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AppIcon(a.uid, names)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(names.name(a.uid), color = Snake.Fg, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("${a.service} · ${a.conns.size} connection${if (a.conns.size == 1) "" else "s"} · ${size(a.recv + a.sent)}",
                    color = Ports.colors[a.category] ?: Snake.Fg2, fontSize = 11.sp, maxLines = 1)
            }
            Column(horizontalAlignment = Alignment.End) {
                Text("▼ ${rate(a.down)}", color = if (a.down > 0) Down else Snake.Fg3, fontFamily = Mono, fontSize = 12.sp)
                Text("▲ ${rate(a.up)}", color = if (a.up > 0) Up else Snake.Fg3, fontFamily = Mono, fontSize = 12.sp)
            }
        }
        if (open) {
            Spacer(Modifier.height(6.dp))
            a.conns.take(30).forEach { c ->
                Row(Modifier.fillMaxWidth().padding(vertical = 2.dp)) {
                    Text("${c.proto.uppercase()} ${c.remote.hostAddress}:${c.port}", color = if (c.open) Snake.Fg2 else Snake.Fg3,
                        fontFamily = Mono, fontSize = 11.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(c.service, color = Ports.colors[c.category] ?: Snake.Fg2, fontSize = 11.sp)
                    Spacer(Modifier.width(8.dp))
                    Text(rate(c.down + c.up), color = Snake.Fg2, fontFamily = Mono, fontSize = 11.sp)
                }
            }
        }
    }
}

@Composable
private fun TypesCard(live: LiveState) {
    SnakeCard {
        SectionLabel("Traffic by type")
        val total = live.types.sumOf { it.total }.coerceAtLeast(1)
        live.types.forEach { t ->
            val color = Ports.colors[t.category] ?: Snake.Fg2
            Row(Modifier.fillMaxWidth().padding(vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(t.category, color = color, modifier = Modifier.width(80.dp), fontSize = 12.sp)
                Box(Modifier.weight(1f).height(10.dp)) {
                    Box(Modifier.fillMaxWidth((t.total.toFloat() / total).coerceIn(0.02f, 1f)).height(10.dp)
                        .clip(RoundedCornerShape(3.dp)).background(color))
                }
                Text(size(t.total), color = Snake.Fg2, fontFamily = Mono, fontSize = 11.sp, modifier = Modifier.padding(start = 8.dp))
            }
        }
    }
}

@Composable
private fun UsageRow(u: AppUsage, names: AppNames, max: Long) {
    SnakeCard(padding = 10.dp) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AppIcon(u.uid, names)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(names.name(u.uid), color = Snake.Fg, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Wi-Fi ${size(u.wifiDown + u.wifiUp)} · mobile ${size(u.mobileDown + u.mobileUp)}", color = Snake.Fg3, fontSize = 11.sp)
                Spacer(Modifier.height(4.dp))
                Box(Modifier.fillMaxWidth((u.total.toFloat() / max).coerceIn(0.02f, 1f)).height(4.dp)
                    .clip(RoundedCornerShape(2.dp)).background(Snake.Accent))
            }
            Spacer(Modifier.width(10.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(size(u.total), color = Snake.Fg, fontFamily = Mono, fontSize = 13.sp)
                Text("▼ ${size(u.wifiDown + u.mobileDown)}", color = Down, fontFamily = Mono, fontSize = 11.sp)
            }
        }
    }
}

// ====================================================================== Computers
@Composable
private fun ComputersTab(model: NetModel, onOpen: (Computer) -> Unit) {
    val list by model.computers.collectAsState()
    var adding by remember { mutableStateOf(false) }
    if (adding) AddComputer({ adding = false }) { name, addr -> model.addComputer(name, addr); adding = false }
    LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            SnakeCard {
                SectionLabel("Your computers")
                Text("Watch a computer's Snake's Net from here. On the computer, press w in Snake's Net " +
                    "(or run snakes-net --headless). It shows the address to add here, " +
                    "like 100.101.102.103 or its Tailscale name. Tailscale must be on for this phone.",
                    color = Snake.Fg2, fontSize = 13.sp)
                Spacer(Modifier.height(8.dp))
                PrimaryButton("Add a computer", { adding = true }, icon = Icons.Default.Add)
            }
        }
        if (list.isEmpty()) item { EmptyState("No computers yet.") }
        items(list, key = { it.url }) { c ->
            SnakeCard(onClick = { onOpen(c) }, padding = 12.dp) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Computer, null, tint = Snake.Highlight)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(c.name, color = Snake.Fg, fontWeight = FontWeight.Bold)
                        Text(c.url, color = Snake.Fg3, fontSize = 11.sp, fontFamily = Mono)
                    }
                    IconButton({ model.removeComputer(c) }) { Icon(Icons.Default.Delete, "Remove", tint = Snake.Fg3) }
                }
            }
        }
    }
}

@Composable
private fun AddComputer(onDismiss: () -> Unit, onAdd: (String, String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var addr by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Add a computer") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Name (optional)") }, singleLine = true)
                OutlinedTextField(addr, { addr = it }, label = { Text("Address") }, placeholder = { Text("mainrig or 100.x.y.z") },
                    singleLine = true)
            }
        },
        confirmButton = {
            TextButton({ onAdd(name, addr) }, enabled = computerUrl(addr) != null) { Text("Add", color = Snake.Highlight) }
        },
        dismissButton = { TextButton(onDismiss) { Text("Cancel", color = Snake.Fg2) } },
        containerColor = Snake.Widget,
    )
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun ComputerView(c: Computer, onClose: () -> Unit) {
    BackHandler(onBack = onClose)
    var failed by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().background(Color(0xFF0B0F0C))) {
        Row(Modifier.fillMaxWidth().background(Snake.Title).statusBarsPadding().padding(start = 4.dp, end = 12.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClose) { Icon(Icons.Default.Close, "Close", tint = Snake.Fg) }
            Text(c.name, color = Snake.Fg, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            Text(c.url.removePrefix("http://"), color = Snake.Fg3, fontSize = 11.sp, fontFamily = Mono)
        }
        failed?.let {
            Text("Can't reach ${c.name}: $it. Is Tailscale on here, and Snake's Net sharing (w) on the computer?",
                color = Snake.ErrorSoft, fontSize = 12.sp, modifier = Modifier.padding(12.dp))
        }
        AndroidView(
            factory = { ctx ->
                WebView(ctx).apply {
                    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
                    setBackgroundColor(0xFF0B0F0C.toInt())
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    webViewClient = object : WebViewClient() {
                        override fun onReceivedError(view: WebView, request: android.webkit.WebResourceRequest,
                                                     error: android.webkit.WebResourceError) {
                            if (request.isForMainFrame) failed = error.description?.toString() ?: "no answer"
                        }
                    }
                    loadUrl(c.url)
                }
            },
            modifier = Modifier.fillMaxSize().navigationBarsPadding(),
        )
    }
}
