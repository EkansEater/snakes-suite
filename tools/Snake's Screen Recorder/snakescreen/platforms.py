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

# Keep console windows from flashing up for helper processes on Windows.
POPEN_FLAGS = {"creationflags": subprocess.CREATE_NO_WINDOW} if sys.platform == "win32" else {}


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
