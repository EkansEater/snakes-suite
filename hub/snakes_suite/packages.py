"""Install ready-made tool packages, the way the one-file Snake's Suite app does.

The release on GitHub has an index.json listing, for every tool and system,
the archive to download with its size and SHA-256. The app downloads one
(see app.py), then hands it to install_package(), which checks it, unpacks it
into the suite's data folder (macOS: the .app goes into ~/Applications) and
makes it a normal app with integrate.py. Nothing here needs Qt.
"""

from __future__ import annotations

import datetime
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

from . import integrate as ig

HERE = Path(__file__).resolve().parent
ASSETS = HERE / "assets"


def arch() -> str:
    machine = platform.machine().lower()
    return {"amd64": "x86_64", "x64": "x86_64", "aarch64": "arm64"}.get(machine, machine)


PLATFORM = f"{ig.OS}-{arch()}"
FROZEN = bool(getattr(sys, "frozen", False))


def catalogue() -> dict:
    """suite.json: from the kit when running from source, else the copy built into the app,
    else the kit this app was installed from."""
    paths = [HERE.parent.parent / "suite.json", HERE / "catalogue.json"]
    try:
        paths.append(Path(json.loads((ig.DATA / "kit.json").read_text(encoding="utf-8"))["suite_root"]) / "suite.json")
    except (OSError, ValueError, KeyError):
        pass
    for path in paths:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
    return {"tools": [], "hub": {}}


def index_url() -> str:
    return os.environ.get("SNAKES_SUITE_INDEX") or catalogue().get("release", {}).get("index_url", "")


def package_for(index: dict | None, tool_id: str) -> dict | None:
    """This system's package of a tool in the release index, with its download URL."""
    if not index:
        return None
    entry = index.get("tools", {}).get(tool_id)
    pkg = (entry or {}).get("packages", {}).get(PLATFORM)
    if not pkg:
        return None
    base = index_url().rsplit("/", 1)[0]
    return {**pkg, "version": entry.get("version", "1.0.0"), "url": f"{base}/{pkg['file']}"}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def version_tuple(v: str) -> tuple:
    return tuple(int(p) if p.isdigit() else 0 for p in str(v).split("."))


class InstallError(Exception):
    pass


# --------------------------------------------------------------------------- settings
SETTINGS = ig.DATA / "settings.json"


