package com.snake.suite.core

import androidx.annotation.DrawableRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.Canvas
import androidx.compose.ui.geometry.CornerRadius

/** The header bar every tool has, like the Snake's Code title bar. */
@Composable
fun HeaderBar(
    title: String,
    subtitle: String? = null,
    @DrawableRes icon: Int? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Column(Modifier.background(Snake.Title).statusBarsPadding()) {
        Row(
            Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (icon != null) {
                Image(painterResource(icon), null, Modifier.size(32.dp))
                Spacer(Modifier.width(12.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = Snake.Fg, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
                if (subtitle != null) {
                    Text(subtitle, style = MaterialTheme.typography.bodySmall, color = Snake.Fg2, maxLines = 1,
                        overflow = TextOverflow.Ellipsis)
                }
            }
            actions()
        }
        Box(Modifier.fillMaxWidth().height(1.dp).background(Snake.Border))
    }
}

/** A tool screen: header bar on top, content below, snackbars for messages. */
@Composable
fun SnakeScaffold(
    tool: Tool,
    subtitle: String? = tool.tagline,
    snackbar: SnackbarHostState? = null,
    header: Boolean = true,
    actions: @Composable RowScope.() -> Unit = {},
    bottomBar: @Composable () -> Unit = {},
    floating: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        topBar = { if (header) HeaderBar(tool.name, subtitle, tool.icon, actions) else Spacer(Modifier.statusBarsPadding()) },
        bottomBar = bottomBar,
        floatingActionButton = floating,
        snackbarHost = { if (snackbar != null) SnackbarHost(snackbar) },
        containerColor = Snake.Bg,
        contentWindowInsets = WindowInsets(0),
        content = content,
    )
}

enum class CardState { Normal, Done, Failed }

@Composable
fun SnakeCard(
    modifier: Modifier = Modifier,
    state: CardState = CardState.Normal,
    onClick: (() -> Unit)? = null,
    padding: Dp = 14.dp,
    content: @Composable ColumnScope.() -> Unit,
) {
    val border = when (state) {
        CardState.Normal -> Snake.Border
        CardState.Done -> Snake.DoneBorder
        CardState.Failed -> Snake.FailBorder
    }
    val shape = RoundedCornerShape(8.dp)
    // Cards span their column (or grid cell), whatever their content.
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(Snake.Side)
            .border(1.dp, border, shape)
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(padding),
        content = content,
    )
}

/** Small uppercase label above a group of controls, like QGroupBox titles. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), modifier.padding(bottom = 6.dp), style = MaterialTheme.typography.labelSmall, color = Snake.Fg2)
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
                  icon: ImageVector? = null) {
    Button(
        onClick, modifier, enabled = enabled, shape = RoundedCornerShape(6.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = Snake.Accent, contentColor = Snake.AccentFg,
            disabledContainerColor = Color(0xFF23402C), disabledContentColor = Color(0xFF6F8A77),
        ),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 10.dp),
    ) { ButtonContent(text, icon) }
}

@Composable
fun SecondaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
                    icon: ImageVector? = null) {
    Button(
        onClick, modifier, enabled = enabled, shape = RoundedCornerShape(6.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = Snake.Button2, contentColor = Snake.Fg,
            disabledContainerColor = Snake.Hover, disabledContentColor = Snake.Fg3,
        ),
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 10.dp),
    ) { ButtonContent(text, icon) }
}

@Composable
fun DangerButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
                 icon: ImageVector? = null) {
    Button(
        onClick, modifier, enabled = enabled, shape = RoundedCornerShape(6.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Snake.DangerBg, contentColor = Snake.ErrorSoft),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 10.dp),
    ) { ButtonContent(text, icon) }
}

@Composable
fun FlatButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
               icon: ImageVector? = null, color: Color = Snake.Fg) {
    TextButton(onClick, modifier, enabled = enabled, colors = ButtonDefaults.textButtonColors(contentColor = color)) {
        ButtonContent(text, icon)
    }
}

@Composable
private fun ButtonContent(text: String, icon: ImageVector?) {
    if (icon != null) {
        Icon(icon, null, Modifier.size(18.dp))
        if (text.isNotEmpty()) Spacer(Modifier.width(8.dp))
    }
    if (text.isNotEmpty()) Text(text, maxLines = 1)
}

/** The dashed drop zone of the desktop tools; on Android it opens a picker when tapped. */
@Composable
fun DropZone(
    text: String,
    modifier: Modifier = Modifier,
    hint: String? = null,
    icon: ImageVector? = null,
    active: Boolean = false,
    onClick: () -> Unit,
) {
    val color = if (active) Snake.Accent else Snake.Border2
    Box(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(if (active) Snake.DropActive else Snake.Side)
            .clickable(onClick = onClick)
            .padding(vertical = 28.dp, horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.matchParentSize()) {
            drawRoundRect(
                color, cornerRadius = CornerRadius(10.dp.toPx()),
                style = Stroke(2.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(10f, 8f))),
            )
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (icon != null) Icon(icon, null, tint = if (active) Snake.Highlight else Snake.Fg2, modifier = Modifier.size(36.dp))
            Text(text, style = MaterialTheme.typography.titleMedium, color = if (active) Snake.Highlight else Snake.Fg2)
            if (hint != null) Text(hint, style = MaterialTheme.typography.bodySmall, color = Snake.Fg3)
        }
    }
}

@Composable
fun SnakeProgress(progress: Float?, modifier: Modifier = Modifier) {
    val m = modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp))
    if (progress == null) {
        LinearProgressIndicator(m, color = Snake.Accent, trackColor = Snake.Border)
    } else {
        LinearProgressIndicator({ progress.coerceIn(0f, 1f) }, m, color = Snake.Accent, trackColor = Snake.Border,
            drawStopIndicator = {})
    }
}

/** A pill-shaped toggle chip, like the checkable buttons of the desktop tools. */
@Composable
fun ChoiceChip(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val shape = RoundedCornerShape(6.dp)
    Box(
        modifier
            .clip(shape)
            .background(if (selected) Snake.Selection else Snake.Button2)
            .border(BorderStroke(1.dp, if (selected) Snake.Accent else Color.Transparent), shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, color = if (selected) Snake.Highlight else Snake.Fg, style = MaterialTheme.typography.labelLarge)
    }
}

@Composable
fun EmptyState(text: String, modifier: Modifier = Modifier, hint: String? = null) {
    Column(modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(text, color = Snake.Fg2, style = MaterialTheme.typography.titleMedium)
        if (hint != null) {
            Spacer(Modifier.height(4.dp))
            Text(hint, color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
        }
    }
}
