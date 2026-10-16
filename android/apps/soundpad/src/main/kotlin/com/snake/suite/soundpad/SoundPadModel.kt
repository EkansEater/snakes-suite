package com.snake.suite.soundpad

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.documentfile.provider.DocumentFile
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.snake.suite.core.describe
import com.snake.suite.core.uniqueFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class SoundPadModel(app: Application) : AndroidViewModel(app) {
    private val library = Library(app)
    var sounds by mutableStateOf<List<Sound>>(emptyList()); private set
    var settings by mutableStateOf(Settings()); private set
    var playing by mutableStateOf<Set<String>>(emptySet()); private set
    var status by mutableStateOf(""); private set
    var busy by mutableStateOf(false); private set
    private val player = Player(app) { playing = it }

    init {
        val (s, st) = library.load()
        sounds = s
        settings = st
    }

    private fun save() = library.save(sounds, settings)

    fun play(sound: Sound) {
        if (sound.file in playing && !settings.overlap) {
            player.stop(sound.file)
            status = "Stopped"
            return
        }
        val f = library.path(sound)
        if (!f.exists()) {
            status = "Missing file: ${sound.name}"
            return
        }
        val gain = (settings.volume / 100f) * (sound.volume / 100f)
        runCatching { player.play(sound.file, f, gain.coerceIn(0f, 1f), settings.overlap) }
            .onSuccess { status = "▶ ${sound.name}" }
            .onFailure { status = "Can't play ${sound.name}: ${it.message}" }
    }

    fun playRandom() {
        sounds.randomOrNull()?.let(::play)
    }

    fun stop() {
        player.stopAll()
        status = "Stopped"
    }

    /** Copy the picked files into the library. Folders are walked for audio files. */
    fun add(uris: List<Uri>, tree: Uri? = null) {
        busy = true
        viewModelScope.launch {
            val added = withContext(Dispatchers.IO) {
                val ctx = getApplication<Application>()
                val files = buildList {
                    uris.forEach { add(it to ctx.describe(it).name) }
                    if (tree != null) DocumentFile.fromTreeUri(ctx, tree)?.let { walk(it, this) }
                }
                files.filter { (_, name) -> name.substringAfterLast('.', "").lowercase() in Library.AUDIO_EXTS }
                    .mapNotNull { (uri, name) ->
                        runCatching {
                            val out = uniqueFile(library.soundsDir, name)
                            ctx.contentResolver.openInputStream(uri)!!.use { i -> out.outputStream().use { i.copyTo(it) } }
                            Sound(out.name, name.substringBeforeLast('.'))
                        }.getOrNull()
                    }
            }
            sounds = sounds + added
            save()
            busy = false
            status = if (added.isEmpty()) "No audio files found" else "Added ${added.size} sound(s)"
        }
    }

    private fun walk(dir: DocumentFile, out: MutableList<Pair<Uri, String>>) {
        dir.listFiles().sortedBy { it.name?.lowercase() }.forEach {
            if (it.isDirectory) walk(it, out) else it.name?.let { n -> out += it.uri to n }
        }
    }

    fun rename(sound: Sound, name: String) = update(sound) { it.copy(name = name.trim().ifEmpty { it.name }) }

    fun setVolume(sound: Sound, volume: Int) = update(sound) { it.copy(volume = volume.coerceIn(0, 200)) }

    private fun update(sound: Sound, change: (Sound) -> Sound) {
        sounds = sounds.map { if (it.file == sound.file) change(it) else it }
        save()
    }

    fun move(sound: Sound, delta: Int) {
        val i = sounds.indexOfFirst { it.file == sound.file }
        val j = (i + delta).coerceIn(0, sounds.lastIndex)
        if (i < 0 || i == j) return
        sounds = sounds.toMutableList().apply { add(j, removeAt(i)) }
        save()
    }

    fun remove(sound: Sound) {
        player.stop(sound.file)
        library.path(sound).delete()
        sounds = sounds.filterNot { it.file == sound.file }
        save()
        status = "Removed ${sound.name}"
    }

    fun setMasterVolume(v: Int) { settings = settings.copy(volume = v); save() }
    fun setOverlap(v: Boolean) { settings = settings.copy(overlap = v); save() }
    fun setColumns(v: Int) { settings = settings.copy(columns = v.coerceIn(1, 6)); save() }

    override fun onCleared() = player.stopAll(notify = false)
}
