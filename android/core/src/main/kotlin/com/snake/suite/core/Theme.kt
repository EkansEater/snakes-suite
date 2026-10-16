package com.snake.suite.core

import android.app.Activity
import android.content.Context
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat

/** The Snake Dark palette of Snake's Code, the same values as shared/qt/snake_theme.py. */
object Snake {
    val Bg = Color(0xFF1A1E1B)          // main window
    val Side = Color(0xFF151916)        // side bar, panels, cards
    val Title = Color(0xFF111412)       // title bar, status bar
    val Fg = Color(0xFFD5DDD7)
    val Fg2 = Color(0xFF8A978E)         // secondary text
    val Fg3 = Color(0xFF5D6A62)         // disabled text
    val Accent = Color(0xFF3FB950)      // buttons, focus, progress
    val AccentHover = Color(0xFF4CC75D)
    val AccentFg = Color(0xFFFFFFFF)
    val Highlight = Color(0xFF7EE787)   // links, highlights, the snake
    val Border = Color(0xFF252B27)
    val Border2 = Color(0xFF323A34)
    val Selection = Color(0xFF2B4A35)
    val Hover = Color(0xFF222823)
    val Widget = Color(0xFF1F2420)      // menus, popups
    val Input = Color(0xFF121513)
    val Button2 = Color(0xFF2A2F2B)     // secondary buttons
    val Error = Color(0xFFF14C4C)
    val ErrorSoft = Color(0xFFFF8A8A)
    val DangerBg = Color(0xFF3A2224)
    val Warning = Color(0xFFCCA700)
    val Info = Color(0xFF3794FF)
    val Record = Color(0xFFE5484D)
    val DropActive = Color(0xFF18241B)
    val DoneBorder = Color(0xFF2D5A3A)
    val FailBorder = Color(0xFF6A2C33)
}

private val SnakeColors: ColorScheme = darkColorScheme(
    primary = Snake.Accent,
    onPrimary = Snake.AccentFg,
    primaryContainer = Snake.Selection,
    onPrimaryContainer = Snake.Fg,
    secondary = Snake.Highlight,
    onSecondary = Snake.Title,
    secondaryContainer = Snake.Button2,
    onSecondaryContainer = Snake.Fg,
    tertiary = Snake.Info,
    background = Snake.Bg,
    onBackground = Snake.Fg,
    surface = Snake.Bg,
    onSurface = Snake.Fg,
    surfaceVariant = Snake.Side,
    onSurfaceVariant = Snake.Fg2,
    surfaceContainerLowest = Snake.Input,
    surfaceContainerLow = Snake.Side,
    surfaceContainer = Snake.Side,
    surfaceContainerHigh = Snake.Widget,
    surfaceContainerHighest = Snake.Button2,
    surfaceBright = Snake.Hover,
    outline = Snake.Border2,
    outlineVariant = Snake.Border,
    error = Snake.Error,
    onError = Snake.AccentFg,
    errorContainer = Snake.DangerBg,
    onErrorContainer = Snake.ErrorSoft,
    inverseSurface = Snake.Fg,
    inverseOnSurface = Snake.Title,
    scrim = Color(0xCC000000),
)

private val SnakeType = Typography().let { t ->
    t.copy(
        headlineSmall = t.headlineSmall.copy(fontWeight = FontWeight.Light),
        titleLarge = t.titleLarge.copy(fontWeight = FontWeight.SemiBold, fontSize = 20.sp),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.SemiBold),
        labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.6.sp),
    )
}

private val SnakeShapes = Shapes(
    extraSmall = RoundedCornerShape(4.dp),
    small = RoundedCornerShape(6.dp),
    medium = RoundedCornerShape(8.dp),
    large = RoundedCornerShape(10.dp),
    extraLarge = RoundedCornerShape(16.dp),
)

/** Wrap every screen of every tool in this. */
@Composable
fun SnakeTheme(content: @Composable () -> Unit) {
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = false
            @Suppress("DEPRECATION")
            window.navigationBarColor = Snake.Title.toArgb()
        }
    }
    MaterialTheme(colorScheme = SnakeColors, typography = SnakeType, shapes = SnakeShapes) { PinchToResize(content) }
}

/** Areas that zoom themselves with two fingers (the DAW's timeline), so the interface does not zoom with them. */
class PinchRegions internal constructor() {
    internal val rects = mutableMapOf<Any, Rect>()
}

val LocalPinchRegions = staticCompositionLocalOf { PinchRegions() }

/** Mark an area whose own two-finger pinch zooms its content. */
fun Modifier.zoomsItself(): Modifier = composed {
    val regions = LocalPinchRegions.current
    val key = remember { Any() }
    DisposableEffect(regions) { onDispose { regions.rects.remove(key) } }
    onGloballyPositioned { regions.rects[key] = it.boundsInRoot() }
}

/**
 * Two fingers anywhere make the whole interface bigger or smaller, like Ctrl+wheel over
 * the desktop apps' menus; one finger still scrolls and taps. The size is remembered
 * per app. The fingers are taken before lists see them, so a pinch does not also scroll.
 */
@Composable
private fun PinchToResize(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val prefs = remember { context.getSharedPreferences("snake-ui", Context.MODE_PRIVATE) }
    var scale by remember { mutableFloatStateOf(prefs.getFloat("scale", 1f)) }
    val regions = remember { PinchRegions() }
    val base = LocalDensity.current
    Box(
        Modifier.fillMaxSize().pointerInput(Unit) {
            awaitEachGesture {
                var pinching = false
                var theirs = false
                do {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val pressed = event.changes.filter { it.pressed }
                    if (pressed.size >= 2 && !theirs) {
                        if (!pinching) {
                            val c = Offset(pressed.map { it.position.x }.average().toFloat(), pressed.map { it.position.y }.average().toFloat())
                            theirs = regions.rects.values.any { it.contains(c) }
                            pinching = !theirs
                        }
                        if (pinching) {
                            scale = (scale * event.calculateZoom()).coerceIn(0.7f, 2f)
                            event.changes.forEach { it.consume() }
                        }
                    }
                } while (event.changes.any { it.pressed })
                if (pinching) prefs.edit().putFloat("scale", scale).apply()
            }
        },
    ) {
        CompositionLocalProvider(
            LocalDensity provides Density(base.density * scale, base.fontScale),
            LocalPinchRegions provides regions,
            content = content,
        )
    }
}
