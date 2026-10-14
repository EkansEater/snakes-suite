"""Make an installed tool a normal app of the system, and undo that again.

Used both by the Snake's Suite app (installing downloaded packages) and by
install.py (installing from source), so it needs nothing beyond the standard
library.

    files, registry = integrate(meta, launch, icons, desktop=True, uninstaller=[...])

* Linux: a menu entry named after the window's app id (so the window, the
  taskbar and the menu all show the tool's icon), icons in the hicolor theme,
  an optional desktop launcher and a command in ~/.local/bin.
* Windows: Start menu shortcuts, an optional desktop shortcut and an entry
  under Settings > Apps > Installed apps.
* macOS: an app in ~/Applications and an optional alias on the desktop.

Every file made is listed in the tool's manifest, so remove_integration()
takes exactly those away again.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

if sys.platform.startswith("win"):
    OS = "windows"
elif sys.platform == "darwin":
    OS = "macos"
else:
    OS = "linux"
EXE = ".exe" if OS == "windows" else ""


def data_dir() -> Path:
    """Where the suite keeps installed apps, the manifests and icons."""
    if OS == "windows":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local")) / "SnakesSuite"
    if OS == "macos":
        return Path.home() / "Library" / "Application Support" / "SnakesSuite"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "snakes-suite"


DATA = data_dir()
APPS = DATA / "apps"
MANIFESTS = DATA / "installed"
ICONS = DATA / "icons"


def xdg_data() -> Path:
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))


def applications_dir() -> Path:
    """Where installed tools go on macOS."""
    return Path.home() / "Applications"


# --------------------------------------------------------------------------- manifests
def manifest_path(tool_id: str) -> Path:
    return MANIFESTS / f"{tool_id}.json"


def read_manifest(tool_id: str) -> dict | None:
    try:
        return json.loads(manifest_path(tool_id).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def write_manifest(manifest: dict) -> None:
    MANIFESTS.mkdir(parents=True, exist_ok=True)
    manifest_path(manifest["id"]).write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def installed_ids() -> list[str]:
    return sorted(p.stem for p in MANIFESTS.glob("*.json")) if MANIFESTS.is_dir() else []


# --------------------------------------------------------------------------- helpers
def _powershell(script: str, env: dict | None = None) -> str:
    flags = 0x08000000 if OS == "windows" else 0  # CREATE_NO_WINDOW: no console flashing up
    return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                          capture_output=True, text=True, check=True, env={**os.environ, **(env or {})},
                          creationflags=flags).stdout


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


def copy_icons(tool_id: str, source: Path, name: str | None = None) -> dict[str, str]:
    """Copy <name>.svg/.png/.ico from `source` into the suite's icon folder."""
    ICONS.mkdir(parents=True, exist_ok=True)
    out = {}
    for ext in ("svg", "png", "ico"):
        src = source / f"{name or tool_id}.{ext}"
        if src.exists():
            dst = ICONS / f"{tool_id}.{ext}"
            shutil.copy2(src, dst)
            out[ext] = str(dst)
    return out


def desktop_quote(arg: str) -> str:
    """Quote one argument for the Exec= line of a .desktop file."""
    if arg and all(c.isalnum() or c in "/._-+=:@," for c in arg):
        return arg.replace("%", "%%")
    escaped = "".join("\\" + c if c in '"`$\\' else c for c in arg)
    return '"' + escaped.replace("%", "%%") + '"'


