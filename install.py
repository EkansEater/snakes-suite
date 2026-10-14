#!/usr/bin/env python3
"""Install Snake's Suite tools as normal apps, one at a time or the whole kit.

    python install.py                  choose from a list
    python install.py --all            the whole kit: every tool this system supports, plus the hub
    python install.py converter daw    just these (ids are listed by --list)
    python install.py --list           what there is, and what is installed
    python install.py --uninstall daw  remove a tool (--uninstall --all removes everything)

Add --desktop to also put a shortcut on the desktop.

Installed tools show up like any other app: in the application menu on Linux
(with a command on your PATH in ~/.local/bin), in the Start menu and under
"Installed apps" on Windows, and in ~/Applications on macOS. Each one is
listed in a small manifest that the Snake's Suite hub reads.

Needs only Python 3.10+. Building some tools needs more: Rust for the
Compressor and the DAW, Node.js for Snake's Code; the installer says so.
New tools are added by describing them in suite.json; nothing here changes.
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
import tempfile
from pathlib import Path

SUITE = Path(__file__).resolve().parent
CATALOGUE = SUITE / "suite.json"
ICON_SRC = SUITE / "shared" / "icons"

if sys.platform.startswith("win"):
    OS = "windows"
elif sys.platform == "darwin":
    OS = "macos"
else:
    OS = "linux"
EXE = ".exe" if OS == "windows" else ""


# --------------------------------------------------------------------------- places
def data_dir() -> Path:
    """Where the suite keeps installed apps, the shared Python and the manifests."""
    if OS == "windows":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "SnakesSuite"
    if OS == "macos":
        return Path.home() / "Library" / "Application Support" / "SnakesSuite"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "snakes-suite"


DATA = data_dir()
APPS = DATA / "apps"            # built programs, one folder per tool
RUNTIME = DATA / "runtime"      # one Python environment shared by every Python tool
MANIFESTS = DATA / "installed"  # <id>.json for each installed tool
ICONS = DATA / "icons"


def xdg_data() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))


def desktop_dir() -> Path:
    if OS == "linux" and shutil.which("xdg-user-dir"):
        out = subprocess.run(["xdg-user-dir", "DESKTOP"], capture_output=True, text=True).stdout.strip()
        if out:
            return Path(out)
    if OS == "windows":
        try:
            out = _powershell("[Environment]::GetFolderPath('Desktop')").strip()
            if out:
                return Path(out)
        except (OSError, subprocess.CalledProcessError):
            pass
    return Path.home() / "Desktop"


# --------------------------------------------------------------------------- output
def say(text: str = "") -> None:
    print(text, flush=True)


class Failed(Exception):
    """A step failed; the message says what the user can do about it."""


def run(cmd: list, cwd: Path | None = None, env: dict | None = None) -> None:
    say("  $ " + " ".join(shlex.quote(str(c)) for c in cmd))
    merged = {**os.environ, **(env or {})}
    proc = subprocess.Popen([str(c) for c in cmd], cwd=cwd, env=merged, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, errors="replace")
    assert proc.stdout
    for line in proc.stdout:
        print("    " + line.rstrip(), flush=True)
    if proc.wait() != 0:
        raise Failed(f"this command failed (exit code {proc.returncode}): {cmd[0]} {cmd[1] if len(cmd) > 1 else ''}")


# --------------------------------------------------------------------------- catalogue
def catalogue() -> dict[str, dict]:
    data = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    tools = {t["id"]: t for t in data["tools"]}
    tools[data["hub"]["id"]] = data["hub"]
    for tool in tools.values():
        tool["root"] = (SUITE / tool["folder"]).resolve()
        tool.setdefault("icon", tool["id"])
    return tools


def manifest_path(tool_id: str) -> Path:
    return MANIFESTS / f"{tool_id}.json"


def read_manifest(tool_id: str) -> dict | None:
    try:
        return json.loads(manifest_path(tool_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


# --------------------------------------------------------------------------- building
def runtime_python(gui: bool = False) -> Path:
    scripts = RUNTIME / ("Scripts" if OS == "windows" else "bin")
    if OS == "windows":
        return scripts / ("pythonw.exe" if gui else "python.exe")
    return scripts / "python3"


def ensure_runtime() -> Path:
    """The shared Python environment, created on first use."""
    py = runtime_python()
    # On Linux the environment also sees the system's Python packages: some things the tools
    # use there (PyGObject for screen capture on Wayland) come from the distribution, not pip.
    # Packages pip installs into the environment still take precedence.
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
    dest = APPS / tool["id"]
    dest.mkdir(parents=True, exist_ok=True)
    names = [tool["binary"], *tool.get("extra_binaries", [])]
    for name in names:
        src = tool["root"] / "target" / "release" / (name + EXE)
        if not src.exists():
            raise Failed(f"the build did not produce {src}")
        target = dest / (name + EXE)
        if target.exists():
            target.unlink()  # a running copy on Linux keeps its old file; a fresh one avoids "text file busy"
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
    # Snake's Code runs from its own folder: Electron apps need their node_modules beside them.
    return {"launch": [str(electron_binary(root)), str(root)], "cwd": str(root), "cli": None}


def build_script(tool: dict) -> dict:
    argv = tool.get("launch", {}).get(OS)
    if not argv:
        raise Failed(f"{tool['name']} has no launcher for {OS}.")
    root = tool["root"]
    first = root / argv[0]
    return {"launch": [str(first), *argv[1:]], "cwd": str(root), "cli": None}


BUILDERS = {"python": build_python, "cargo": build_cargo, "electron": build_electron, "script": build_script}


# --------------------------------------------------------------------------- integration
def copy_icons(tool: dict) -> dict[str, str]:
    ICONS.mkdir(parents=True, exist_ok=True)
    out = {}
    for ext in ("svg", "png", "ico"):
        src = ICON_SRC / f"{tool['icon']}.{ext}"
        if src.exists():
            dst = ICONS / f"{tool['id']}.{ext}"
            shutil.copy2(src, dst)
            out[ext] = str(dst)
    return out


def desktop_quote(arg: str) -> str:
    """Quote one argument for the Exec= line of a .desktop file."""
    if arg and all(c.isalnum() or c in "/._-+=:@," for c in arg):
        return arg.replace("%", "%%")
    escaped = "".join("\\" + c if c in '"`$\\' else c for c in arg)
    return '"' + escaped.replace("%", "%%") + '"'


def integrate_linux(tool: dict, launch: dict, icons: dict, files: list, desktop: bool) -> None:
    app_id = f"snakes-{tool['id']}"
    hicolor = xdg_data() / "icons" / "hicolor"
    for ext, sub in (("svg", "scalable"), ("png", "512x512")):
        if ext in icons:
            dst = hicolor / sub / "apps" / f"{app_id}.{ext}"
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(icons[ext], dst)
            files.append(str(dst))

    exec_line = " ".join(desktop_quote(a) for a in launch["launch"])
    if tool.get("accepts_files"):
        exec_line += " %F"
    lines = [
        "[Desktop Entry]",
        "Type=Application",
        f"Name={tool['name']}",
        f"GenericName={tool.get('tagline', '')}",
        f"Comment={tool.get('description', '')}",
        f"Exec={exec_line}",
        f"Icon={app_id}",
        "Terminal=false",
        f"Categories={tool.get('categories', 'Utility;')}",
        f"StartupWMClass={tool.get('wm_class', app_id)}",
        "X-Snakes-Suite=true",
    ]
    if launch.get("cwd"):
        lines.append(f"Path={launch['cwd']}")
    entry = "\n".join(lines) + "\n"

    apps = xdg_data() / "applications"
    apps.mkdir(parents=True, exist_ok=True)
    for legacy in tool.get("legacy_desktop", []):
        old = apps / legacy
        if old.exists() and old.name != f"{app_id}.desktop":
            old.unlink()
            say(f"  Removed the old menu entry {old.name} (replaced by this install).")
    menu = apps / f"{app_id}.desktop"
    menu.write_text(entry, encoding="utf-8")
    files.append(str(menu))

    if desktop:
        shortcut = desktop_dir() / f"{app_id}.desktop"
        shortcut.parent.mkdir(parents=True, exist_ok=True)
        shortcut.write_text(entry, encoding="utf-8")
        shortcut.chmod(0o755)
        if shutil.which("gio"):  # GNOME only runs desktop launchers marked as trusted
            subprocess.run(["gio", "set", str(shortcut), "metadata::trusted", "true"], capture_output=True)
        files.append(str(shortcut))

    command = tool.get("command")
    if command and launch.get("cli"):
        bin_dir = Path.home() / ".local" / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        wrapper = bin_dir / command
        if wrapper.is_symlink() or wrapper.exists():
            wrapper.unlink()
        wrapper.write_text("#!/bin/sh\n# Installed by Snake's Suite\nexec "
                           + " ".join(shlex.quote(a) for a in launch["cli"]) + ' "$@"\n', encoding="utf-8")
        wrapper.chmod(0o755)
        files.append(str(wrapper))
        if str(bin_dir) not in os.environ.get("PATH", "").split(os.pathsep):
            say(f"  Note: add {bin_dir} to your PATH to use the `{command}` command.")

    for tool_cmd in (["update-desktop-database", str(apps)], ["gtk-update-icon-cache", "-q", "-t", str(hicolor)]):
        if shutil.which(tool_cmd[0]):
            subprocess.run(tool_cmd, capture_output=True)


def _powershell(script: str, env: dict | None = None) -> str:
    return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                          capture_output=True, text=True, check=True, env={**os.environ, **(env or {})}).stdout


def _windows_shortcut(path: Path, target: str, args: list[str], cwd: str | None, icon: str | None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Values travel in environment variables so that no quoting can go wrong.
    _powershell(
        "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:SNAKE_LNK);"
        "$s.TargetPath = $env:SNAKE_TARGET; $s.Arguments = $env:SNAKE_ARGS;"
        "if ($env:SNAKE_CWD) { $s.WorkingDirectory = $env:SNAKE_CWD };"
        "if ($env:SNAKE_ICON) { $s.IconLocation = $env:SNAKE_ICON };"
        "$s.Save()",
        env={"SNAKE_LNK": str(path), "SNAKE_TARGET": target, "SNAKE_ARGS": subprocess.list2cmdline(args),
             "SNAKE_CWD": cwd or "", "SNAKE_ICON": icon or ""},
    )


def integrate_windows(tool: dict, launch: dict, icons: dict, files: list, desktop: bool, registry: list) -> None:
    target, *args = launch["launch"]
    cwd = launch.get("cwd") or str(Path(target).parent)
    menu = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Snake's Suite"
    links = [menu / f"{tool['name']}.lnk"]
    if desktop:
        links.append(desktop_dir() / f"{tool['name']}.lnk")
    for link in links:
        _windows_shortcut(link, target, args, cwd, icons.get("ico"))
        files.append(str(link))

    # Listed under Settings > Apps > Installed apps, with an Uninstall button.
    import winreg  # noqa: PLC0415 - Windows only

    key_path = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\SnakesSuite.{tool['id']}"
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
        values = {
            "DisplayName": tool["name"],
            "DisplayVersion": tool.get("version", "1.0.0"),
            "Publisher": "Snake",
            "DisplayIcon": icons.get("ico", target),
            "InstallLocation": str(APPS / tool["id"]) if (APPS / tool["id"]).exists() else str(tool["root"]),
            "UninstallString": subprocess.list2cmdline(
                [sys.executable, str(SUITE / "install.py"), "--uninstall", tool["id"], "--yes"]),
        }
        for name, value in values.items():
            winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
        for name in ("NoModify", "NoRepair"):
            winreg.SetValueEx(key, name, 0, winreg.REG_DWORD, 1)
    registry.append(key_path)


def _icns(png: str, dest: Path) -> bool:
    """Make a macOS .icns from the 512 px PNG with the system's own tools."""
    if not (shutil.which("sips") and shutil.which("iconutil")):
        return False
    with tempfile.TemporaryDirectory() as tmp:
        iconset = Path(tmp) / "icon.iconset"
        iconset.mkdir()
        for size in (16, 32, 64, 128, 256, 512):
            for scale in (1, 2):
                px = size * scale
                if px > 512:
                    continue
                name = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
                subprocess.run(["sips", "-z", str(px), str(px), png, "--out", str(iconset / name)],
                               capture_output=True, check=True)
        subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(dest)], capture_output=True, check=True)
    return dest.exists()


