"""Per-OS glue: which capture backend to use and where ffmpeg lives."""

import functools
import os
import shutil
import subprocess
import sys


def _capture_kind():
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "macos"
    if os.environ.get("XDG_SESSION_TYPE") == "wayland" or os.environ.get("WAYLAND_DISPLAY"):
        return "portal"  # Wayland: screen access only through xdg-desktop-portal
    return "x11"


# portal | x11 | windows | macos
KIND = _capture_kind()

# Only the Wayland portal has its own window picker.
SUPPORTS_WINDOW_CAPTURE = KIND == "portal"

def _child_env():
    """The environment for ffmpeg, GStreamer and pactl.

    The packaged app (PyInstaller) points LD_LIBRARY_PATH at its own bundled
    libraries. System programs started with that path load those older copies
    and crash on start (gst-launch: "undefined symbol", ffmpeg: "GLIBCXX not
    found"), so nothing gets recorded. Give them the path the user started with.
    """
    env = dict(os.environ)
    if getattr(sys, "frozen", False):
        for var in ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH"):
            original = env.pop(f"{var}_ORIG", None)
            if original:
                env[var] = original
            else:
                env.pop(var, None)
    return env


# Keep console windows from flashing up for helper processes on Windows, and
# keep the packaged app's own libraries out of them everywhere.
POPEN_FLAGS = {"env": _child_env()}
if sys.platform == "win32":
    POPEN_FLAGS["creationflags"] = subprocess.CREATE_NO_WINDOW

# GStreamer elements the Wayland capture uses (recorder._portal_capture_cmd),
# with the Arch / Debian package that has them.
GST_ELEMENTS = {
    "pipewiresrc": "gst-plugin-pipewire / gstreamer1.0-pipewire",
    "x264enc": "gst-plugins-ugly / gstreamer1.0-plugins-ugly",
    "h264parse": "gst-plugins-bad / gstreamer1.0-plugins-bad",
    "videocrop": "gst-plugins-good / gstreamer1.0-plugins-good",
    "matroskamux": "gst-plugins-good / gstreamer1.0-plugins-good",
    "pulsesrc": "gst-plugins-good / gstreamer1.0-plugins-good",
    "flacenc": "gst-plugins-good / gstreamer1.0-plugins-good",
    "videorate": "gst-plugins-base / gstreamer1.0-plugins-base",
    "videoconvert": "gst-plugins-base / gstreamer1.0-plugins-base",
    "audioconvert": "gst-plugins-base / gstreamer1.0-plugins-base",
    "audioresample": "gst-plugins-base / gstreamer1.0-plugins-base",
}


_gst_ok = False  # once everything was found, skip the check on later recordings


def _missing_gst_elements():
    global _gst_ok
    if _gst_ok or not shutil.which("gst-inspect-1.0"):
        return []  # nothing to do, or cannot tell (gst-launch itself is checked separately)
    missing = []
    for element in GST_ELEMENTS:
        try:
            r = subprocess.run(["gst-inspect-1.0", "--exists", element], timeout=10,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, **POPEN_FLAGS)
        except (OSError, subprocess.SubprocessError):
            return []
        if r.returncode != 0:
            missing.append(element)
    _gst_ok = not missing
    return missing


@functools.cache
def ffmpeg():
    """Path to ffmpeg: the system one, else the copy bundled by imageio-ffmpeg."""
    path = shutil.which("ffmpeg")
    if path:
        return path
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def missing_tools():
    """Human-readable list of what must be installed before recording works."""
    missing = []
    if not ffmpeg():
        missing.append("ffmpeg (install it, or run: pip install imageio-ffmpeg)")
    if KIND == "portal":
        if not shutil.which("gst-launch-1.0"):
            missing.append("GStreamer (gst-launch-1.0 with the PipeWire and x264 plugins)")
        else:
            elements = _missing_gst_elements()
            for package in dict.fromkeys(GST_ELEMENTS[e] for e in elements):
                names = ", ".join(e for e in elements if GST_ELEMENTS[e] == package)
                missing.append(f"GStreamer plugins {names} (package {package})")
        try:
            import gi  # noqa: F401
        except ImportError:
            missing.append("PyGObject (python-gobject)")
    return missing


def run_text(cmd, timeout=5):
    """Run a helper and return stdout+stderr as text ('' on any failure)."""
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, errors="replace",
                           timeout=timeout, stdin=subprocess.DEVNULL, **POPEN_FLAGS)
        return r.stdout + r.stderr
    except (OSError, subprocess.SubprocessError):
        return ""
