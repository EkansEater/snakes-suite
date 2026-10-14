"""Audio device discovery.

Devices are (id, label) pairs. An id is whatever the OS backend needs to open
the device; ffmpeg_input() turns it into ffmpeg arguments.

Linux:   PulseAudio / PipeWire source names. System audio is the "monitor" of
         an output, so it always works.
Windows: DirectShow device names. System audio needs a loopback device such as
         "Stereo Mix" or VB-CABLE.
macOS:   AVFoundation device indexes. System audio needs a loopback device
         such as BlackHole.
"""

import json
import re
import sys

from .platforms import ffmpeg, run_text

LINUX = sys.platform.startswith("linux")
_LOOPBACK_HINTS = ("stereo mix", "what u hear", "virtual-audio-capturer", "cable output",
                   "blackhole", "loopback", "soundflower", "monitor of")


def ffmpeg_input(device):
    if sys.platform == "win32":
        return ["-f", "dshow", "-i", f"audio={device}"]
    if sys.platform == "darwin":
        return ["-f", "avfoundation", "-i", f":{device}"]
    return ["-f", "pulse", "-i", device]


def outputs():
    """Sources carrying what the computer is playing."""
    return [(i, l) for i, l, loop in _devices() if loop]


def inputs():
    """Microphones and other real inputs."""
    return [(i, l) for i, l, loop in _devices() if not loop]


def default_output():
    if LINUX:
        sink = run_text(["pactl", "get-default-sink"]).strip()
        return f"{sink}.monitor" if sink else None
    found = outputs()
    return found[0][0] if found else None


def default_input():
    if LINUX:
        src = run_text(["pactl", "get-default-source"]).strip()
        return src if src and not src.endswith(".monitor") else None
    found = inputs()
    return found[0][0] if found else None


def screen_devices():
    """macOS only: AVFoundation indexes of the capturable screens, in order."""
    return [i for i, label in _avfoundation("video") if label.lower().startswith("capture screen")]


# -- per-OS listing -------------------------------------------------------
def _devices():
    """[(id, label, is_loopback)]"""
    if LINUX:
        try:
            data = json.loads(run_text(["pactl", "-f", "json", "list", "sources"]) or "[]")
        except ValueError:
            data = []
        out = []
        for s in data:
            name = s.get("name", "")
            if name:
                label = s.get("description") or name
                out.append((name, label.removeprefix("Monitor of "), name.endswith(".monitor")))
        return out
    found = _dshow_audio() if sys.platform == "win32" else _avfoundation("audio")
    return [(i, label, any(h in label.lower() for h in _LOOPBACK_HINTS)) for i, label in found]


def _dshow_audio():
    if not ffmpeg():
        return []
    text = run_text([ffmpeg(), "-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], 10)
    names, in_audio = [], False
    for line in text.splitlines():
        if "DirectShow audio devices" in line:
            in_audio = True
        elif "DirectShow video devices" in line:
            in_audio = False
        m = re.search(r'"(.+)"', line)
        if not m or "Alternative name" in line:
            continue
        # new ffmpeg tags each device "(audio)"; old ffmpeg groups them in sections
        if "(audio)" in line or (in_audio and "(video)" not in line):
            names.append((m.group(1), m.group(1)))
    return names


def _avfoundation(section):
    if not ffmpeg():
        return []
    text = run_text([ffmpeg(), "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], 10)
    found, current = [], None
    for line in text.splitlines():
        if "AVFoundation video devices" in line:
            current = "video"
        elif "AVFoundation audio devices" in line:
            current = "audio"
        elif current == section:
            m = re.search(r"\[(\d+)\]\s+(.+)$", line)
            if m:
                found.append((m.group(1), m.group(2).strip()))
    return found
