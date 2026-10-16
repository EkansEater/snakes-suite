package com.snake.suite.daw

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.foundation.clickable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.snake.suite.core.ChoiceChip
import com.snake.suite.core.SectionLabel
import com.snake.suite.core.Snake

/**
 * What the DAW shows, from its View menu. A phone starts compact with the essentials:
 * play, record, the time, the tracks and their arm buttons. Everything else can be
 * switched back on, and the whole interface scaled.
 */
class ViewPrefs(context: Context) {
    private val p = context.getSharedPreferences("view", Context.MODE_PRIVATE)
    private val phone = context.resources.configuration.smallestScreenWidthDp < 600

    private fun flag(key: String, default: Boolean) = mutableStateOf(p.getBoolean(key, default))

    /** Interface size: 1 = as designed; less fits more on a phone. */
    var scale by mutableFloatStateOf(p.getFloat("scale", if (phone) 0.85f else 1f)); private set
    private val titleBar = flag("title_bar", !phone)
    private val transportExtras = flag("transport_extras", !phone)
    private val trackButtons = flag("track_buttons", !phone)
    private val meters = flag("meters", true)
    private val editBar = flag("edit_bar", true)
    private val tabLabels = flag("tab_labels", !phone)

    val showTitleBar get() = titleBar.value
    val showTransportExtras get() = transportExtras.value
    val showTrackButtons get() = trackButtons.value
    val showMeters get() = meters.value
    val showEditBar get() = editBar.value
    val showTabLabels get() = tabLabels.value

    fun scaleTo(v: Float) { scale = v; p.edit().putFloat("scale", v).apply() }

    val toggles: List<Triple<String, String, androidx.compose.runtime.MutableState<Boolean>>> = listOf(
        Triple("title_bar", "Title bar", titleBar),
        Triple("transport_extras", "Tempo, click, loop, undo in the transport", transportExtras),
        Triple("track_buttons", "Track buttons (monitor, mute, solo)", trackButtons),
        Triple("meters", "Level meters", meters),
        Triple("edit_bar", "Edit bar (add track, split, delete)", editBar),
        Triple("tab_labels", "Tab names", tabLabels),
    )

    fun set(key: String, state: androidx.compose.runtime.MutableState<Boolean>, v: Boolean) {
        state.value = v
        p.edit().putBoolean(key, v).apply()
    }
}

@Composable
fun ViewDialog(prefs: ViewPrefs, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss, containerColor = Snake.Widget,
        title = { Text("View") },
        text = {
            Column {
                SectionLabel("Interface size")
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf(0.7f to "Smallest", 0.8f to "Small", 0.85f to "Compact", 1f to "Normal").forEach { (v, label) ->
                        ChoiceChip(label, kotlin.math.abs(prefs.scale - v) < 0.01f, { prefs.scaleTo(v) })
                    }
                }
                Spacer(Modifier.height(12.dp))
                SectionLabel("Show")
                prefs.toggles.forEach { (key, label, state) ->
                    Row(Modifier.fillMaxWidth().clickable { prefs.set(key, state, !state.value) }, verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(state.value, { prefs.set(key, state, it) }, colors = CheckboxDefaults.colors(checkedColor = Snake.Accent))
                        Text(label)
                    }
                }
            }
        },
        confirmButton = { TextButton(onDismiss) { Text("Done") } },
    )
}
