package com.snake.suite.hub

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.snake.suite.core.CardState
import com.snake.suite.core.FlatButton
import com.snake.suite.core.PrimaryButton
import com.snake.suite.core.Snake
import com.snake.suite.core.SnakeCard
import com.snake.suite.core.SnakeProgress
import com.snake.suite.core.SnakeScaffold
import com.snake.suite.core.SnakeTheme
import com.snake.suite.core.Tool
import com.snake.suite.core.Tools

class MainActivity : ComponentActivity() {
    private val model: HubModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { SnakeTheme { HubScreen(model) } }
    }
}

@Composable
private fun HubScreen(model: HubModel) {
    val snackbar = remember { SnackbarHostState() }
    var query by remember { mutableStateOf("") }
    var searching by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<Tool?>(null) }
    var editIndex by remember { mutableStateOf(false) }

    // Installs and uninstalls happen in other screens: look again whenever we come back.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        model.refreshInstalled()
        model.check()
    }
    LaunchedEffect(model.message) {
        model.message?.let { snackbar.showSnackbar(it); model.message = null }
    }

    SnakeScaffold(
        Tools.hub,
        subtitle = "${model.installed.size} of ${Tools.all.count { it.android }} tools installed",
        snackbar = snackbar,
        actions = {
            IconButton({ searching = !searching; if (!searching) query = "" }) { Icon(Icons.Default.Search, "Search", tint = Snake.Fg2) }
            IconButton({ model.check(force = true) }, enabled = !model.checking) {
                Icon(Icons.Default.Refresh, "Check for updates", tint = Snake.Fg2)
            }
            Box {
                IconButton({ menu = true }) { Icon(Icons.Default.MoreVert, "More", tint = Snake.Fg2) }
                DropdownMenu(menu, { menu = false }) {
                    DropdownMenuItem({ Text("Install every tool") }, { menu = false; model.installAll() })
                    DropdownMenuItem({ Text("Update all") }, { menu = false; model.updateAll() })
                    DropdownMenuItem(
                        { Text("Update automatically") },
                        { model.autoUpdate = !model.autoUpdateState },
                        trailingIcon = {
                            Checkbox(model.autoUpdateState, { model.autoUpdate = it },
                                colors = CheckboxDefaults.colors(checkedColor = Snake.Accent))
                        },
                    )
                    DropdownMenuItem({ Text("Release index...") }, { menu = false; editIndex = true })
                }
            }
        },
        bottomBar = { StatusBar(model) },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (searching) {
                OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(12.dp, 8.dp),
                    placeholder = { Text("Search tools") }, singleLine = true)
            }
            val tools = Tools.all.filter {
                query.isBlank() || it.name.contains(query, true) || it.tagline.contains(query, true) ||
                    it.description.contains(query, true)
            }
            LazyVerticalGrid(
                GridCells.Adaptive(170.dp),
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(12.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                model.hubUpdate?.let { apk ->
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        SnakeCard(state = CardState.Done) {
                            Text("Snake's Master Suite ${apk.version} is available", color = Snake.Highlight)
                            Spacer(Modifier.height(8.dp))
                            PrimaryButton("Update Snake's Master Suite", { model.updateHub() })
                        }
                    }
                }
                items(tools, key = { it.id }) { tool ->
                    ToolTile(model, tool, onClick = {
                        when {
                            !tool.android -> model.message = "${tool.name} is desktop only"
                            tool.id in model.work -> Unit
                            tool.id in model.installed -> model.open(tool)
                            else -> model.install(tool)
                        }
                    }, onLongClick = { if (tool.android) selected = tool })
                }
            }
        }
    }

    selected?.let { tool -> ToolMenu(model, tool) { selected = null } }
    if (editIndex) IndexDialog(model) { editIndex = false }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ToolTile(model: HubModel, tool: Tool, onClick: () -> Unit, onLongClick: () -> Unit) {
    val installed = model.installed[tool.id]
    val work = model.work[tool.id]
    val update = model.hasUpdate(tool)
    SnakeCard(
        Modifier.fillMaxWidth().height(196.dp).combinedClickable(onClick = onClick, onLongClick = onLongClick),
        state = if (update) CardState.Done else CardState.Normal,
    ) {
        Image(painterResource(tool.icon), null, Modifier.size(52.dp))
        Spacer(Modifier.height(10.dp))
        Text(tool.name, style = MaterialTheme.typography.titleMedium, color = if (tool.android) Snake.Fg else Snake.Fg3,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(tool.tagline, style = MaterialTheme.typography.bodySmall, color = Snake.Fg2, maxLines = 1)
        Spacer(Modifier.weight(1f))
        when {
            work != null -> {
                Text(work.label, style = MaterialTheme.typography.bodySmall, color = Snake.Highlight)
                Spacer(Modifier.height(6.dp))
                SnakeProgress(work.progress)
            }
            !tool.android -> Text("Desktop only", style = MaterialTheme.typography.bodySmall, color = Snake.Fg3)
            update -> Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${installed} → ${model.offered(tool)?.version}", Modifier.weight(1f),
                    style = MaterialTheme.typography.bodySmall, color = Snake.Highlight, maxLines = 1)
                FlatButton("Update", { model.install(tool) }, color = Snake.Highlight)
            }
            installed != null -> Text("Installed · $installed", style = MaterialTheme.typography.bodySmall, color = Snake.Fg2)
            else -> Text("Tap to install", style = MaterialTheme.typography.bodySmall, color = Snake.Accent)
        }
    }
}

