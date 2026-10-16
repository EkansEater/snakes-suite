"""Virtual-cable mode: SoundPad on Windows, macOS, and Linux without PipeWire tools.

Those systems cannot make a microphone out of thin air, so a free virtual cable
does that part (VB-CABLE on Windows, BlackHole on macOS). SoundPad plays clips
into the cable's input and pipes your real microphone into it too; voice chat
then listens to the cable's output as its microphone.

    your mic ──(QAudioSource → QAudioSink)──┐
                                            ├──> CABLE Input  ══>  CABLE Output (pick it in Discord)
    sound clip (QMediaPlayer) ──────────────┘
    sound clip (QMediaPlayer) ──> your speakers / headphones (to hear it yourself)

Everything here is Qt Multimedia: no extra programs are needed.
"""

from __future__ import annotations

from PySide6.QtCore import QUrl
from PySide6.QtMultimedia import QAudioDevice, QAudioFormat, QAudioOutput, QAudioSink, QAudioSource, QMediaDevices, QMediaPlayer

from .audio import AudioError

# Names virtual cables give their playback side.
CABLE_HINTS = ("cable input", "vb-audio", "vb-cable", "blackhole", "loopback", "voicemeeter input", "virtual")
CABLE_HELP = {
    "windows": ("VB-CABLE", "https://vb-audio.com/Cable/"),
    "macos": ("BlackHole", "https://existential.audio/blackhole/"),
    "linux": ("a null sink (pactl load-module module-null-sink)", "https://wiki.archlinux.org/title/PipeWire"),
}


def _id(dev: QAudioDevice) -> str:
    return bytes(dev.id()).decode(errors="replace")


class CableDevices:
    """The same job as VirtualDevices, through a virtual cable the person installed."""

    mode = "cable"
    supports_default = False

    def __init__(self) -> None:
        self.original_default: str | None = None
        self.target: str | None = None  # the cable's playback device id
        self._source: QAudioSource | None = None
        self._sink: QAudioSink | None = None
        self._pipe = None
        self._source_id: str | None = None

    # ---- devices ----
    @staticmethod
    def outputs() -> list[tuple[str, str]]:
        return [(_id(d), d.description()) for d in QMediaDevices.audioOutputs()]

    @staticmethod
    def list_inputs() -> list[tuple[str, str]]:
        return [(_id(d), d.description()) for d in QMediaDevices.audioInputs()]

    @staticmethod
    def default_input() -> str:
        return _id(QMediaDevices.defaultAudioInput())

    def guess_cable(self) -> str | None:
        for dev_id, desc in self.outputs():
            if any(h in desc.lower() for h in CABLE_HINTS):
                return dev_id
        return None

    def set_target(self, dev_id: str | None) -> None:
        self.target = dev_id
        if self._source is not None:
            # Re-route the microphone into the new cable.
            src = self._source_id
            self.set_mic_passthrough(None)
            self.set_mic_passthrough(src)

    @property
    def mic_label(self) -> str:
        return "your virtual cable's output (for example “CABLE Output” or “BlackHole”)"

    # ---- lifecycle (nothing to create) ----
    def setup(self) -> None:
        self.target = self.target or self.guess_cable()

    def set_as_default(self, enabled: bool) -> None:  # the system default stays the person's choice
        return None

    def teardown(self) -> None:
        self.set_mic_passthrough(None)

    # ---- microphone into the cable ----
    def set_mic_passthrough(self, source: str | None) -> None:
        if self._source is not None:
            self._source.stop()
            self._sink.stop()
            self._source = self._sink = self._pipe = None
        if source is None or not self.target:
            return
        mic = next((d for d in QMediaDevices.audioInputs() if _id(d) == source), QMediaDevices.defaultAudioInput())
        out = next((d for d in QMediaDevices.audioOutputs() if _id(d) == self.target), None)
        if out is None:
            raise AudioError("The virtual cable was not found. Choose it under “Send sounds to”.")
        fmt = QAudioFormat()
        fmt.setSampleRate(48000)
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        if not mic.isFormatSupported(fmt) or not out.isFormatSupported(fmt):
            fmt = mic.preferredFormat()
            if not out.isFormatSupported(fmt):
                raise AudioError("Your microphone and the virtual cable do not agree on a sound format.")
        self._source = QAudioSource(mic, fmt)
        self._source.setBufferSize(fmt.bytesForDuration(40_000))
        self._sink = QAudioSink(out, fmt)
        self._sink.setBufferSize(fmt.bytesForDuration(80_000))
        sink_io = self._sink.start()
        src_io = self._source.start()
        self._pipe = (src_io, sink_io)
        self._source_id = source
        src_io.readyRead.connect(lambda: sink_io.write(src_io.readAll()))


class QtPlayer:
    """Plays a clip into the cable and (optionally) your speakers, like Player does with mpv."""

    def __init__(self, devices: CableDevices) -> None:
        self.devices = devices
        self.playing: list[tuple[QMediaPlayer, QAudioOutput]] = []

    def _spawn(self, path: str, device: QAudioDevice | None, volume: int) -> None:
        player = QMediaPlayer()
        out = QAudioOutput(device) if device is not None else QAudioOutput()
        # Qt's volume stops at 100%; louder than that is the clip's own level.
        out.setVolume(max(0.0, min(1.0, volume / 100)))
        player.setAudioOutput(out)
        player.setSource(QUrl.fromLocalFile(path))
        player.play()
        self.playing.append((player, out))

    def play(self, path: str, mic_volume: int, monitor_volume: int, monitor: bool, overlap: bool = False) -> None:
        if not overlap:
            self.stop()
        self.reap()
        target = next((d for d in QMediaDevices.audioOutputs() if _id(d) == self.devices.target), None)
        if target is not None:
            self._spawn(path, target, mic_volume)
        if monitor or target is None:
            self._spawn(path, None, monitor_volume)

    def reap(self) -> None:
        keep = []
        for player, out in self.playing:
            if player.playbackState() == QMediaPlayer.PlaybackState.StoppedState and player.mediaStatus() in (
                    QMediaPlayer.MediaStatus.EndOfMedia, QMediaPlayer.MediaStatus.InvalidMedia):
                player.deleteLater()
                out.deleteLater()
            else:
                keep.append((player, out))
        self.playing = keep

    def is_playing(self) -> bool:
        self.reap()
        return any(p.playbackState() == QMediaPlayer.PlaybackState.PlayingState for p, _ in self.playing)

    def stop(self) -> None:
        for player, out in self.playing:
            player.stop()
            player.deleteLater()
            out.deleteLater()
        self.playing.clear()