def settings() -> dict:
    """The app's own choices, such as whether to update by itself. Updating by itself is on unless turned off."""
    try:
        data = json.loads(SETTINGS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    return {"auto_update": True, **data}


def save_setting(name: str, value) -> None:
    data = settings()
    data[name] = value
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _extract(archive: Path, dest: Path) -> None:
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as z:
            for member in z.namelist():
                target = (dest / member).resolve()
                if not str(target).startswith(str(dest.resolve())):
                    raise InstallError(f"unsafe path in the package: {member}")
            z.extractall(dest)
    else:
        with tarfile.open(archive) as t:
            try:
                t.extractall(dest, filter="tar")  # refuses paths that would land outside dest
            except TypeError:  # Python before 3.10.12 has no filters: check the paths ourselves
                root = dest.resolve()
                for member in t.getmembers():
                    if not str((dest / member.name).resolve()).startswith(str(root)):
                        raise InstallError(f"unsafe path in the package: {member.name}")
                t.extractall(dest)


def _userns_restricted() -> bool:
    """Ubuntu 24.04 and later block what Electron's sandbox needs unless an AppArmor profile allows it."""
    try:
        return Path("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").read_text().strip() == "1"
    except OSError:
        return False


def hub_command() -> list[str]:
    """How to run this app again: for uninstall entries and the command line."""
    if FROZEN:
        installed = ig.read_manifest("suite")
        if installed and installed.get("launch"):
            return list(installed["launch"])
        return [sys.executable]
    return [sys.executable, "-m", "snakes_suite"]


def uninstaller_for(tool_id: str) -> list[str]:
    cmd = hub_command()
    if cmd and cmd[0] == "open":  # macOS: run the program inside the bundle
        cmd = [str(Path(cmd[1]) / "Contents" / "MacOS" / Path(cmd[1]).stem)]
    return [*cmd, "--uninstall", tool_id]


def user_data_dir(name: str) -> Path:
    """Where a tool keeps what you make with it, apart from its program (which an update replaces)."""
    return (ig.xdg_data() if ig.OS == "linux" else ig.DATA / "data") / name


def _merge(src: Path, dst: Path) -> None:
    """Move src to dst; where both exist, move what dst lacks and leave what it has."""
    if not dst.exists():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
    elif src.is_dir() and dst.is_dir():
        for child in src.iterdir():
            _merge(child, dst / child.name)


def keep_user_files(keep: dict | None, dest: Path) -> None:
    """Before an update replaces a tool's folder, move out the files of yours that older
    versions kept inside it ("user_data": the folder they go to and the names to move)."""
    keep = keep or {}
    if not (keep.get("folder") and dest.is_dir()):
        return
    target = user_data_dir(keep["folder"])
    for name in keep.get("move", []):
        if (dest / name).exists():
            _merge(dest / name, target / name)


def tool_in_use(tool_id: str, manifest: dict | None) -> bool:
    """Is the installed program running? An update must not replace it under its feet."""
    roots = [ig.APPS / tool_id]
    launch = (manifest or {}).get("launch") or []
    if launch[:1] == ["open"] and len(launch) > 1:
        roots.append(Path(launch[1]))
    roots = [str(r) for r in roots if r.exists()]
    if not roots:
        return False
    if ig.OS == "windows":
        # Windows will not rename a folder while a program in it runs.
        folder = ig.APPS / tool_id
        probe = folder.with_name(folder.name + ".in-use-check")
        try:
            folder.rename(probe)
        except OSError:
            return True
        probe.rename(folder)
        return False
    if ig.OS == "macos":
        out = subprocess.run(["ps", "-axo", "command="], capture_output=True, text=True).stdout
        return any(root in line for line in out.splitlines() for root in roots)
    for proc in Path("/proc").glob("[0-9]*"):
        if proc.name == str(os.getpid()):
            continue
        try:
            seen = [os.readlink(proc / "exe"), os.readlink(proc / "cwd"),
                    (proc / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")]
        except OSError:
            continue
        if any(root in s for s in seen for root in roots):
            return True
    return False


# --------------------------------------------------------------------------- updating this app
def hub_package(index: dict | None) -> dict | None:
    """This system's build of Snake's Suite in the release index, if newer than the one running and if
    the one running is the installed copy (a copy run from the download or the source is left alone)."""
    from . import __version__

    pkg = (index or {}).get("hub", {}).get(PLATFORM)
    installed = ig.read_manifest("suite")
    if not (FROZEN and pkg and installed):
        return None
    offered = index.get("hub_version") or index.get("version", "0")
    # (not again once installed, even if the build turns out to say an older version: no update loops)
    if version_tuple(offered) <= max(version_tuple(__version__), version_tuple(installed.get("version", "0"))):
        return None
    launch = installed.get("launch") or []
    home = Path(launch[1] if launch[:1] == ["open"] and len(launch) > 1 else launch[0] if launch else "")
    running = Path(sys.executable).resolve()
    if not (running == home.resolve() or running.is_relative_to(home.resolve())):
        return None
    base = index_url().rsplit("/", 1)[0]
    return {**pkg, "version": offered, "url": f"{base}/{pkg['file']}"}


def replace_hub(pkg: dict, download: Path) -> list[str]:
    """Put a downloaded build of this app in place of the running one. Returns how to start it."""
    if pkg.get("sha256") and sha256(download) != pkg["sha256"]:
        raise InstallError("the download is damaged (its checksum does not match).")
    manifest = ig.read_manifest("suite") or {}
    if ig.OS == "macos":
        app = Path(manifest["launch"][1])
        mount = Path(tempfile.mkdtemp(prefix="snakes-suite-dmg-"))
        subprocess.run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", str(mount), str(download)],
                       check=True, capture_output=True)
        try:
            new = next(mount.glob("*.app"))
            staged = app.with_name(app.name + ".new")
            shutil.rmtree(staged, ignore_errors=True)
            shutil.copytree(new, staged, symlinks=True)
            shutil.rmtree(app)  # (a running app's bundle can be replaced on macOS)
            staged.rename(app)
        finally:
            subprocess.run(["hdiutil", "detach", str(mount)], capture_output=True)
        start = ["open", "-n", str(app), "--args"]
    else:
        target = Path(sys.executable)
        if ig.OS == "windows":
            # A running program cannot be overwritten on Windows, but it can be renamed out of the way.
            old = target.with_name(target.stem + ".old")
            old.unlink(missing_ok=True)
            target.rename(old)
            try:
                shutil.copy2(download, target)
            except OSError:
                old.rename(target)
                raise
        else:
            staged = target.with_name(target.name + ".new")
            shutil.copy2(download, staged)
            staged.chmod(0o755)
            os.replace(staged, target)
        start = [str(target)]
    manifest["version"] = pkg["version"]
    ig.write_manifest(manifest)
    return start


def clean_up_after_update() -> None:
    """Windows: delete the old program an update renamed out of the way."""
    if FROZEN and ig.OS == "windows":
        try:
            Path(sys.executable).with_name(Path(sys.executable).stem + ".old").unlink(missing_ok=True)
        except OSError:  # the old one is still quitting: next time
            pass


def install_package(tool: dict, pkg: dict, archive: Path, *, desktop: bool) -> list[str]:
    """Check, unpack and register a downloaded package. Returns notes for the user."""
    if pkg.get("sha256") and sha256(archive) != pkg["sha256"]:
        raise InstallError("the download is damaged (its checksum does not match). Please try again.")
    tool_id = tool["id"]
    old = ig.read_manifest(tool_id)
    if old:
        ig.remove_integration(old)
    dest = ig.APPS / tool_id
    staging = Path(tempfile.mkdtemp(prefix=f"{tool_id}-", dir=ig.DATA if ig.DATA.exists() else None))
    try:
        _extract(archive, staging)
        meta = json.loads((staging / "snake-package.json").read_text(encoding="utf-8"))
        keep_user_files(meta.get("user_data") or tool.get("user_data"), dest)
        shutil.rmtree(dest, ignore_errors=True)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging), str(dest))
    finally:
        shutil.rmtree(staging, ignore_errors=True)

    launch: dict = {"cwd": str(dest) if meta.get("cwd") else None}
    if ig.OS == "macos" and meta.get("app_bundle"):
        app = ig.applications_dir() / f"{tool['name']}.app"
        if app.exists():
            shutil.rmtree(app)
        app.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(dest / meta["app_bundle"]), str(app))
        launch.update(launch=["open", str(app)], app_bundle=str(app))
        if meta.get("cli"):
            launch["cli"] = [str(app.parent / meta["cli"])]
        icon_dir, icon_name = ASSETS, tool.get("icon", tool_id)
    else:
        exe = dest / meta["launch"]
        if ig.OS != "windows":
            exe.chmod(exe.stat().st_mode | 0o111)
        launch["launch"] = [str(exe)]
        if tool.get("kind") == "electron" and ig.OS == "linux" and _userns_restricted():
            launch["launch"].append("--no-sandbox")
        if meta.get("cli"):
            launch["cli"] = [str(dest / meta["cli"])]
        icon_dir, icon_name = dest, "icon"
    icons = ig.copy_icons(tool_id, icon_dir, icon_name)
    files, registry, notes = ig.integrate(tool, launch, icons, desktop=desktop, uninstaller=uninstaller_for(tool_id))
    ig.write_manifest({
        "id": tool_id,
        "name": tool["name"],
        "tagline": tool.get("tagline", ""),
        "description": tool.get("description", ""),
        "kind": tool.get("kind"),
        "version": pkg.get("version", meta.get("version", "1.0.0")),
        "package": pkg.get("file"),
        "launch": launch["launch"],
        "cwd": launch.get("cwd"),
        "command": tool.get("command") if launch.get("cli") else None,
        "icons": icons,
        "files": files,
        "registry": registry,
        "desktop_shortcut": desktop,
        "installed": datetime.datetime.now().isoformat(timespec="seconds"),
    })
    return notes


