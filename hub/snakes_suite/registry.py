"""What tools exist, which are installed, and which can be downloaded.

Three sources: the catalogue (suite.json, built into the app) lists every
tool; the manifests written at install time say what is installed; the
release index (fetched by the app) says what can be downloaded for this
system, and so whether an update is waiting.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import integrate as ig
from . import packages

OS = ig.OS
ASSETS = Path(__file__).resolve().parent / "assets"


@dataclass
class Tool:
    id: str
    name: str
    tagline: str = ""
    description: str = ""
    platforms: list[str] = field(default_factory=list)
    needs: list[str] = field(default_factory=list)
    icon: Path | None = None
    entry: dict = field(default_factory=dict)  # its catalogue entry
    manifest: dict | None = None               # set when installed
    package: dict | None = None                # this system's download, when the index has one
    source: Path | None = None                 # its folder, when running from the kit

    @property
    def installed(self) -> bool:
        return self.manifest is not None

    @property
    def supported(self) -> bool:
        return not self.platforms or OS in self.platforms

    @property
    def downloadable(self) -> bool:
        return self.supported and self.package is not None

    @property
    def buildable(self) -> bool:
        """Can be installed from the kit's source with install.py (developers)."""
        return self.supported and self.source is not None and self.source.is_dir()

    @property
    def installable(self) -> bool:
        return self.downloadable or self.buildable

    @property
    def update_available(self) -> bool:
        if not (self.installed and self.package) or (self.manifest or {}).get("source_build"):
            return False
        mine = packages.version_tuple((self.manifest or {}).get("version", "0"))
        return packages.version_tuple(self.package.get("version", "0")) > mine


def kit_root() -> Path | None:
    """The folder holding suite.json and install.py, if this app runs from it (or knows it)."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "suite.json").exists() and (parent / "install.py").exists():
            return parent
    try:
        root = Path(json.loads((ig.DATA / "kit.json").read_text(encoding="utf-8"))["suite_root"])
        return root if (root / "install.py").exists() else None
    except (OSError, ValueError, KeyError):
        return None


def installer_python() -> str:
    try:
        py = json.loads((ig.DATA / "kit.json").read_text(encoding="utf-8"))["python"]
        if Path(py).exists():
            return py
    except (OSError, ValueError, KeyError):
        pass
    return sys.executable


def load_tools(index: dict | None = None) -> list[Tool]:
    """Every tool, in catalogue order, with its install and download state. The hub itself is left out."""
    data = packages.catalogue()
    kit = kit_root()
    manifests = {tool_id: ig.read_manifest(tool_id) for tool_id in ig.installed_ids()}
    tools: list[Tool] = []
    for entry in data.get("tools", []):
        icon = ASSETS / f"{entry.get('icon', entry['id'])}.svg"
        tools.append(Tool(
            id=entry["id"], name=entry["name"], tagline=entry.get("tagline", ""),
            description=entry.get("description", ""), platforms=entry.get("platforms", []),
            needs=entry.get("needs", []), icon=icon if icon.exists() else None, entry=entry,
            manifest=manifests.pop(entry["id"], None), package=packages.package_for(index, entry["id"]),
            source=(kit / entry["folder"]).resolve() if kit else None,
        ))
    manifests.pop("suite", None)
    for tool_id, m in manifests.items():  # installed from a newer catalogue than this app knows
        if not m:
            continue
        icon = (m.get("icons") or {}).get("svg") or (m.get("icons") or {}).get("png")
        tools.append(Tool(id=tool_id, name=m.get("name", tool_id), tagline=m.get("tagline", ""),
                          description=m.get("description", ""), icon=Path(icon) if icon else None,
                          entry={"id": tool_id, "name": m.get("name", tool_id)}, manifest=m))
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
