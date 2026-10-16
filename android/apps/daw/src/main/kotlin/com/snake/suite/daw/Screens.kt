package com.snake.suite.daw

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.filled.ContentCut
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FiberManualRecord
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Redo
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Undo
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.snake.suite.core.ChoiceChip
import com.snake.suite.core.FlatButton
import com.snake.suite.core.PrimaryButton
import com.snake.suite.core.SecondaryButton
import com.snake.suite.core.SectionLabel
import com.snake.suite.core.Snake
import com.snake.suite.core.SnakeCard
import com.snake.suite.core.SnakeProgress
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.roundToInt

private val sliderColors @Composable get() = SliderDefaults.colors(thumbColor = Snake.Accent, activeTrackColor = Snake.Accent, inactiveTrackColor = Snake.Border2)

// ------------------------------------------------------------------ transport

@Composable
fun TransportBar(model: DawModel, s: Snapshot, view: ViewPrefs, onProjects: () -> Unit, onSettings: () -> Unit, onView: () -> Unit) {
    var bpmDialog by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().background(Snake.Title).padding(start = 8.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).horizontalScroll(rememberScrollState()),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            RoundButton(if (s.playing) Icons.Default.Stop else Icons.Default.PlayArrow, if (s.playing) Snake.Fg else Snake.Accent) { model.op("play") }
            RoundButton(Icons.Default.FiberManualRecord, if (s.recording) Color.White else RED, if (s.recording) RED else Snake.Button2) { model.op("record") }
            if (view.showTransportExtras) {
                IconButton({ model.op("seek", "pos" to 0) }) { Text("⏮", color = Snake.Fg2, fontSize = 18.sp) }
                Box(Modifier.clip(RoundedCornerShape(6.dp)).background(Snake.Button2).clickable { bpmDialog = true }.padding(10.dp, 6.dp)) {
                    Text("${s.bpm.roundToInt()} bpm  ${s.beatsPerBar}/4", fontSize = 13.sp)
                }
                ChoiceChip("Click", s.metronome, { model.project("metronome", !s.metronome) })
                ChoiceChip("Count-in", s.countIn, { model.project("count_in", !s.countIn) })
                ChoiceChip("Loop", s.loopOn, { model.project("loop_on", !s.loopOn) })
                IconButton({ model.op("undo") }) { Icon(Icons.Default.Undo, "Undo", tint = Snake.Fg2) }
                IconButton({ model.op("redo") }) { Icon(Icons.Default.Redo, "Redo", tint = Snake.Fg2) }
            }
            if (view.showMeters) Meter(s.master, Modifier.width(70.dp).height(10.dp))
        }
        Box {
            IconButton({ menu = true }) { Icon(Icons.Default.MoreVert, "Menu", tint = Snake.Fg2) }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem({ Text("Projects and export") }, { menu = false; onProjects() })
                DropdownMenuItem({ Text("Audio settings") }, { menu = false; onSettings() })
                DropdownMenuItem({ Text("Tempo") }, { menu = false; bpmDialog = true })
                if (!view.showTransportExtras) {
                    DropdownMenuItem({ Text(if (s.metronome) "Click off" else "Click on") }, { menu = false; model.project("metronome", !s.metronome) })
                    DropdownMenuItem({ Text(if (s.loopOn) "Loop off" else "Loop on") }, { menu = false; model.project("loop_on", !s.loopOn) })
                    DropdownMenuItem({ Text("Undo") }, { menu = false; model.op("undo") })
                    DropdownMenuItem({ Text("Redo") }, { menu = false; model.op("redo") })
                }
                DropdownMenuItem({ Text("View...") }, { menu = false; onView() })
            }
        }
    }
    if (bpmDialog) TempoDialog(model, s) { bpmDialog = false }
}

@Composable
private fun RoundButton(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color, bg: Color = Snake.Button2, onClick: () -> Unit) {
    Box(Modifier.size(44.dp).clip(CircleShape).background(bg).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, null, tint = tint)
    }
}