def integrate_macos(tool: dict, launch: dict, icons: dict, files: list, desktop: bool) -> None:
    app = Path.home() / "Applications" / f"{tool['name']}.app"
    if app.exists():
        shutil.rmtree(app)
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Resources").mkdir()
    executable = "launcher"
    if tool["kind"] == "cargo":
        # The real program inside the bundle, so permission prompts (microphone) name the app.
        executable = Path(launch["launch"][0]).name
        shutil.copy2(launch["launch"][0], contents / "MacOS" / executable)
    else:
        script = contents / "MacOS" / executable
        cd = f"cd {shlex.quote(launch['cwd'])} || exit 1\n" if launch.get("cwd") else ""
        script.write_text("#!/bin/sh\n" + cd + "exec " + " ".join(shlex.quote(a) for a in launch["launch"])
                          + ' "$@"\n', encoding="utf-8")
        script.chmod(0o755)
    has_icon = "png" in icons and _icns(icons["png"], contents / "Resources" / "icon.icns")
    plist = {
        "CFBundleName": tool["name"],
        "CFBundleDisplayName": tool["name"],
        "CFBundleIdentifier": f"com.snake.suite.{tool['id']}",
        "CFBundleExecutable": executable,
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": tool.get("version", "1.0.0"),
        "NSHighResolutionCapable": True,
        "NSMicrophoneUsageDescription": f"{tool['name']} records from your microphone or audio interface.",
    }
    if has_icon:
        plist["CFBundleIconFile"] = "icon"
    import plistlib  # noqa: PLC0415

    with open(contents / "Info.plist", "wb") as fh:
        plistlib.dump(plist, fh)
    files.append(str(app))
    if desktop:
        alias = desktop_dir() / f"{tool['name']}.app"
        if alias.is_symlink() or alias.exists():
            alias.unlink()
        alias.symlink_to(app)
        files.append(str(alias))
    command = tool.get("command")
    if command and launch.get("cli"):
        bin_dir = Path.home() / ".local" / "bin"
        bin_dir.mkdir(parents=True, exist_ok=True)
        wrapper = bin_dir / command
        wrapper.write_text("#!/bin/sh\nexec " + " ".join(shlex.quote(a) for a in launch["cli"]) + ' "$@"\n',
                           encoding="utf-8")
        wrapper.chmod(0o755)
        files.append(str(wrapper))


