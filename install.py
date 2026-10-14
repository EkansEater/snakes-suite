#!/usr/bin/env python3
"""Install Snake's Suite tools from this source folder (for developing them).

People who just want the apps download the one-file Snake's Suite app instead,
which installs ready-made packages. This script builds each tool from source:

    python install.py                  choose from a list
    python install.py --all            every tool this system supports, plus the hub
    python install.py converter daw    just these (ids are listed by --list)
    python install.py --list           what there is, and what is installed
    python install.py --uninstall daw  remove a tool (--uninstall --all removes everything)

Add --desktop to also put a shortcut on the desktop.

Installed tools become normal apps (menu entries, Start menu, ~/Applications)
through hub/snakes_suite/integrate.py, the same code the Snake's Suite app uses.
Needs Python 3.10+; Rust builds the Compressor and the DAW, Node.js Snake's Code.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

SUITE = Path(__file__).resolve().parent
sys.path.insert(0, str(SUITE / "hub"))

from snakes_suite import integrate as ig  # noqa: E402 - stdlib only, found through the path above

CATALOGUE = SUITE / "suite.json"
ICON_SRC = SUITE / "shared" / "icons"
OS, EXE = ig.OS, ig.EXE
RUNTIME = ig.DATA / "runtime"  # one Python environment shared by every Python tool built from source


def say(text: str = "") -> None:
    print(text, flush=True)


class Failed(Exception):
    """A step failed; the message says what the user can do about it."""


def run(cmd: list, cwd: Path | None = None) -> None:
    say("  $ " + " ".join(shlex.quote(str(c)) for c in cmd))
    proc = subprocess.Popen([str(c) for c in cmd], cwd=cwd, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, errors="replace")
    assert proc.stdout
    for line in proc.stdout:
        print("    " + line.rstrip(), flush=True)
    if proc.wait() != 0:
        raise Failed(f"this command failed (exit code {proc.returncode}): {cmd[0]} {cmd[1] if len(cmd) > 1 else ''}")


def catalogue() -> dict[str, dict]:
    data = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    tools = {t["id"]: t for t in data["tools"]}
    tools[data["hub"]["id"]] = data["hub"]
    for tool in tools.values():
        tool["root"] = (SUITE / tool["folder"]).resolve()
        tool.setdefault("icon", tool["id"])
        tool.setdefault("version", data.get("version", "1.0.0"))
    return tools


# --------------------------------------------------------------------------- building
def runtime_python(gui: bool = False) -> Path:
    scripts = RUNTIME / ("Scripts" if OS == "windows" else "bin")
    if OS == "windows":
        return scripts / ("pythonw.exe" if gui else "python.exe")
    return scripts / "python3"


def ensure_runtime() -> Path:
    """The shared Python environment, created on first use."""
    py = runtime_python()
    # On Linux it also sees the system's packages: PyGObject (screen capture on Wayland) comes
    # from the distribution, not pip. What pip installs here still takes precedence.
    system_site = OS == "linux"
    if not py.exists():
        say("  Creating the shared Python environment (once for all Python tools)…")
        RUNTIME.parent.mkdir(parents=True, exist_ok=True)
        run([sys.executable, "-m", "venv", *(["--system-site-packages"] if system_site else []), RUNTIME])
        run([py, "-m", "pip", "install", "--upgrade", "--quiet", "pip"])
    elif system_site:
        cfg = RUNTIME / "pyvenv.cfg"
        text = cfg.read_text(encoding="utf-8")
        if "include-system-site-packages = false" in text:
            cfg.write_text(text.replace("include-system-site-packages = false",
                                        "include-system-site-packages = true"), encoding="utf-8")
    return py


def build_python(tool: dict) -> dict:
    py = ensure_runtime()
    run([py, "-m", "pip", "install", "--upgrade", "--quiet", "--no-warn-script-location", tool["root"]])
    return {"launch": [str(runtime_python(gui=True)), "-m", tool["module"]], "cwd": None,
            "cli": [str(runtime_python()), "-m", tool["module"]]}


def build_cargo(tool: dict) -> dict:
    if not shutil.which("cargo"):
        raise Failed("Rust is needed to build this tool. Install it from https://rustup.rs and run the installer again.")
    args = list(tool.get("cargo_args", [])) + list(tool.get("cargo_args_by_os", {}).get(OS, []))
    run(["cargo", "build", "--release", *args], cwd=tool["root"])
    dest = ig.APPS / tool["id"]
    dest.mkdir(parents=True, exist_ok=True)
    names = [tool["binary"], *tool.get("extra_binaries", [])]
    for name in names:
        src = tool["root"] / "target" / "release" / (name + EXE)
        if not src.exists():
            raise Failed(f"the build did not produce {src}")
        target = dest / (name + EXE)
        if target.exists():
            target.unlink()  # a running copy keeps its old file; a fresh one avoids "text file busy"
        shutil.copy2(src, target)
    command = tool.get("command")
    cli = dest / ((command if command in names else tool["binary"]) + EXE)
    return {"launch": [str(dest / (tool["binary"] + EXE))], "cwd": None, "cli": [str(cli)]}


def electron_binary(root: Path) -> Path:
    dist = root / "node_modules" / "electron" / "dist"
    if OS == "windows":
        return dist / "electron.exe"
    if OS == "macos":
        return dist / "Electron.app" / "Contents" / "MacOS" / "Electron"
    return dist / "electron"


def build_electron(tool: dict) -> dict:
    npm = shutil.which("npm")
    if not npm:
        raise Failed("Node.js is needed to build this tool. Install it from https://nodejs.org and run the installer again.")
    root = tool["root"]
    if not electron_binary(root).exists():
        run([npm, "install"], cwd=root)
    run([npm, "run", "build"], cwd=root)
    # From source, Snake's Code runs from its own folder: Electron needs node_modules beside it.
    return {"launch": [str(electron_binary(root)), str(root)], "cwd": str(root), "cli": None}


def build_script(tool: dict) -> dict:
    argv = tool.get("launch", {}).get(OS)
    if not argv:
        raise Failed(f"{tool['name']} has no launcher for {OS}.")
    root = tool["root"]
    return {"launch": [str(root / argv[0]), *argv[1:]], "cwd": str(root), "cli": None}


BUILDERS = {"python": build_python, "cargo": build_cargo, "electron": build_electron, "script": build_script}


# --------------------------------------------------------------------------- install / uninstall
def install(tool: dict, desktop: bool) -> bool:
    say(f"\n== {tool['name']} ==")
    if OS not in tool.get("platforms", []):
        say(f"  Skipped: {tool['name']} runs on {', '.join(tool['platforms'])} only, not {OS}.")
        return False
    if not tool["root"].is_dir():
        say(f"  Skipped: its source folder is missing ({tool['root']}).")
        return False
    old = ig.read_manifest(tool["id"])
    if old:
        ig.remove_integration(old)
    try:
        launch = BUILDERS[tool["kind"]](tool)
    except Failed as e:
        say(f"  Not installed: {e}")
        return False
    icons = ig.copy_icons(tool["id"], ICON_SRC, tool["icon"])
    uninstaller = [sys.executable, str(SUITE / "install.py"), "--uninstall", tool["id"], "--yes"]
    files, registry, notes = ig.integrate(tool, launch, icons, desktop=desktop, uninstaller=uninstaller)
    for note in notes:
        say(f"  {note}")
    ig.write_manifest({
        "id": tool["id"],
        "name": tool["name"],
        "tagline": tool.get("tagline", ""),
        "description": tool.get("description", ""),
        "kind": tool["kind"],
        "version": tool["version"],
        "source_build": True,
        "launch": launch["launch"],
        "cwd": launch.get("cwd"),
        "command": tool.get("command") if launch.get("cli") else None,
        "icons": icons,
        "source": str(tool["root"]),
        "files": files,
        "registry": registry,
        "desktop_shortcut": desktop,
        "installed": datetime.datetime.now().isoformat(timespec="seconds"),
    })
    # Lets the hub find this kit (for installing from source) when it runs from elsewhere.
    (ig.DATA / "kit.json").write_text(json.dumps({"suite_root": str(SUITE), "python": sys.executable}, indent=2),
                                      encoding="utf-8")
    where = {"linux": "application menu", "windows": "Start menu", "macos": "Applications folder"}[OS]
    say(f"  Installed. Find “{tool['name']}” in your {where}.")
    return True


def pip_name(tool: dict) -> str | None:
    pyproject = tool["root"] / "pyproject.toml"
    if pyproject.exists():
        for line in pyproject.read_text(encoding="utf-8").splitlines():
            if line.strip().startswith("name ="):
                return line.split("=", 1)[1].strip().strip('"')
    return None


def uninstall(tool_id: str, tools: dict) -> None:
    manifest = ig.read_manifest(tool_id)
    tool = tools.get(tool_id)
    name = tool["name"] if tool else tool_id
    if not manifest:
        say(f"{name} is not installed.")
        return
    say(f"\n== Removing {name} ==")
    for problem in ig.remove_integration(manifest):
        say(f"  {problem}")
    if manifest.get("kind") == "python" and tool and runtime_python().exists() and (dist := pip_name(tool)):
        subprocess.run([runtime_python(), "-m", "pip", "uninstall", "-y", "--quiet", dist], capture_output=True)
    ig.forget(tool_id)
    if not any((ig.read_manifest(t) or {}).get("kind") == "python" for t in ig.installed_ids()):
        shutil.rmtree(RUNTIME, ignore_errors=True)
    say("  Removed. Your own files (projects, recordings, settings) were left alone.")


# --------------------------------------------------------------------------- command line
def print_list(tools: dict) -> None:
    say(f"Snake's Suite on {OS}   (installs into {ig.DATA})\n")
    for i, tool in enumerate(tools.values(), 1):
        if OS not in tool.get("platforms", []):
            state = f"{'/'.join(tool['platforms'])} only"
        elif ig.read_manifest(tool["id"]):
            state = "installed"
        elif not tool["root"].is_dir():
            state = "source missing"
        else:
            state = "available"
        say(f"  {i:>2}. {tool['id']:<11} {tool['name']:<26} {state}")


def choose(tools: dict) -> list[str]:
    print_list(tools)
    ids = list(tools)
    answer = input("\nInstall which? Numbers or ids separated by spaces, 'all' for the kit, Enter to cancel: ").strip()
    if not answer:
        return []
    if answer.lower() == "all":
        return ["all"]
    picked = []
    for word in answer.replace(",", " ").split():
        if word.isdigit() and 1 <= int(word) <= len(ids):
            picked.append(ids[int(word) - 1])
        elif word in tools:
            picked.append(word)
        else:
            say(f"Not a tool: {word}")
    return picked


def main() -> int:
    if sys.version_info < (3, 10):
        say("Snake's Suite needs Python 3.10 or newer.")
        return 1
    parser = argparse.ArgumentParser(description="Install Snake's Suite tools from source.")
    parser.add_argument("tools", nargs="*", help="tool ids (see --list)")
    parser.add_argument("--all", action="store_true", help="the whole kit")
    parser.add_argument("--list", action="store_true", help="show the tools and what is installed")
    parser.add_argument("--uninstall", action="store_true", help="remove the named tools")
    parser.add_argument("--desktop", action="store_true", help="also add desktop shortcuts")
    parser.add_argument("--yes", action="store_true", help="do not ask for confirmation")
    args = parser.parse_args()
    tools = catalogue()

    if args.list:
        print_list(tools)
        return 0
    wanted = ["all"] if args.all else list(args.tools)
    if not wanted and not args.uninstall:
        try:
            wanted = choose(tools)
        except EOFError:
            return 0
        if not wanted:
            return 0
        if not args.desktop and input("Add desktop shortcuts too? [y/N] ").strip().lower().startswith("y"):
            args.desktop = True
    if wanted == ["all"]:
        wanted = ig.installed_ids() if args.uninstall else [t for t in tools if OS in tools[t].get("platforms", [])]
    unknown = [t for t in wanted if t not in tools]
    if unknown:
        say(f"Unknown tool(s): {', '.join(unknown)}. Try --list.")
        return 2

    if args.uninstall:
        if not args.yes and wanted and input(f"Remove {', '.join(wanted)}? [y/N] ").strip().lower()[:1] != "y":
            return 0
        for tool_id in wanted:
            uninstall(tool_id, tools)
        return 0

    wanted.sort(key=lambda t: t != "suite")  # the hub first, so it is there to open the rest
    results = {t: install(tools[t], args.desktop) for t in wanted}
    say("")
    done = [tools[t]["name"] for t, ok in results.items() if ok]
    failed = [tools[t]["name"] for t, ok in results.items() if not ok]
    if done:
        say("Installed: " + ", ".join(done))
    if failed:
        say("Not installed: " + ", ".join(failed) + "  (see the messages above)")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