@Composable
private fun TempoDialog(model: DawModel, s: Snapshot, onDismiss: () -> Unit) {
    var bpm by remember { mutableStateOf(s.bpm) }
    var taps by remember { mutableStateOf(listOf<Long>()) }
    AlertDialog(
        onDismissRequest = onDismiss, containerColor = Snake.Widget,
        title = { Text("Tempo") },
        text = {
            Column {
                Text("${bpm.roundToInt()} bpm", fontSize = 28.sp, fontWeight = FontWeight.Light)
                Slider(bpm, { bpm = it; model.project("bpm", it.roundToInt()) }, valueRange = 40f..240f, colors = sliderColors)
                SecondaryButton("Tap tempo", {
                    val now = System.currentTimeMillis()
                    taps = (taps + now).filter { now - it < 3000 }.takeLast(6)
                    if (taps.size >= 3) {
                        val avg = (taps.last() - taps.first()).toDouble() / (taps.size - 1)
                        bpm = (60_000 / avg).toFloat().coerceIn(40f, 240f)
                        model.project("bpm", bpm.roundToInt())
                    }
                })
                Spacer(Modifier.height(12.dp))
                SectionLabel("Beats per bar")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(2, 3, 4, 5, 6, 7).forEach { n -> ChoiceChip("$n", s.beatsPerBar == n, { model.project("beats_per_bar", n) }) }
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Done") } },
    )
}

// ------------------------------------------------------------------ edit bar under the timeline

@Composable
fun EditBar(model: DawModel, s: Snapshot) {
    var addMenu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().background(Snake.Side).horizontalScroll(rememberScrollState()).padding(horizontal = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box {
            FlatButton("Track", { addMenu = true }, icon = Icons.Default.Add)
            DropdownMenu(addMenu, { addMenu = false }) {
                DropdownMenuItem({ Text("Guitar (amp and effects)") }, { addMenu = false; model.op("add_track", "preset" to "guitar") })
                DropdownMenuItem({ Text("Microphone (vocals)") }, { addMenu = false; model.op("add_track", "preset" to "mic") })
                DropdownMenuItem({ Text("Empty audio track") }, { addMenu = false; model.op("add_track", "preset" to "empty") })
            }
        }
        FlatButton("Split", { model.op("split") }, icon = Icons.Default.ContentCut)
        FlatButton("Duplicate", { model.op("duplicate") }, icon = Icons.Default.ContentCopy, enabled = s.selClip != null)
        FlatButton("Delete", { model.op("delete") }, icon = Icons.Default.Delete, enabled = s.selClip != null, color = Snake.ErrorSoft)
    }
}

// ------------------------------------------------------------------ track settings

@Composable
fun TrackDialog(model: DawModel, s: Snapshot, t: Track, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf(t.name) }
    val live = s.tracks.firstOrNull { it.id == t.id } ?: t
    AlertDialog(
        onDismissRequest = { model.track(t.id, "name", name); onDismiss() }, containerColor = Snake.Widget,
        title = { Text("Track") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(name, { name = it }, label = { Text("Name") }, singleLine = true)
                SectionLabel("Volume · ${"%.1f".format(live.volumeDb)} dB")
                Slider(live.volumeDb, { model.track(t.id, "volume_db", it.toDouble()) }, valueRange = -60f..12f, colors = sliderColors)
                SectionLabel("Pan · ${if (live.pan == 0f) "centre" else if (live.pan < 0) "L ${(-live.pan * 100).roundToInt()}" else "R ${(live.pan * 100).roundToInt()}"}")
                Slider(live.pan, { model.track(t.id, "pan", it.toDouble()) }, valueRange = -1f..1f, colors = sliderColors)
                SectionLabel("Input")
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    (0 until s.inputsAvailable.coerceAtLeast(1)).forEach { i ->
                        ChoiceChip("Input ${i + 1}", live.input == i, { model.track(t.id, "input", i) })
                    }
                    ChoiceChip("None", live.input == null, { model.track(t.id, "input", -1) })
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Effects on", Modifier.weight(1f))
                    Switch(live.fxOn, { model.track(t.id, "fx_on", it) }, colors = SwitchDefaults.colors(checkedTrackColor = Snake.Accent))
                }
            }
        },
        confirmButton = { TextButton({ model.track(t.id, "name", name); onDismiss() }) { Text("Done") } },
        dismissButton = { TextButton({ model.op("remove_track", "id" to t.id); onDismiss() }) { Text("Remove track", color = Snake.ErrorSoft) } },
    )
}

// ------------------------------------------------------------------ effects