# --------------------------------------------------------------------------- install / uninstall
def install(tool: dict, desktop: bool) -> bool:
    say(f"\n== {tool['name']} ==")
    if OS not in tool.get("platforms", []):
        say(f"  Skipped: {tool['name']} runs on {', '.join(tool['platforms'])} only, not {OS}.")
        return False
    if not tool["root"].is_dir():
        say(f"  Skipped: its source folder is missing ({tool['root']}).")
        return False
    old = read_manifest(tool["id"])
    if old:
        remove_integration(old, quiet=True)
    try:
        launch = BUILDERS[tool["kind"]](tool)
        icons = copy_icons(tool)
        files: list[str] = []
        registry: list[str] = []
        if OS == "linux":
            integrate_linux(tool, launch, icons, files, desktop)
        elif OS == "windows":
            integrate_windows(tool, launch, icons, files, desktop, registry)
        else:
            integrate_macos(tool, launch, icons, files, desktop)
    except Failed as e:
        say(f"  Not installed: {e}")
        return False
    manifest = {
        "id": tool["id"],
        "name": tool["name"],
        "tagline": tool.get("tagline", ""),
        "description": tool.get("description", ""),
        "kind": tool["kind"],
        "version": tool.get("version", "1.0.0"),
        "launch": launch["launch"],
        "cwd": launch.get("cwd"),
        "command": tool.get("command") if launch.get("cli") else None,
        "icons": icons,
        "source": str(tool["root"]),
        "files": files,
        "registry": registry,
        "desktop_shortcut": desktop,
        "installed": datetime.datetime.now().isoformat(timespec="seconds"),
    }
    MANIFESTS.mkdir(parents=True, exist_ok=True)
    manifest_path(tool["id"]).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    # Lets the hub find the installer and the catalogue for tools not installed yet.
    (DATA / "kit.json").write_text(json.dumps({"suite_root": str(SUITE), "python": sys.executable}, indent=2),
                                   encoding="utf-8")
    say(f"  Installed. Find “{tool['name']}” in your {'application menu' if OS == 'linux' else 'Start menu' if OS == 'windows' else 'Applications folder'}.")
    return True