def _remove(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    elif path.exists() or path.is_symlink():
        path.unlink()


def _write_command(command: str, cli: list[str], files: list) -> Path | None:
    """A small script in ~/.local/bin that runs the tool (Linux and macOS)."""
    bin_dir = Path.home() / ".local" / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    wrapper = bin_dir / command
    if wrapper.is_symlink() or wrapper.exists():
        wrapper.unlink()
    wrapper.write_text("#!/bin/sh\n# Installed by Snake's Suite\nexec "
                       + " ".join(shlex.quote(a) for a in cli) + ' "$@"\n', encoding="utf-8")
    wrapper.chmod(0o755)
    files.append(str(wrapper))
    return bin_dir if str(bin_dir) not in os.environ.get("PATH", "").split(os.pathsep) else None


# --------------------------------------------------------------------------- Linux
def _integrate_linux(meta: dict, launch: dict, icons: dict, desktop: bool, files: list, notes: list,
                     uninstaller: list[str] | None) -> None:
    # The window's app id names the menu entry: that is how Wayland desktops find a window's icon.
    app_id = meta.get("wm_class") or f"snakes-{meta['id']}"
    icon_name = f"snakes-{meta['id']}"
    hicolor = xdg_data() / "icons" / "hicolor"
    icon_file = None
    for ext, sub in (("svg", "scalable"), ("png", "512x512")):
        if ext in icons:
            dst = hicolor / sub / "apps" / f"{icon_name}.{ext}"
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(icons[ext], dst)
            files.append(str(dst))
            icon_file = icon_file or dst
    # A full path, not the theme name: Plasma remembers names it looked up and could not find, and
    # the hub's own window asks for "snakes-suite" before installing itself, so a bare name would
    # stay a blank icon in the menu and on the desktop until the next login.
    icon_ref = str(icon_file) if icon_file else icon_name

    exec_line = " ".join(desktop_quote(a) for a in launch["launch"])
    if meta.get("accepts_files"):
        exec_line += " %F"
    lines = [
        "[Desktop Entry]",
        "Type=Application",
        f"Name={meta['name']}",
        f"GenericName={meta.get('tagline', '')}",
        f"Comment={meta.get('description', '')}",
        f"Exec={exec_line}",
        f"Icon={icon_ref}",
        "Terminal=false",
        f"Categories={meta.get('categories', 'Utility;')}",
        f"StartupWMClass={app_id}",
        "X-Snakes-Suite=true",
    ]
    if launch.get("cwd"):
        lines.append(f"Path={launch['cwd']}")
    if uninstaller:
        # Menus and desktops show this when the entry is right-clicked: a home-folder app has
        # no package manager to offer "Uninstall", so it brings its own.
        lines += ["Actions=uninstall;", "", "[Desktop Action uninstall]", f"Name=Uninstall {meta['name']}",
                  "Icon=edit-delete", "Exec=" + " ".join(desktop_quote(a) for a in uninstaller)]
    entry = "\n".join(lines) + "\n"

    apps = xdg_data() / "applications"
    apps.mkdir(parents=True, exist_ok=True)
    menu = apps / f"{app_id}.desktop"
    for legacy in [*meta.get("legacy_desktop", []), f"snakes-{meta['id']}.desktop"]:
        old = apps / legacy
        if old.exists() and old != menu:
            old.unlink()
            notes.append(f"Replaced the old menu entry {old.name}.")
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

    if meta.get("command") and launch.get("cli"):
        missing = _write_command(meta["command"], launch["cli"], files)
        if missing:
            notes.append(f"Add {missing} to your PATH to use the tools' commands (like `{meta['command']}`).")

    refresh_linux_menus()


def refresh_linux_menus() -> None:
    """Tell the desktop that menu entries and icons changed, so it shows them without a restart."""
    apps = xdg_data() / "applications"
    hicolor = xdg_data() / "icons" / "hicolor"
    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(apps)], capture_output=True)
    if hicolor.is_dir():
        ok = shutil.which("gtk-update-icon-cache") and subprocess.run(
            ["gtk-update-icon-cache", "-q", "-t", str(hicolor)], capture_output=True).returncode == 0
        if not ok:
            # An old cache that cannot be rebuilt (another app's oddly named icon is enough) hides
            # every icon added since. With no cache, icons are simply looked up on disk.
            (hicolor / "icon-theme.cache").unlink(missing_ok=True)
            (hicolor / ".icon-theme.cache").unlink(missing_ok=True)
        os.utime(hicolor)
    # KDE Plasma keeps its own copy of the menu and remembers icons it could not find.
    for tool in ("kbuildsycoca6", "kbuildsycoca5"):
        if shutil.which(tool):
            subprocess.run([tool], capture_output=True)
            break
    if shutil.which("dbus-send"):
        subprocess.run(["dbus-send", "--session", "--type=signal", "/KIconLoader",
                        "org.kde.KIconLoader.iconChanged", "int32:0"], capture_output=True)


# --------------------------------------------------------------------------- Windows
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


def _integrate_windows(meta: dict, launch: dict, icons: dict, desktop: bool, files: list,
                       registry: list, uninstaller: list[str] | None) -> None:
    target, *args = launch["launch"]
    cwd = launch.get("cwd") or str(Path(target).parent)
    # A packaged .exe carries the icon itself; a tool run by Python points at the .ico.
    packaged_exe = target.lower().endswith(".exe") and "python" not in Path(target).name.lower()
    icon = target if packaged_exe else icons.get("ico")
    menu = Path(os.environ["APPDATA"]) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Snake's Suite"
    links = [menu / f"{meta['name']}.lnk"]
    if desktop:
        links.append(desktop_dir() / f"{meta['name']}.lnk")
    for link in links:
        _windows_shortcut(link, target, args, cwd, icon)
        files.append(str(link))

    if uninstaller:
        import winreg

        key_path = rf"Software\Microsoft\Windows\CurrentVersion\Uninstall\SnakesSuite.{meta['id']}"
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as key:
            values = {
                "DisplayName": meta["name"],
                "DisplayVersion": meta.get("version", "1.0.0"),
                "Publisher": "Snake",
                "DisplayIcon": icon or target,
                "InstallLocation": str(Path(target).parent),
                "UninstallString": subprocess.list2cmdline(uninstaller),
            }
            for name, value in values.items():
                winreg.SetValueEx(key, name, 0, winreg.REG_SZ, value)
            for name in ("NoModify", "NoRepair"):
                winreg.SetValueEx(key, name, 0, winreg.REG_DWORD, 1)
        registry.append(key_path)


