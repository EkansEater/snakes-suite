"""Persistent sound list and settings, stored as JSON in ~/.config/snakepad/."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

CONFIG_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "snakepad"
CONFIG_FILE = CONFIG_DIR / "library.json"

AUDIO_EXTS = {
    ".mp3", ".wav", ".ogg", ".oga", ".opus", ".flac", ".m4a", ".aac", ".wma",
    ".aiff", ".aif", ".webm", ".mka", ".mp4", ".mkv", ".amr", ".ac3", ".alac",
}


@dataclass
class Sound:
    path: str
    name: str = ""
    volume: int = 100  # per-sound gain, percent
    start: float = 0.0  # seconds into the file where the sound begins
    end: float = 0.0  # where it stops; 0 = the end of the file
    loop: bool = False  # repeat from start to end until stopped
    length: float = 0.0  # the file's length in seconds, once known

    @property
    def trimmed(self) -> bool:
        return self.start > 0 or self.end > 0

    def clip(self) -> dict:
        """Where to play: start, end (0 = to the file's end) and loop, for the players."""
        end = self.end
        if self.loop and not end:
            end = self.length  # a loop needs to know where to jump back from
        return {"start": self.start, "end": end, "loop": self.loop}

    def __post_init__(self) -> None:
        if not self.name:
            self.name = Path(self.path).stem


@dataclass
class Settings:
    mic_volume: int = 100
    monitor_volume: int = 60
    monitor_enabled: bool = True
    mic_passthrough: bool = True
    mic_source: str | None = None  # None = system default at startup
    make_default_mic: bool = True  # set our virtual mic as the system default input
    overlap: bool = False
    output_device: str | None = None  # virtual-cable mode: where sounds go (the cable's input)


@dataclass
class Library:
    sounds: list[Sound] = field(default_factory=list)
    settings: Settings = field(default_factory=Settings)

    @classmethod
    def load(cls) -> "Library":
        try:
            data = json.loads(CONFIG_FILE.read_text())
        except (OSError, ValueError):
            return cls()
        fields = Sound.__dataclass_fields__
        sounds = [Sound(**{k: v for k, v in s.items() if k in fields}) for s in data.get("sounds", []) if "path" in s]
        known = Settings.__dataclass_fields__
        settings = Settings(**{k: v for k, v in data.get("settings", {}).items() if k in known})
        return cls(sounds, settings)

    def save(self) -> None:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CONFIG_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2))
        tmp.replace(CONFIG_FILE)

    def add(self, path: str) -> bool:
        path = str(Path(path).resolve())
        if any(s.path == path for s in self.sounds):
            return False
        self.sounds.append(Sound(path))
        return True

    def find(self, key: str) -> int | None:
        """Resolve a 1-based index or a (case-insensitive) name/prefix to a list index."""
        if key.isdigit():
            i = int(key) - 1
            return i if 0 <= i < len(self.sounds) else None
        k = key.lower()
        for i, s in enumerate(self.sounds):
            if s.name.lower() == k:
                return i
        for i, s in enumerate(self.sounds):
            if s.name.lower().startswith(k):
                return i
        return None


def is_audio_file(path: str | Path) -> bool:
    return Path(path).suffix.lower() in AUDIO_EXTS
