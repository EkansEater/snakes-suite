#!/usr/bin/env python3
"""Build the downloadable packages for the system this runs on.

    python packaging/build.py tool converter     one tool  -> release/snakes-converter-linux-x86_64.tar.gz
    python packaging/build.py tools              every tool this system supports
    python packaging/build.py hub                the one-file Snake's Suite app
    python packaging/build.py index release/     index.json for the hub, from every package in a folder

Packages are ready to run: nobody needs Python, Rust or Node.js to use them.
Python tools are frozen with PyInstaller, so run this with a Python that has
PyInstaller and the tool's own requirements (`pip install pyinstaller ./tools/...`;
`--install` does that for you). Rust tools need cargo, Snake's Code needs npm.
PyInstaller cannot cross-compile: build on each system (the GitHub workflow does).

Each archive unpacks into the tool's own folder and carries snake-package.json,
which tells the Snake's Suite app how to start it.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

SUITE = Path(__file__).resolve().parent.parent
RELEASE = SUITE / "release"
ICONS = SUITE / "shared" / "icons"
sys.path.insert(0, str(SUITE / "hub"))

from snakes_suite.integrate import OS, make_icns  # noqa: E402


def arch() -> str:
    machine = platform.machine().lower()
    return {"amd64": "x86_64", "x64": "x86_64", "aarch64": "arm64"}.get(machine, machine)


PLATFORM = f"{OS}-{arch()}"
EXE = ".exe" if OS == "windows" else ""


def say(text: str) -> None:
    print(text, flush=True)


def run(cmd: list, cwd: Path | None = None, env: dict | None = None) -> None:
    say("$ " + " ".join(str(c) for c in cmd))
    subprocess.run([str(c) for c in cmd], cwd=cwd, check=True, env={**os.environ, **(env or {})})


def catalogue() -> tuple[dict, dict]:
    data = json.loads((SUITE / "suite.json").read_text(encoding="utf-8"))
    tools = {t["id"]: t for t in data["tools"]}
    tools[data["hub"]["id"]] = data["hub"]
    for t in tools.values():
        t["root"] = (SUITE / t["folder"]).resolve()
        t.setdefault("icon", t["id"])
        t.setdefault("version", data.get("version", "1.0.0"))
    return data, tools


def display_exe(tool: dict) -> str:
    """The program's file name: the full name on Windows and macOS, the command on Linux."""
    return tool["name"] if OS in ("windows", "macos") else tool["package"].get("exe", tool.get("command") or tool["id"])


