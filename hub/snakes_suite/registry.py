"""What tools exist, which are installed, and how to start them.

The installer (install.py at the top of the kit) writes one manifest per
installed tool into the suite's data folder, plus kit.json saying where the kit
is. The catalogue (suite.json in the kit) lists every tool, installed or not.
data_dir() must agree with install.py.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

if sys.platform.startswith("win"):
    OS = "windows"
elif sys.platform == "darwin":
    OS = "macos"
else:
    OS = "linux"


def data_dir() -> Path:
    if OS == "windows":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "SnakesSuite"
    if OS == "macos":
        return Path.home() / "Library" / "Application Support" / "SnakesSuite"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "snakes-suite"


@dataclass
class Tool:
    id: str
    name: str
    tagline: str = ""
    description: str = ""
    platforms: list[str] = field(default_factory=list)
    needs: list[str] = field(default_factory=list)
    icon: Path | None = None
    manifest: dict | None = None      # set when installed
    source: Path | None = None        # its folder in the kit, when the kit is here

    @property
    def installed(self) -> bool:
        return self.manifest is not None

    @property
    def supported(self) -> bool:
        return not self.platforms or OS in self.platforms

    @property
    def installable(self) -> bool:
        return self.supported and self.source is not None and self.source.is_dir()


def kit_root() -> Path | None:
    """The folder holding suite.json and install.py, if this machine has it."""
    here = Path(__file__).resolve()
    for parent in here.parents:  # running from the kit itself
        if (parent / "suite.json").exists() and (parent / "install.py").exists():
            return parent
    try:
        root = Path(json.loads((data_dir() / "kit.json").read_text(encoding="utf-8"))["suite_root"])
        return root if (root / "suite.json").exists() else None
    except (OSError, ValueError, KeyError):
        return None


def installer_python() -> str:
    try:
        py = json.loads((data_dir() / "kit.json").read_text(encoding="utf-8"))["python"]
        if Path(py).exists():
            return py
    except (OSError, ValueError, KeyError):
        pass
    return sys.executable


def load_tools() -> list[Tool]:
    """Every tool, in catalogue order, with its install state. The hub itself is left out."""
    manifests = {}
    folder = data_dir() / "installed"
    if folder.is_dir():
        for path in sorted(folder.glob("*.json")):
            try:
                manifests[path.stem] = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue

    tools: list[Tool] = []
    root = kit_root()
    icons = Path(__file__).resolve().parent / "assets"
    if root:
        data = json.loads((root / "suite.json").read_text(encoding="utf-8"))
        for entry in data["tools"]:
            icon = icons / f"{entry.get('icon', entry['id'])}.svg"
            tools.append(Tool(
                id=entry["id"], name=entry["name"], tagline=entry.get("tagline", ""),
                description=entry.get("description", ""), platforms=entry.get("platforms", []),
                needs=entry.get("needs", []), icon=icon if icon.exists() else None,
                manifest=manifests.pop(entry["id"], None), source=(root / entry["folder"]).resolve(),
            ))
    manifests.pop("suite", None)
    # Installed tools the catalogue here does not know (installed from another kit).
    for tool_id, m in manifests.items():
        icon = m.get("icons", {}).get("svg") or m.get("icons", {}).get("png")
        tools.append(Tool(id=tool_id, name=m.get("name", tool_id), tagline=m.get("tagline", ""),
                          description=m.get("description", ""), icon=Path(icon) if icon else None, manifest=m))
    return tools


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if OS == "windows":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        code = ctypes.c_ulong()
        ok = kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
        kernel32.CloseHandle(handle)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True