@Composable
fun EffectsScreen(model: DawModel, s: Snapshot) {
    val t = s.tracks.firstOrNull { it.id == s.selTrack } ?: s.tracks.firstOrNull()
    var addMenu by remember { mutableStateOf(false) }
    if (t == null) {
        Text("Add a track first.", Modifier.padding(20.dp), color = Snake.Fg2)
        return
    }
    LazyColumn(Modifier.fillMaxSize().padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(t.name, style = MaterialTheme.typography.titleMedium)
                    Text(if (t.fxOn) "Effects on (recordings stay clean)" else "Effects off for this track", color = Snake.Fg2,
                        style = MaterialTheme.typography.bodySmall)
                }
                Switch(t.fxOn, { model.track(t.id, "fx_on", it) }, colors = SwitchDefaults.colors(checkedTrackColor = Snake.Accent))
            }
            Spacer(Modifier.height(6.dp))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                s.tracks.forEach { other -> ChoiceChip(other.name, other.id == t.id, { model.op("select", "track" to other.id) }) }
            }
        }
        items(t.fx, key = { it.id }) { fx -> EffectCard(model, s, t, fx) }
        item {
            Box {
                PrimaryButton("Add effect", { addMenu = true }, icon = Icons.Default.Add)
                DropdownMenu(addMenu, { addMenu = false }) {
                    model.fxKinds.forEach { (kind, name) ->
                        DropdownMenuItem({ Text(name) }, { addMenu = false; model.op("add_fx", "track" to t.id, "kind" to kind) })
                    }
                }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun EffectCard(model: DawModel, s: Snapshot, t: Track, fx: Fx) {
    val info = s.fxInfo[fx.id]
    SnakeCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Switch(!fx.bypass, { model.op("fx", "fx" to fx.id, "bypass" to !it) }, colors = SwitchDefaults.colors(checkedTrackColor = Snake.Accent))
            Spacer(Modifier.width(10.dp))
            Text(info?.first ?: fx.kind, Modifier.weight(1f), fontWeight = FontWeight.SemiBold, color = if (fx.bypass) Snake.Fg3 else Snake.Fg)
            IconButton({ model.op("move_fx", "track" to t.id, "fx" to fx.id, "by" to -1) }) { Icon(Icons.Default.ArrowUpward, "Earlier", tint = Snake.Fg2) }
            IconButton({ model.op("move_fx", "track" to t.id, "fx" to fx.id, "by" to 1) }) { Icon(Icons.Default.ArrowDownward, "Later", tint = Snake.Fg2) }
            IconButton({ model.op("remove_fx", "track" to t.id, "fx" to fx.id) }) { Icon(Icons.Default.Delete, "Remove", tint = Snake.ErrorSoft) }
        }
        info?.second?.forEachIndexed { i, p ->
            val v = fx.params.getOrElse(i) { p.default }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(p.name, Modifier.width(96.dp), color = Snake.Fg2, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                ParamSlider(p, v, Modifier.weight(1f)) { model.op("fx", "fx" to fx.id, "index" to i, "value" to it.toDouble()) }
                Text(formatParam(p, v), Modifier.width(72.dp), textAlign = TextAlign.End, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

/** A slider in the parameter's own scale: logarithmic for frequencies and times, stepped where it has steps. */
@Composable
private fun ParamSlider(p: FxParam, value: Float, modifier: Modifier, onChange: (Float) -> Unit) {
    val toPos: (Float) -> Float = { v ->
        if (p.log && p.min > 0) ((ln(v) - ln(p.min)) / (ln(p.max) - ln(p.min))) else (v - p.min) / (p.max - p.min)
    }
    val fromPos: (Float) -> Float = { x ->
        var v = if (p.log && p.min > 0) exp(ln(p.min) + x * (ln(p.max) - ln(p.min))) else p.min + x * (p.max - p.min)
        if (p.step > 0) v = (Math.round(v / p.step) * p.step)
        v.coerceIn(p.min, p.max)
    }
    Slider(toPos(value).coerceIn(0f, 1f), { onChange(fromPos(it)) }, modifier, colors = sliderColors)
}

private fun formatParam(p: FxParam, v: Float): String {
    val n = when {
        p.step >= 1f -> v.roundToInt().toString()
        kotlin.math.abs(v) >= 100 -> v.roundToInt().toString()
        kotlin.math.abs(v) >= 10 -> "%.1f".format(v)
        else -> "%.2f".format(v)
    }
    return if (p.unit.isEmpty()) n else "$n ${p.unit}"
}

// ------------------------------------------------------------------ loop station

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
fun LooperScreen(model: DawModel, s: Snapshot) {
    var menuSlot by remember { mutableStateOf<Int?>(null) }
    val lp = s.looper
    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ChoiceChip("Count-in", lp.countIn, { model.op("looper", "countIn" to !lp.countIn) })
            ChoiceChip("Click", lp.click, { model.op("looper", "click" to !lp.click) })
            Spacer(Modifier.weight(1f))
            if (lp.len > 0) Text("%.1f s".format(s.seconds(lp.len)), color = Snake.Fg2)
            FlatButton("Clear all", { (0 until 4).forEach { model.op("loop", "slot" to it, "action" to "clear") } }, color = Snake.ErrorSoft)
        }
        if (lp.len > 0) {
            Spacer(Modifier.height(8.dp))
            SnakeProgress(lp.pos.toFloat() / lp.len)
        }
        Spacer(Modifier.height(12.dp))
        LazyVerticalGrid(GridCells.Fixed(2), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(4) { slot ->
                val st = lp.state.getOrElse(slot) { 0 }
                val (label, color) = when (st) {
                    Looper.COUNTING -> "Count-in…\ntap to cancel" to YELLOW
                    Looper.RECORDING -> "Recording\ntap to play" to RED
                    Looper.PLAYING -> "Playing\ntap to overdub" to GREEN
                    Looper.OVERDUB -> "Overdubbing\ntap to finish" to ORANGE
                    Looper.STOPPED -> "Muted\ntap to play" to Color(110, 110, 110)
                    else -> "Empty\ntap to record" to Snake.Fg3
                }
                val sources = s.loopSources.getOrElse(slot) { emptyList() }.mapNotNull { id -> s.tracks.firstOrNull { it.id == id }?.name }
                Column(
                    Modifier.aspectRatio(1f).clip(RoundedCornerShape(14.dp)).background(color.copy(alpha = 0.18f))
                        .border(2.dp, color, RoundedCornerShape(14.dp))
                        .combinedClickable(onClick = { model.op("loop", "slot" to slot, "action" to "press") }, onLongClick = { menuSlot = slot })
                        .padding(12.dp),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
                ) {
                    Text("${slot + 1}", fontSize = 32.sp, fontWeight = FontWeight.Light, color = color)
                    Text(label, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodySmall)
                    Spacer(Modifier.height(4.dp))
                    Text(sources.joinToString().ifEmpty { "selected track" }, color = Snake.Fg3, style = MaterialTheme.typography.labelSmall,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        Text("Hold a loop for mute, clear, volume and the tracks it records.", color = Snake.Fg3, style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(top = 8.dp))
    }
    menuSlot?.let { slot -> LoopDialog(model, s, slot) { menuSlot = null } }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun LoopDialog(model: DawModel, s: Snapshot, slot: Int, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss, containerColor = Snake.Widget,
        title = { Text("Loop ${slot + 1}") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton("Mute / play", { model.op("loop", "slot" to slot, "action" to "stop") })
                    SecondaryButton("Clear", { model.op("loop", "slot" to slot, "action" to "clear") })
                }
                SectionLabel("Volume")
                Slider(s.looper.gain.getOrElse(slot) { 1f }, { model.op("looper", "slot" to slot, "gain" to it.toDouble()) }, valueRange = 0f..1.5f, colors = sliderColors)
                SectionLabel("Records these tracks")
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    s.tracks.forEach { t ->
                        val on = t.id in s.loopSources.getOrElse(slot) { emptyList() }
                        ChoiceChip(t.name, on, { model.op("loop_source", "slot" to slot, "track" to t.id, "on" to !on) })
                    }
                }
                if (s.loopEnd > s.loopStart) {
                    SectionLabel("Load the timeline's loop region")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        s.tracks.forEach { t -> SecondaryButton(t.name, { model.op("loop_import", "slot" to slot, "track" to t.id); onDismiss() }) }
                    }
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Done") } },
    )
}

// ------------------------------------------------------------------ tuner

@Composable
fun TunerScreen(model: DawModel, s: Snapshot) {
    DisposableEffect(Unit) {
        model.op("tuner", "on" to true)
        onDispose { model.op("tuner", "on" to false) }
    }
    val r = s.tuner
    Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        val inTune = r != null && kotlin.math.abs(r.third) < 5
        Text(r?.first ?: "–", fontSize = 96.sp, fontWeight = FontWeight.Light, color = if (inTune) GREEN else Snake.Fg)
        Text(r?.let { "%.1f Hz".format(it.second) } ?: "Play a note", color = Snake.Fg2)
        Spacer(Modifier.height(24.dp))
        Canvas(Modifier.fillMaxWidth().height(80.dp)) {
            val mid = size.width / 2
            for (c in -50..50 step 10) {
                val x = mid + c / 50f * (size.width / 2 - 8)
                drawLine(if (c == 0) GREEN else Snake.Fg3, Offset(x, size.height * (if (c == 0) 0.1f else 0.35f)), Offset(x, size.height * 0.9f), if (c == 0) 3f else 1.5f)
            }
            if (r != null) {
                val x = mid + r.third.coerceIn(-50f, 50f) / 50f * (size.width / 2 - 8)
                drawLine(if (inTune) GREEN else ORANGE, Offset(x, 0f), Offset(x, size.height), 6f, cap = StrokeCap.Round)
            }
        }
        Text(r?.let { "%+.0f cents".format(it.third) } ?: "", color = Snake.Fg2)
        Spacer(Modifier.height(24.dp))
        Text("Listens to the selected track's input, from about 28 Hz up.", color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
    }
}

// ------------------------------------------------------------------ projects and settings

@Composable
fun ProjectsDialog(model: DawModel, s: Snapshot, onDismiss: () -> Unit) {
    var name by remember { mutableStateOf("") }
    val projects = remember { model.projects() }
    AlertDialog(
        onDismissRequest = onDismiss, containerColor = Snake.Widget,
        title = { Text("Projects") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(name, { name = it }, Modifier.weight(1f), placeholder = { Text("New project name") }, singleLine = true)
                    Spacer(Modifier.width(8.dp))
                    PrimaryButton("New", { model.op("new_project", "name" to name.ifBlank { "Session" }); onDismiss() })
                }
                SectionLabel("Open")
                LazyColumn(Modifier.height(260.dp)) {
                    items(projects) { (path, n) ->
                        Text(n, Modifier.fillMaxWidth().clickable { model.op("open_project", "path" to path); onDismiss() }.padding(vertical = 10.dp),
                            color = if (path == s.dir) Snake.Highlight else Snake.Fg)
                    }
                }
                SecondaryButton("Export mixdown (WAV)", { model.op("export"); onDismiss() }, enabled = s.export == null)
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Close") } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SettingsDialog(model: DawModel, s: Snapshot, onDismiss: () -> Unit) {
    val a = s.audio
    var restart by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss, containerColor = Snake.Widget,
        title = { Text("Audio") },
        text = {
            LazyColumn(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                item {
                    Text("${a.output ?: "?"} · ${s.sr} Hz · ${s.buffer} frames", color = Snake.Fg2, style = MaterialTheme.typography.bodySmall)
                    Text("Input: ${a.input ?: "none"}" + (a.inputProblem?.let { " ($it)" } ?: ""), color = if (a.inputProblem != null) Snake.Warning else Snake.Fg2,
                        style = MaterialTheme.typography.bodySmall)
                    Text("CPU ${s.cpu.roundToInt()}% · ${s.xruns} dropouts · round trip ${"%.0f".format(s.latency * 1000.0 / s.sr.coerceAtLeast(1))} ms",
                        color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
                }
                item {
                    SectionLabel("Buffer size (smaller = less delay, more crackle risk)")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf(64, 128, 192, 256, 512, 1024).forEach { n ->
                            ChoiceChip("$n", a.bufferSize == n, { model.op("settings", "bufferSize" to n); restart = true })
                        }
                    }
                }
                item {
                    SectionLabel("Input device")
                    DeviceChoices(a.inputDevices, a.deviceIn) { model.op("settings", "deviceIn" to it); restart = true }
                    SectionLabel("Output device")
                    DeviceChoices(a.outputDevices, a.deviceOut) { model.op("settings", "deviceOut" to it); restart = true }
                }
                item {
                    SectionLabel("Recording offset · ${"%.0f".format(a.recOffsetMs)} ms")
                    Slider(a.recOffsetMs, { model.op("settings", "recOffsetMs" to it.toDouble()) }, valueRange = -100f..200f, colors = sliderColors)
                    Text("Shifts new takes earlier when they sound late against the backing.", color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            TextButton({ if (restart) model.restartAudio(); onDismiss() }) { Text(if (restart) "Apply (restarts audio)" else "Done") }
        },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DeviceChoices(devices: List<Pair<String, String>>, chosen: String, onPick: (String) -> Unit) {
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ChoiceChip("System default", chosen.isEmpty(), { onPick("") })
        devices.forEach { (id, name) -> ChoiceChip(name, chosen == id, { onPick(id) }) }
    }
}