# --------------------------------------------------------------------------- archives
def archive(tool: dict, folder: Path, meta: dict) -> Path:
    """Pack `folder`'s contents with snake-package.json into release/."""
    meta = {"id": tool["id"], "name": tool["name"], "version": tool["version"], "platform": PLATFORM, **meta}
    (folder / "snake-package.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    RELEASE.mkdir(exist_ok=True)
    base = RELEASE / f"snakes-{tool['id']}-{PLATFORM}"
    if OS == "windows":
        out = base.with_suffix(".zip")
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for path in sorted(folder.rglob("*")):
                z.write(path, path.relative_to(folder))
    else:
        # tar keeps permissions and the symlinks inside macOS app bundles; zip would lose them.
        out = Path(str(base) + ".tar.gz")
        with tarfile.open(out, "w:gz", compresslevel=9) as t:
            for path in sorted(folder.iterdir()):
                t.add(path, arcname=path.name)
    (Path(str(out) + ".json")).write_text(json.dumps(meta, indent=2), encoding="utf-8")
    say(f"-> {out.name}  ({out.stat().st_size / 1e6:.1f} MB)")
    return out


def mac_bundle(tool: dict, stage: Path, binary: Path) -> Path:
    """Wrap a single program in a macOS .app with the tool's icon."""
    app = stage / f"{tool['name']}.app"
    (app / "Contents" / "MacOS").mkdir(parents=True)
    (app / "Contents" / "Resources").mkdir()
    shutil.copy2(binary, app / "Contents" / "MacOS" / binary.name)
    plist = {
        "CFBundleName": tool["name"], "CFBundleDisplayName": tool["name"],
        "CFBundleIdentifier": f"com.snake.suite.{tool['id']}", "CFBundleExecutable": binary.name,
        "CFBundlePackageType": "APPL", "CFBundleShortVersionString": tool["version"],
        "NSHighResolutionCapable": True, "LSMinimumSystemVersion": "11.0",
    }
    if tool["package"].get("microphone"):
        plist["NSMicrophoneUsageDescription"] = f"{tool['name']} records from your microphone or audio interface."
    if make_icns(str(ICONS / f"{tool['icon']}.png"), app / "Contents" / "Resources" / "icon.icns"):
        plist["CFBundleIconFile"] = "icon"
    with open(app / "Contents" / "Info.plist", "wb") as fh:
        plistlib.dump(plist, fh)
    if shutil.which("codesign"):  # Apple silicon only runs signed code; an ad-hoc signature is enough
        run(["codesign", "--force", "--deep", "--sign", "-", app])
    return app


def icons_into(stage: Path, tool: dict) -> None:
    for ext in ("svg", "png", "ico"):
        src = ICONS / f"{tool['icon']}.{ext}"
        if src.exists():
            shutil.copy2(src, stage / f"icon.{ext}")


# --------------------------------------------------------------------------- per kind
def build_python(tool: dict, install: bool) -> Path:
    pkg = tool["package"]
    if install:
        run([sys.executable, "-m", "pip", "install", "--quiet", "pyinstaller", tool["root"]])
    work = Path(tempfile.mkdtemp(prefix=f"snake-build-{tool['id']}-"))
    module, func = pkg["entry"].split(":")
    entry = work / "launch.py"
    entry.write_text(f"import sys\nfrom {module} import {func}\nsys.exit({func}())\n", encoding="utf-8")
    name = display_exe(tool)
    other_qt = {"PySide6": "PyQt6", "PyQt6": "PySide6"}[pkg["qt"]]
    icon = ICONS / f"{tool['icon']}.{'ico' if OS == 'windows' else 'icns' if OS == 'macos' else 'png'}"
    if OS == "macos" and not icon.exists():
        icon = work / "icon.icns"
        make_icns(str(ICONS / f"{tool['icon']}.png"), icon)
    args = [sys.executable, "-m", "PyInstaller", entry, "--name", name, "--windowed", "--noconfirm", "--clean",
            "--distpath", work / "dist", "--workpath", work / "build", "--specpath", work,
            "--exclude-module", other_qt, "--exclude-module", "tkinter"]
    if icon.exists():
        args += ["--icon", icon]
    for mod in pkg.get("collect_all", []) + pkg.get("collect_all_by_os", {}).get(OS, []):
        args += ["--collect-all", mod]
    for mod in pkg.get("collect_data", []):
        args += ["--collect-data", mod]
    for mod in pkg.get("exclude", []) + pkg.get("exclude_by_os", {}).get(OS, []):
        args += ["--exclude-module", mod]
    if OS == "macos":
        args += ["--osx-bundle-identifier", f"com.snake.suite.{tool['id']}"]
    onefile = pkg.get("onefile")
    if onefile and OS != "macos":
        args.append("--onefile")
    run(args)
    dist = work / "dist"

    if onefile:  # the hub: one file, not an archive
        RELEASE.mkdir(exist_ok=True)
        if OS == "macos":
            app = dist / f"{name}.app"
            fix_mac_plist(app, tool)
            out = RELEASE / f"Snakes-Suite-{PLATFORM}.dmg"
            out.unlink(missing_ok=True)
            run(["hdiutil", "create", "-volname", tool["name"], "-srcfolder", app, "-ov", "-format", "UDZO", out])
        else:
            out = RELEASE / f"Snakes-Suite-{PLATFORM}{EXE}"
            shutil.copy2(dist / (name + EXE), out)
        say(f"-> {out.name}  ({out.stat().st_size / 1e6:.1f} MB)")
        return out

    stage = dist
    if OS == "macos":
        app = dist / f"{name}.app"
        shutil.rmtree(dist / name, ignore_errors=True)  # the folder build that sits beside the .app
        fix_mac_plist(app, tool)
        meta = {"app_bundle": app.name, "cli": f"{app.name}/Contents/MacOS/{name}"}
    else:
        folder = dist / name
        icons_into(folder, tool)
        stage = folder
        meta = {"launch": name + EXE, "cli": name + EXE}
    return archive(tool, stage, meta)


def fix_mac_plist(app: Path, tool: dict) -> None:
    plist_path = app / "Contents" / "Info.plist"
    with open(plist_path, "rb") as fh:
        plist = plistlib.load(fh)
    plist.update({"CFBundleDisplayName": tool["name"], "CFBundleShortVersionString": tool["version"],
                  "NSHighResolutionCapable": True})
    if tool["package"].get("microphone"):
        plist["NSMicrophoneUsageDescription"] = f"{tool['name']} records from your microphone or audio interface."
    with open(plist_path, "wb") as fh:
        plistlib.dump(plist, fh)
    if shutil.which("codesign"):
        run(["codesign", "--force", "--deep", "--sign", "-", app])


def build_cargo(tool: dict, install: bool) -> Path:
    args = list(tool.get("cargo_args", [])) + list(tool.get("cargo_args_by_os", {}).get(OS, []))
    run(["cargo", "build", "--release", *args], cwd=tool["root"])
    built = tool["root"] / "target" / "release"
    work = Path(tempfile.mkdtemp(prefix=f"snake-build-{tool['id']}-"))
    stage = work / "stage"
    stage.mkdir()
    gui = built / (tool["binary"] + EXE)
    extras = [built / (b + EXE) for b in tool.get("extra_binaries", [])]
    command = tool.get("command")
    if OS == "macos":
        app = mac_bundle(tool, stage, gui)
        for extra in extras:
            shutil.copy2(extra, app / "Contents" / "MacOS" / extra.name)
        cli_name = command if command in tool.get("extra_binaries", []) else tool["binary"]
        meta = {"app_bundle": app.name, "cli": f"{app.name}/Contents/MacOS/{cli_name}"}
    else:
        target_name = display_exe(tool) + EXE if OS == "windows" else gui.name
        shutil.copy2(gui, stage / target_name)
        for extra in extras:
            shutil.copy2(extra, stage / extra.name)
        icons_into(stage, tool)
        cli = (command + EXE) if command in tool.get("extra_binaries", []) else target_name
        meta = {"launch": target_name, "cli": cli}
    return archive(tool, stage, meta)


def build_electron(tool: dict, install: bool) -> Path:
    npm = shutil.which("npm") or "npm"
    # Build from a copy at a plain path: electron-builder (macOS) and node-gyp (Windows) refuse
    # or mangle paths with an apostrophe, like "tools/Snake's Code".
    root = Path(tempfile.mkdtemp(prefix="snake-build-code-")) / "snakes-code"
    shutil.copytree(tool["root"], root, ignore=shutil.ignore_patterns("node_modules", "release", "dist"))
    run([npm, "ci" if (root / "package-lock.json").exists() else "install"], cwd=root)
    run([npm, "run", "build"], cwd=root)
    out_dir = root / "release"
    shutil.rmtree(out_dir, ignore_errors=True)
    flag = {"linux": "--linux", "windows": "--win", "macos": "--mac"}[OS]
    npx = shutil.which("npx") or "npx"  # npx.cmd on Windows
    run([npx, "--yes", "electron-builder", flag, "dir", "--publish", "never"], cwd=root,
        env={"CSC_IDENTITY_AUTO_DISCOVERY": "false"})
    unpacked = next(p for p in out_dir.iterdir() if p.is_dir() and ("unpacked" in p.name or p.name.startswith("mac")))
    if OS == "macos":
        app = next(unpacked.glob("*.app"))
        meta = {"app_bundle": app.name, "cli": None}
        return archive(tool, unpacked, meta)
    exe = f"{tool['name']}.exe" if OS == "windows" else "snakes-code"
    icons_into(unpacked, tool)
    return archive(tool, unpacked, {"launch": exe, "cli": None})


def build_source(tool: dict, install: bool) -> Path:
    """Tools that build themselves on the user's machine ship their tracked source files."""
    work = Path(tempfile.mkdtemp(prefix=f"snake-build-{tool['id']}-"))
    stage = work / "stage"
    files = subprocess.run(["git", "ls-files", "-z", "--", str(tool["root"])], cwd=SUITE, check=True,
                           capture_output=True).stdout.decode().split("\0")
    for rel in filter(None, files):
        src = SUITE / rel
        dst = stage / src.relative_to(tool["root"])
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    icons_into(stage, tool)
    argv = tool["launch"][OS]
    meta = {"launch": argv[0], "cwd": True, "cli": None}
    if tool.get("user_data"):  # what older versions kept in the program's folder, for the app to move out
        meta["user_data"] = tool["user_data"]
    return archive(tool, stage, meta)


BUILDERS = {"python": build_python, "cargo": build_cargo, "electron": build_electron}


def build_tool(tool: dict, install: bool) -> Path | None:
    if OS not in tool.get("platforms", []):
        say(f"{tool['name']}: not for {OS}, skipped")
        return None
    say(f"\n=== {tool['name']} ({PLATFORM}) ===")
    if tool["package"].get("source"):
        return build_source(tool, install)
    return BUILDERS[tool["kind"]](tool, install)


# --------------------------------------------------------------------------- index
def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def make_index(folder: Path) -> Path:
    """index.json: for each tool and system, the file to download, its size and checksum."""
    data, _ = catalogue()
    index = {"version": data.get("version", "1.0.0"), "hub_version": data["hub"].get("version", data.get("version", "1.0.0")),
             "tools": {}, "hub": {}}
    for side in sorted(folder.glob("*.json")):
        if side.name == "index.json":
            continue
        meta = json.loads(side.read_text(encoding="utf-8"))
        pkg = Path(str(side)[: -len(".json")])
        if not pkg.exists():
            continue
        entry = index["tools"].setdefault(meta["id"], {"version": meta["version"], "packages": {}})
        entry["packages"][meta["platform"]] = {
            "file": pkg.name, "size": pkg.stat().st_size, "sha256": sha256(pkg),
            **{k: meta[k] for k in ("launch", "cli", "cwd", "app_bundle") if k in meta},
        }
    for hub in sorted(folder.glob("Snakes-Suite-*")):
        plat = hub.stem.replace("Snakes-Suite-", "") if hub.suffix in (".exe", ".dmg") else hub.name.replace("Snakes-Suite-", "")
        index["hub"][plat] = {"file": hub.name, "size": hub.stat().st_size, "sha256": sha256(hub)}
    out = folder / "index.json"
    out.write_text(json.dumps(index, indent=2), encoding="utf-8")
    say(f"-> {out}  ({len(index['tools'])} tools, {len(index['hub'])} hub builds)")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("what", choices=["tool", "tools", "hub", "index"])
    parser.add_argument("names", nargs="*", help="tool ids, or the folder for index")
    parser.add_argument("--install", action="store_true", help="pip install PyInstaller and each Python tool first")
    args = parser.parse_args()
    _, tools = catalogue()
    if args.what == "index":
        make_index(Path(args.names[0]) if args.names else RELEASE)
        return 0
    if args.what == "hub":
        build_tool(tools["suite"], args.install)
        return 0
    wanted = args.names if args.what == "tool" else [t for t in tools if t != "suite"]
    failed = []
    for tool_id in wanted:
        try:
            build_tool(tools[tool_id], args.install)
        except (subprocess.CalledProcessError, OSError, StopIteration) as e:
            say(f"!! {tools[tool_id]['name']} failed: {e}")
            failed.append(tool_id)
    if failed:
        say("Failed: " + ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
