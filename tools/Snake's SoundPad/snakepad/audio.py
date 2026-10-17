"""Virtual audio routing (PipeWire/PulseAudio) and sound playback via mpv.

Routing graph:

    real mic ──(module-loopback)──┐
                                  ├──> snakepad_sink (null sink)
    mpv (sound clip) ─────────────┘          │
                                             └─ .monitor ──(module-remap-source)──> snakepad_mic
                                                                                     (select in Discord)
    mpv (sound clip, self-monitor) ──> your default output (headphones)
"""

from __future__ import annotations

import shutil
import subprocess
import time
from dataclasses import dataclass

SINK_NAME = "snakepad_sink"
MIC_NAME = "snakepad_mic"
SINK_DESC = "Snake Soundpad Sink"
MIC_DESC = "Snake Soundpad Mic"
OWN_NAMES = (SINK_NAME, MIC_NAME, SINK_NAME + ".monitor")


class AudioError(RuntimeError):
    pass


def _pactl(*args: str) -> str:
    try:
        res = subprocess.run(["pactl", *args], capture_output=True, text=True, timeout=5)
    except FileNotFoundError as e:
        raise AudioError("pactl not found (install pipewire-pulse / libpulse)") from e
    if res.returncode != 0:
        raise AudioError(f"pactl {' '.join(args)} failed: {res.stderr.strip()}")
    return res.stdout


@dataclass
class Source:
    name: str
    description: str


def list_input_sources() -> list[Source]:
    """Real capture devices (no monitors, nothing we created)."""
    sources: list[Source] = []
    name = desc = None
    for line in _pactl("list", "sources").splitlines():
        line = line.strip()
        if line.startswith("Name:"):
            name = line.split(":", 1)[1].strip()
        elif line.startswith("Description:") and name:
            desc = line.split(":", 1)[1].strip()
            if not name.endswith(".monitor") and name not in OWN_NAMES:
                sources.append(Source(name, desc))
            name = desc = None
    return sources


def default_source() -> str:
    return _pactl("get-default-source").strip()


def set_default_source(name: str) -> None:
    _pactl("set-default-source", name)


def move_untargeted_recordings(to: str) -> None:
    """Move apps that are recording from "the default mic" (no device chosen) onto `to`.

    Games often open the mic once at launch, so changing the default alone misses them.
    Streams pinned to a specific device (target.object / dont-move) are left alone.
    """
    blocks = _pactl("list", "source-outputs").split("Source Output #")[1:]
    for b in blocks:
        idx = b.split("\n", 1)[0].strip()
        if ("target.object" in b or "node.dont-move" in b or "node.dont-reconnect" in b
                or "snakepad" in b or "Snake input" in b or "loopback" in b):
            continue
        try:
            _pactl("move-source-output", idx, to)
        except AudioError:
            pass


