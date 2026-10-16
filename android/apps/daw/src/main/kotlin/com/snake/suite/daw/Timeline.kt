package com.snake.suite.daw

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import com.snake.suite.core.zoomsItself
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.snake.suite.core.Snake
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max

/** Track colours, as in the desktop DAW (ui.rs COLORS). */
val TRACK_COLORS = listOf(
    Color(86, 156, 214), Color(214, 143, 86), Color(120, 190, 110), Color(190, 120, 200),
    Color(210, 190, 90), Color(90, 195, 195), Color(215, 110, 130), Color(150, 150, 220),
)
val RED = Color(225, 70, 70)
val GREEN = Color(80, 200, 110)
val YELLOW = Color(230, 200, 70)
val ORANGE = Color(235, 150, 60)

/** What part of the timeline is on screen: seconds at the left edge and pixels per second. */
class TimelineView {
    var scroll by mutableFloatStateOf(0f)
    var pxPerSec by mutableFloatStateOf(60f)
    fun x(seconds: Double) = ((seconds - scroll) * pxPerSec).toFloat()
    fun sec(x: Float) = scroll + x / pxPerSec
}

private val HEADER_W = 148.dp
private val ROW_H = 86.dp
private val RULER_H = 30.dp

@Composable
fun Timeline(model: DawModel, s: Snapshot, prefs: ViewPrefs, onTrackMenu: (Track) -> Unit, modifier: Modifier = Modifier) {
    val headerW = if (prefs.showTrackButtons) HEADER_W else 104.dp
    val rowH = if (prefs.showTrackButtons || prefs.showMeters) ROW_H else 64.dp
    val view = remember { TimelineView() }
    val scroll = rememberScrollState()
    var laneWidth by remember { mutableFloatStateOf(1f) }
    // Keep the playhead in view while playing, like the desktop timeline.
    LaunchedEffect(s.pos, s.playing) {
        if (s.playing) {
            val px = view.x(s.seconds(s.pos))
            if (px > laneWidth * 0.9f || px < 0) view.scroll = (s.seconds(s.pos) - 0.1 * laneWidth / view.pxPerSec).toFloat().coerceAtLeast(0f)
        }
    }
    Column(modifier) {
        Row(Modifier.height(RULER_H)) {
            Box(Modifier.width(headerW).fillMaxHeight().background(Snake.Title), contentAlignment = Alignment.CenterStart) {
                Text(timeText(s, s.pos), Modifier.padding(start = 10.dp), color = Snake.Highlight, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
            }
            Ruler(model, s, view, Modifier.weight(1f).fillMaxHeight())
        }
        Column(Modifier.weight(1f).verticalScroll(scroll)) {
            s.tracks.forEach { t ->
                Row(Modifier.height(rowH).fillMaxWidth()) {
                    TrackHeader(model, s, t, prefs, onTrackMenu, Modifier.width(headerW).fillMaxHeight())
                    Lane(model, s, t, view, Modifier.weight(1f).fillMaxHeight()) { laneWidth = it }
                }
                Box(Modifier.fillMaxWidth().height(1.dp).background(Snake.Border))
            }
            if (s.tracks.isEmpty()) {
                Text("No tracks. Add one below.", Modifier.padding(20.dp), color = Snake.Fg2)
            }
        }
    }
}

fun timeText(s: Snapshot, frames: Long): String {
    val sec = s.seconds(frames.coerceAtLeast(0))
    val beat = frames.coerceAtLeast(0) / s.beatFrames
    val bar = floor(beat / s.beatsPerBar).toInt() + 1
    val b = floor(beat % s.beatsPerBar).toInt() + 1
    return "%d:%04.1f  %d.%d".format((sec / 60).toInt(), sec % 60, bar, b)
}

@Composable
private fun Ruler(model: DawModel, s: Snapshot, view: TimelineView, modifier: Modifier) {
    val state by rememberUpdatedState(s)
    Canvas(
        modifier
            .background(Snake.Title)
            .pointerInput(Unit) {
                detectTapGestures { model.op("seek", "pos" to (view.sec(it.x) * state.sr).toLong().coerceAtLeast(0)) }
            }
            .pointerInput(Unit) {
                // Drag along the ruler to draw the loop region (and switch looping on).
                var from = 0f
                detectDragGestures(
                    onDragStart = { from = it.x },
                    onDrag = { change, _ ->
                        val a = (view.sec(minOf(from, change.position.x)) * state.sr).toLong().coerceAtLeast(0)
                        val b = (view.sec(maxOf(from, change.position.x)) * state.sr).toLong().coerceAtLeast(0)
                        model.project("loop_start", a)
                        model.project("loop_end", b)
                        if (!state.loopOn) model.project("loop_on", true)
                    },
                )
            },
    ) {
        if (s.loopEnd > s.loopStart) {
            val a = view.x(s.seconds(s.loopStart))
            val b = view.x(s.seconds(s.loopEnd))
            drawRect(if (s.loopOn) Snake.Accent.copy(alpha = 0.35f) else Snake.Fg3.copy(alpha = 0.3f), Offset(a, 0f), Size(b - a, size.height * 0.45f))
        }
        grid(s, view) { x, isBar, bar ->
            drawLine(if (isBar) Snake.Fg2 else Snake.Fg3, Offset(x, if (isBar) size.height * 0.45f else size.height * 0.7f), Offset(x, size.height), 1f)
            if (isBar) drawContext.canvas.nativeCanvas.drawText("$bar", x + 4f, size.height - 6f, rulerPaint)
        }
        val px = view.x(s.seconds(s.pos))
        drawLine(Snake.Highlight, Offset(px, 0f), Offset(px, size.height), 2f)
    }
}

private val rulerPaint = android.graphics.Paint().apply {
    color = android.graphics.Color.rgb(0x8a, 0x97, 0x8e)
    textSize = 26f
    isAntiAlias = true
}

/** Calls [line] for each bar (and beat, when there is room) inside the visible width. */
private inline fun androidx.compose.ui.graphics.drawscope.DrawScope.grid(s: Snapshot, view: TimelineView, line: (Float, Boolean, Int) -> Unit) {
    val beatSec = 60.0 / s.bpm.coerceAtLeast(20f)
    val showBeats = beatSec * view.pxPerSec > 18
    val barSec = beatSec * s.beatsPerBar
    val everyBars = max(1, (60.0 / (barSec * view.pxPerSec)).toInt() + 1).let { if (barSec * view.pxPerSec > 40) 1 else it }
    val first = floor(view.scroll / beatSec).toLong()
    var beat = first
    while (true) {
        val x = view.x(beat * beatSec)
        if (x > size.width) break
        val isBar = beat % s.beatsPerBar == 0L
        val bar = (beat / s.beatsPerBar).toInt() + 1
        if ((isBar && (bar - 1) % everyBars == 0) || (!isBar && showBeats)) line(x, isBar, bar)
        beat++
    }
}

@Composable
private fun TrackHeader(model: DawModel, s: Snapshot, t: Track, view: ViewPrefs, onMenu: (Track) -> Unit, modifier: Modifier) {
    val selected = s.selTrack == t.id
    val color = TRACK_COLORS[t.color % TRACK_COLORS.size]
    Row(modifier.background(if (selected) Snake.Selection else Snake.Widget).clickable { model.op("select", "track" to t.id) }) {
        Box(Modifier.width(5.dp).fillMaxHeight().background(color))
        Column(Modifier.padding(start = 8.dp, top = 6.dp, end = 6.dp).weight(1f)) {
            Text(t.name, Modifier.clickable { onMenu(t) }, maxLines = 1, overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Toggle("", t.arm, RED, dot = true) { model.track(t.id, "arm", !t.arm) }
                if (view.showTrackButtons) {
                    Toggle("🎧", t.monitor, Snake.Info) { model.track(t.id, "monitor", !t.monitor) }
                    Toggle("M", t.mute, YELLOW) { model.track(t.id, "mute", !t.mute) }
                    Toggle("S", t.solo, GREEN) { model.track(t.id, "solo", !t.solo) }
                }
            }
            if (view.showMeters) {
                Spacer(Modifier.height(6.dp))
                Meter(s.meters[t.id] ?: (0f to 0f), Modifier.fillMaxWidth().height(6.dp))
            }
        }
    }
}

@Composable
fun Toggle(label: String, on: Boolean, color: Color, dot: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier.size(28.dp).clip(RoundedCornerShape(5.dp))
            .background(if (on) color.copy(alpha = 0.85f) else Snake.Button2)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        // The record-arm button is a drawn dot: the ⏺ character turns into an emoji on some phones.
        if (dot) Box(Modifier.size(12.dp).clip(androidx.compose.foundation.shape.CircleShape).background(if (on) Color.White else RED))
        else Text(label, fontSize = 12.sp, color = if (on) Color.Black else Snake.Fg2, fontWeight = FontWeight.Bold)
    }
}