def remove_integration(manifest: dict, quiet: bool = False) -> None:
    for f in manifest.get("files", []):
        p = Path(f)
        try:
            if p.is_dir() and not p.is_symlink():
                shutil.rmtree(p)
            elif p.exists() or p.is_symlink():
                p.unlink()
        except OSError as e:
            if not quiet:
                say(f"  Could not remove {p}: {e}")
    if OS == "windows":
        import winreg  # noqa: PLC0415

        for key in manifest.get("registry", []):
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
            except OSError:
                pass


def uninstall(tool_id: str, tools: dict) -> None:
    manifest = read_manifest(tool_id)
    name = tools.get(tool_id, {}).get("name", tool_id)
    if not manifest:
        say(f"{name} is not installed.")
        return
    say(f"\n== Removing {name} ==")
    remove_integration(manifest)
    shutil.rmtree(APPS / tool_id, ignore_errors=True)
    if manifest.get("kind") == "python" and (tool := tools.get(tool_id)) and runtime_python().exists():
        dist = tool["root"] / "pyproject.toml"
        dist_name = None
        if dist.exists():
            for line in dist.read_text(encoding="utf-8").splitlines():
                if line.strip().startswith("name ="):
                    dist_name = line.split("=", 1)[1].strip().strip('"')
                    break
        if dist_name:
            subprocess.run([runtime_python(), "-m", "pip", "uninstall", "-y", "--quiet", dist_name], capture_output=True)
    manifest_path(tool_id).unlink(missing_ok=True)
    remaining = [p for p in MANIFESTS.glob("*.json")] if MANIFESTS.exists() else []
    if not any((read_manifest(p.stem) or {}).get("kind") == "python" for p in remaining):
        shutil.rmtree(RUNTIME, ignore_errors=True)
    if not remaining:
        shutil.rmtree(DATA, ignore_errors=True)
    if OS == "linux" and shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(xdg_data() / "applications")], capture_output=True)
    say("  Removed. Your own files (projects, recordings, settings) were left alone.")


# --------------------------------------------------------------------------- command line
def print_list(tools: dict) -> None:
    say(f"Snake's Suite on {OS}   (installs into {DATA})\n")
    for i, tool in enumerate(tools.values(), 1):
        installed = read_manifest(tool["id"])
        if OS not in tool.get("platforms", []):
            state = f"{'/'.join(tool['platforms'])} only"
        elif installed:
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
    parser = argparse.ArgumentParser(description="Install Snake's Suite tools as normal apps.")
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
    wanted = list(args.tools)
    if args.all:
        wanted = ["all"]
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
        wanted = [t for t in tools if OS in tools[t].get("platforms", [])]
        if args.uninstall:
            wanted = [p.stem for p in MANIFESTS.glob("*.json")] if MANIFESTS.exists() else []
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

    # The hub first, so that it is there to open the rest.
    wanted.sort(key=lambda t: t != "suite")
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