class VirtualDevices:
    """Creates and tears down the virtual sink, virtual mic and mic loopback."""

    mode = "virtual"
    supports_default = True
    mic_label = MIC_DESC

    @staticmethod
    def list_inputs() -> list[tuple[str, str]]:
        return [(s.name, s.description) for s in list_input_sources()]

    @staticmethod
    def default_input() -> str:
        return default_source()

    def __init__(self) -> None:
        self.sink_module: int | None = None
        self.mic_module: int | None = None
        self.loopback_module: int | None = None
        self.loopback_source: str | None = None
        # The real default mic from before we (maybe) replaced it with ours
        self.original_default: str | None = None
        self.is_default = False

    @staticmethod
    def cleanup_stale() -> None:
        """Unload modules left over from a previous run that crashed."""
        for line in _pactl("list", "short", "modules").splitlines():
            parts = line.split("\t")
            if len(parts) >= 3 and "snakepad" in parts[2]:
                try:
                    _pactl("unload-module", parts[0])
                except AudioError:
                    pass

    def setup(self) -> None:
        self.cleanup_stale()
        # A crashed run may have left our mic as default; pipewire takes a moment to fall back
        self.original_default = None
        for _ in range(10):
            try:
                src = default_source()
            except AudioError:
                break
            if src not in OWN_NAMES:
                self.original_default = src
                break
            time.sleep(0.1)
        self.sink_module = int(_pactl(
            "load-module", "module-null-sink",
            f"sink_name={SINK_NAME}",
            f'sink_properties=device.description="{SINK_DESC}"',
        ).strip())
        self.mic_module = int(_pactl(
            "load-module", "module-remap-source",
            f"master={SINK_NAME}.monitor",
            f"source_name={MIC_NAME}",
            f'source_properties=device.description="{MIC_DESC}"',
        ).strip())

    def set_mic_passthrough(self, source: str | None) -> None:
        """Route `source` into the virtual mic, or disable passthrough with None."""
        if self.loopback_module is not None:
            try:
                _pactl("unload-module", str(self.loopback_module))
            except AudioError:
                pass
            self.loopback_module = None
            self.loopback_source = None
        if source is None:
            return
        if source in OWN_NAMES:
            raise AudioError("Refusing to loop the virtual mic into itself")
        self.loopback_module = int(_pactl(
            "load-module", "module-loopback",
            f"source={source}",
            f"sink={SINK_NAME}",
            "latency_msec=20",
            "source_dont_move=true",
            "sink_dont_move=true",
        ).strip())
        self.loopback_source = source

    def set_as_default(self, enabled: bool) -> None:
        """Make the virtual mic the system default input, for apps/games with no device picker."""
        if enabled:
            set_default_source(MIC_NAME)
            self.is_default = True
            move_untargeted_recordings(MIC_NAME)
            return
        # (pactl reads lag behind writes, so trust our own flag first)
        if not self.is_default and default_source() not in OWN_NAMES:
            return
        self.is_default = False
        fallback = self.original_default
        if fallback is None:
            real = list_input_sources()
            fallback = real[0].name if real else None
        if fallback:
            set_default_source(fallback)

    def teardown(self) -> None:
        # Hand apps back to the real mic before our devices disappear
        if self.mic_module is not None:
            try:
                self.set_as_default(False)
            except AudioError:
                pass
        for attr in ("loopback_module", "mic_module", "sink_module"):
            mod = getattr(self, attr)
            if mod is not None:
                try:
                    _pactl("unload-module", str(mod))
                except AudioError:
                    pass
                setattr(self, attr, None)


class Player:
    """Plays a clip simultaneously into the virtual sink and (optionally) your speakers."""

    def __init__(self) -> None:
        if not shutil.which("mpv"):
            raise AudioError("mpv not found; install it to play sounds")
        self.procs: list[subprocess.Popen] = []

    @staticmethod
    def _spawn(path: str, device: str | None, volume: int, start: float = 0.0, end: float = 0.0,
               loop: bool = False) -> subprocess.Popen:
        cmd = [
            "mpv", "--no-video", "--no-terminal", "--really-quiet",
            "--ao=pulse", f"--volume={volume}", "--volume-max=200",
            "--audio-client-name=Snake Soundpad",
        ]
        if device:
            cmd.append(f"--audio-device=pulse/{device}")
        if start > 0:
            cmd.append(f"--start={start:.3f}")
        if loop and end > start:
            # mpv's own file loop restarts at 0, its A-B loop at the trimmed start.
            cmd += [f"--ab-loop-a={start:.3f}", f"--ab-loop-b={end:.3f}"]
        elif loop:
            cmd.append("--loop-file=inf")
        elif end > start:
            cmd.append(f"--end={end:.3f}")
        cmd += ["--", path]
        return subprocess.Popen(cmd, stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def play(self, path: str, mic_volume: int, monitor_volume: int,
             monitor: bool, overlap: bool = False, start: float = 0.0, end: float = 0.0, loop: bool = False) -> None:
        if not overlap:
            self.stop()
        self.reap()
        self.procs.append(self._spawn(path, SINK_NAME, mic_volume, start, end, loop))
        if monitor:
            self.procs.append(self._spawn(path, None, monitor_volume, start, end, loop))

    def reap(self) -> None:
        self.procs = [p for p in self.procs if p.poll() is None]

    def is_playing(self) -> bool:
        self.reap()
        return bool(self.procs)

    def stop(self) -> None:
        for p in self.procs:
            if p.poll() is None:
                p.terminate()
        for p in self.procs:
            try:
                p.wait(timeout=1)
            except subprocess.TimeoutExpired:
                p.kill()
        self.procs.clear()