def self_install(*, desktop: bool) -> list[str]:
    """Copy the running one-file app into the suite's folder and give it a menu entry."""
    hub = catalogue().get("hub", {})
    meta = {**hub, "id": "suite"}
    old = ig.read_manifest("suite")
    if old:
        ig.remove_integration(old)
    dest = ig.APPS / "suite"
    dest.mkdir(parents=True, exist_ok=True)
    launch: dict = {"cwd": None}
    running = Path(sys.executable)
    if ig.OS == "macos":
        bundle = running.parents[2]  # .../Snake's Suite.app/Contents/MacOS/<exe>
        app = ig.applications_dir() / f"{hub.get('name', "Snake's Suite")}.app"
        if bundle.resolve() != app.resolve():
            if app.exists():
                shutil.rmtree(app)
            app.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(bundle, app, symlinks=True)
        launch.update(launch=["open", str(app)], app_bundle=str(app))
    else:
        target = dest / running.name
        if running.resolve() != target.resolve():
            shutil.copy2(running, target)
        if ig.OS != "windows":
            target.chmod(0o755)
        launch["launch"] = [str(target)]
        launch["cli"] = [str(target)]
    icons = ig.copy_icons("suite", ASSETS, "icon")
    uninstaller = [*(launch["launch"] if ig.OS != "macos" else
                     [str(Path(launch["app_bundle"]) / "Contents" / "MacOS" / running.name)]), "--uninstall", "suite"]
    files, registry, notes = ig.integrate(meta, launch, icons, desktop=desktop, uninstaller=uninstaller)
    ig.write_manifest({
        "id": "suite", "name": meta.get("name", "Snake's Suite"), "kind": "hub",
        "version": hub.get("version", catalogue().get("version", "1.0.0")), "launch": launch["launch"], "cwd": None,
        "command": meta.get("command"), "icons": icons, "files": files, "registry": registry,
        "desktop_shortcut": desktop, "installed": datetime.datetime.now().isoformat(timespec="seconds"),
    })
    return notes


def uninstall(tool_id: str) -> list[str]:
    """Remove an installed tool (its program, menu entries and shortcuts, never the user's files)."""
    manifest = ig.read_manifest(tool_id)
    if not manifest:
        return []
    problems = ig.remove_integration(manifest)
    running_here = FROZEN and tool_id == "suite" and Path(sys.executable).resolve().is_relative_to(ig.APPS.resolve())
    if running_here and ig.OS == "windows":
        # A running program cannot delete itself on Windows: let a helper do it once we have quit.
        folder = str(ig.APPS / "suite")
        subprocess.Popen(f'cmd /c ping -n 3 127.0.0.1 >nul & rmdir /s /q "{folder}"', shell=True,
                         creationflags=0x08000000)
        ig.manifest_path(tool_id).unlink(missing_ok=True)
    else:
        ig.forget(tool_id)
    return problems