@Composable
private fun ToolMenu(model: HubModel, tool: Tool, onDismiss: () -> Unit) {
    val installed = tool.id in model.installed
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Snake.Widget,
        icon = { Image(painterResource(tool.icon), null, Modifier.size(48.dp)) },
        title = { Text(tool.name) },
        text = {
            Column {
                Text(tool.description, color = Snake.Fg2)
                Spacer(Modifier.height(8.dp))
                Text(
                    listOfNotNull(
                        model.installed[tool.id]?.let { "Installed: $it" },
                        model.offered(tool)?.let { "Latest: ${it.version}" },
                    ).joinToString("   ").ifEmpty { "Not installed" },
                    color = Snake.Fg3, style = MaterialTheme.typography.bodySmall,
                )
            }
        },
        confirmButton = {
            Column(horizontalAlignment = Alignment.End) {
                if (installed) TextButton({ onDismiss(); model.open(tool) }) { Text("Open") }
                if (tool.id in model.work) TextButton({ onDismiss(); model.cancel(tool) }) { Text("Cancel download") }
                else TextButton({ onDismiss(); model.install(tool) }) { Text(if (installed) "Reinstall" else "Install") }
                if (installed) {
                    TextButton({ onDismiss(); model.appInfo(tool) }) { Text("App info") }
                    // The Studio apps are one app on the phone: uninstalling one removes all seven.
                    TextButton({ onDismiss(); model.uninstall(tool) }) {
                        Text(if (tool.shared != null) "Uninstall Snake's Studio (all seven apps)" else "Uninstall", color = Snake.ErrorSoft)
                    }
                }
            }
        },
        dismissButton = { TextButton(onDismiss) { Text("Close") } },
    )
}

@Composable
private fun IndexDialog(model: HubModel, onDismiss: () -> Unit) {
    var url by remember { mutableStateOf(model.indexUrl) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Snake.Widget,
        title = { Text("Release index") },
        text = {
            Column {
                Text("Where Snake's Master Suite looks for apps. Leave empty for the GitHub release. " +
                    "Any list must carry the suite's signature.", color = Snake.Fg2)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(url, { url = it }, singleLine = false)
            }
        },
        confirmButton = { TextButton({ model.indexUrl = url; model.check(force = true); onDismiss() }) { Text("Save") } },
        dismissButton = {
            Row {
                TextButton({ model.indexUrl = ""; model.check(force = true); onDismiss() }) { Text("Reset") }
                TextButton(onDismiss) { Text("Cancel") }
            }
        },
    )
}

@Composable
private fun StatusBar(model: HubModel) {
    val updates = model.updatesAvailable()
    Row(
        Modifier.fillMaxWidth().background(Snake.Title).navigationBarsPadding().padding(horizontal = 14.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val text = when {
            model.checking -> "Checking for updates..."
            model.indexError != null -> model.indexError!!
            updates.isNotEmpty() -> "${updates.size} update(s) available"
            model.index != null -> "Up to date"
            else -> ""
        }
        Text(text, Modifier.weight(1f), color = if (model.indexError != null) Snake.Warning else Snake.Fg2,
            style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (updates.isNotEmpty()) FlatButton("Update all", { model.updateAll() }, color = Snake.Highlight)
        Spacer(Modifier.width(4.dp))
        Text("v${model.hubVersion}", color = Snake.Fg3, style = MaterialTheme.typography.bodySmall)
    }
}