# --------------------------------------------------------------------------- macOS
def make_icns(png: str, dest: Path) -> bool:
    """A macOS .icns from a 512 px PNG, made with the system's own tools."""
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


def _integrate_macos(meta: dict, launch: dict, icons: dict, desktop: bool, files: list, notes: list) -> None:
    app = applications_dir() / f"{meta['name']}.app"
    if launch.get("app_bundle"):
        # A ready-made app (a downloaded package): it already sits in ~/Applications.
        app = Path(launch["app_bundle"])
    else:
        # From source: wrap the command in a small app bundle.
        if app.exists():
            shutil.rmtree(app)
        contents = app / "Contents"
        (contents / "MacOS").mkdir(parents=True)
        (contents / "Resources").mkdir()
        executable = "launcher"
        if meta.get("kind") == "cargo":
            executable = Path(launch["launch"][0]).name
            shutil.copy2(launch["launch"][0], contents / "MacOS" / executable)
        else:
            script = contents / "MacOS" / executable
            cd = f"cd {shlex.quote(launch['cwd'])} || exit 1\n" if launch.get("cwd") else ""
            script.write_text("#!/bin/sh\n" + cd + "exec " + " ".join(shlex.quote(a) for a in launch["launch"])
                              + ' "$@"\n', encoding="utf-8")
            script.chmod(0o755)
        has_icon = "png" in icons and make_icns(icons["png"], contents / "Resources" / "icon.icns")
        plist = {
            "CFBundleName": meta["name"],
            "CFBundleDisplayName": meta["name"],
            "CFBundleIdentifier": f"com.snake.suite.{meta['id']}",
            "CFBundleExecutable": executable,
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": meta.get("version", "1.0.0"),
            "NSHighResolutionCapable": True,
            "NSMicrophoneUsageDescription": f"{meta['name']} records from your microphone or audio interface.",
        }
        if has_icon:
            plist["CFBundleIconFile"] = "icon"
        import plistlib

        with open(contents / "Info.plist", "wb") as fh:
            plistlib.dump(plist, fh)
    files.append(str(app))
    if desktop:
        alias = desktop_dir() / f"{meta['name']}.app"
        if alias.is_symlink() or alias.exists():
            alias.unlink()
        alias.symlink_to(app)
        files.append(str(alias))
    if meta.get("command") and launch.get("cli"):
        missing = _write_command(meta["command"], launch["cli"], files)
        if missing:
            notes.append(f"Add {missing} to your PATH to use the tools' commands (like `{meta['command']}`).")


# --------------------------------------------------------------------------- entry points
def integrate(meta: dict, launch: dict, icons: dict, *, desktop: bool = False,
              uninstaller: list[str] | None = None) -> tuple[list[str], list[str], list[str]]:
    """Register an installed tool with the system. Returns (files, registry keys, notes)."""
    files: list[str] = []
    registry: list[str] = []
    notes: list[str] = []
    if OS == "linux":
        _integrate_linux(meta, launch, icons, desktop, files, notes, uninstaller)
    elif OS == "windows":
        _integrate_windows(meta, launch, icons, desktop, files, registry, uninstaller)
    else:
        _integrate_macos(meta, launch, icons, desktop, files, notes)
    return files, registry, notes


def remove_integration(manifest: dict) -> list[str]:
    """Take away everything integrate() made. Returns the problems met, if any."""
    problems = []
    for f in manifest.get("files", []):
        try:
            _remove(Path(f))
        except OSError as e:
            problems.append(f"Could not remove {f}: {e}")
    if OS == "windows":
        import winreg

        for key in manifest.get("registry", []):
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, key)
            except OSError:
                pass
    if OS == "linux":
        refresh_linux_menus()
    return problems


def forget(tool_id: str) -> None:
    """Remove a tool's manifest and program folder; tidy up when nothing is left."""
    manifest_path(tool_id).unlink(missing_ok=True)
    shutil.rmtree(APPS / tool_id, ignore_errors=True)
    if not installed_ids():
        shutil.rmtree(DATA, ignore_errors=True)