/** A stereo peak meter, in dB from -60 to 0. */
@Composable
fun Meter(peaks: Pair<Float, Float>, modifier: Modifier) {
    fun frac(p: Float) = if (p <= 0.001f) 0f else ((20 * log10(p) + 60) / 60).coerceIn(0f, 1f)
    Canvas(modifier.clip(RoundedCornerShape(2.dp)).background(Snake.Input)) {
        val h = size.height / 2
        listOf(peaks.first, peaks.second).forEachIndexed { i, p ->
            val f = frac(p)
            drawRect(if (p >= 1f) RED else if (f > 0.85f) YELLOW else Snake.Accent, Offset(0f, i * h), Size(size.width * f, h - 0.5f))
        }
    }
}

@Composable
private fun Lane(model: DawModel, s: Snapshot, t: Track, view: TimelineView, modifier: Modifier, onWidth: (Float) -> Unit) {
    val state by rememberUpdatedState(s)
    val track by rememberUpdatedState(t)
    val color = TRACK_COLORS[t.color % TRACK_COLORS.size]
    Canvas(
        modifier
            .background(Snake.Bg)
            .pointerInput(Unit) {
                detectTapGestures { p ->
                    val sec = view.sec(p.x)
                    val clip = track.clips.lastOrNull { sec >= state.seconds(it.start) && sec <= state.seconds(it.start + it.len) }
                    model.op("select", "track" to track.id, "clip" to clip?.id)
                }
            }
            .zoomsItself()
            .pointerInput(Unit) {
                // One finger: drag the selected clip, or slide the view. Two fingers: pinch to zoom.
                awaitEachGesture {
                    val down = awaitFirstDown()
                    val sec = view.sec(down.position.x)
                    val sel = state.selClip
                    val clip = track.clips.firstOrNull { sel != null && sel.first == track.id && sel.second == it.id && sec >= state.seconds(it.start) && sec <= state.seconds(it.start + it.len) }
                    var moved = 0f
                    var editing = false
                    val startFrames = clip?.start ?: 0L
                    do {
                        val event = awaitPointerEvent()
                        if (event.changes.size >= 2) {
                            val zoom = event.calculateZoom()
                            val centroid = event.changes.map { it.position.x }.average().toFloat()
                            val anchor = view.sec(centroid)
                            view.pxPerSec = (view.pxPerSec * zoom).coerceIn(4f, 2000f)
                            view.scroll = (anchor - centroid / view.pxPerSec).coerceAtLeast(0f)
                            view.scroll = (view.scroll - event.calculatePan().x / view.pxPerSec).coerceAtLeast(0f)
                        } else {
                            val dx = event.changes.first().positionChange().x
                            moved += dx
                            if (clip != null) {
                                if (!editing && abs(moved) > 8f) { model.op("begin_edit"); editing = true }
                                if (editing) {
                                    val frames = startFrames + (moved / view.pxPerSec * state.sr).toLong()
                                    model.op("clip", "track" to track.id, "clip" to clip.id, "start" to frames.coerceAtLeast(0))
                                }
                            } else {
                                view.scroll = (view.scroll - dx / view.pxPerSec).coerceAtLeast(0f)
                            }
                        }
                        event.changes.forEach { if (it.positionChange() != Offset.Zero) it.consume() }
                    } while (event.changes.any { it.pressed })
                }
            },
    ) {
        onWidth(size.width)
        grid(s, view) { x, isBar, _ -> drawLine(if (isBar) Snake.Border2 else Snake.Border, Offset(x, 0f), Offset(x, size.height), 1f) }
        if (s.loopOn && s.loopEnd > s.loopStart) {
            val a = view.x(s.seconds(s.loopStart))
            drawRect(Snake.Accent.copy(alpha = 0.06f), Offset(a, 0f), Size(view.x(s.seconds(s.loopEnd)) - a, size.height))
        }
        val top = 4f
        val h = size.height - 8f
        for (c in t.clips) {
            val x0 = view.x(s.seconds(c.start))
            val x1 = view.x(s.seconds(c.start + c.len))
            if (x1 < 0 || x0 > size.width) continue
            val selected = s.selClip == (t.id to c.id)
            drawRoundRect(color.copy(alpha = if (selected) 0.45f else 0.25f), Offset(x0, top), Size(x1 - x0, h), CornerRadius(6f))
            drawRoundRect(if (selected) Color.White else color, Offset(x0, top), Size(x1 - x0, h), CornerRadius(6f), style = Stroke(if (selected) 2.5f else 1f))
            // The waveform: min/max pairs over the whole file, showing the part this clip plays.
            val (totalFrames, peaks) = model.peaks(c.file)
            val n = peaks.size / 2
            if (n > 0 && totalFrames > 0) {
                val path = Path()
                val mid = top + h / 2
                val step = 2f
                var x = maxOf(x0, 0f)
                val end = minOf(x1, size.width)
                while (x < end) {
                    val frame = c.offset + ((view.sec(x) - s.seconds(c.start)) * s.sr).toLong()
                    val i = ((frame.toDouble() / totalFrames) * n).toInt().coerceIn(0, n - 1)
                    val lo = peaks[i * 2]
                    val hi = peaks[i * 2 + 1]
                    path.moveTo(x, mid - hi * h / 2)
                    path.lineTo(x, mid - lo * h / 2 + 0.5f)
                    x += step
                }
                drawPath(path, color, style = Stroke(1.5f))
            }
        }
        // A take being recorded grows from where recording started.
        s.recFrames[t.id]?.let { frames ->
            val x0 = view.x(s.seconds(s.recAt))
            val x1 = view.x(s.seconds(s.recAt + frames))
            drawRect(RED.copy(alpha = 0.3f), Offset(x0, top), Size(x1 - x0, h))
        }
        val px = view.x(s.seconds(s.pos))
        drawLine(Snake.Highlight, Offset(px, 0f), Offset(px, size.height), 2f)
    }
}
