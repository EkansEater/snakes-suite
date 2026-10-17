#!/usr/bin/env python3
"""Build the downloadable packages for the system this runs on.

    python packaging/build.py tool converter     one tool  -> release/snakes-converter-linux-x86_64.tar.gz
    python packaging/build.py tools              every tool this system supports
    python packaging/build.py hub                the one-file Snake's Suite app
    python packaging/build.py index release/     index.json for the hub, from every package in a folder
    python packaging/build.py android release/   the latest release's Android APKs, to publish again
    python packaging/build.py keygen             a key pair for signing the index (once, by you):
                                                 the private key goes to ~/.config/snakes-suite/index-signing-key
    python packaging/build.py ffmpeg build/ffmpeg   ffmpeg and ffprobe for Snake's Studio on this system

With SNAKE_INDEX_KEY set (the private key keygen wrote, kept as a GitHub secret),
`index` also writes index.json.sig, which the app checks against release.index_pubkey.
Once suite.json has release.index_pubkey, `index` refuses to write an index without a
matching signature: the app would not trust it.

With --reuse, a tool (or the hub) whose version is the same as in the latest
release is downloaded from that release instead of built again, so a release
only builds what changed.

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
import tomllib
import urllib.request
import zipfile
from pathlib import Path

SUITE = Path(__file__).resolve().parent.parent
RELEASE = SUITE / "release"
ICONS = SUITE / "shared" / "icons"
FFMPEG = SUITE / "packaging" / "ffmpeg"
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


def vkey(version: str) -> list[int]:
    return [int(x) for x in version.split(".") if x.isdigit()]


def own_version(tool: dict) -> str | None:
    """The version a tool's own files give (what its About box and --version show), if they give one."""
    root = tool["root"]
    if (root / "package.json").exists():
        return json.loads((root / "package.json").read_text(encoding="utf-8")).get("version")
    for name, table in (("Cargo.toml", "package"), ("pyproject.toml", "project")):
        if (root / name).exists():
            return tomllib.loads((root / name).read_text(encoding="utf-8")).get(table, {}).get("version")
    return None


def check_versions(tools: dict, wanted: list[str]) -> None:
    """Stop before building anything when a tool's own version is not the one in suite.json.

    suite.json decides what a release ships (--reuse keeps a tool whose version did not
    change), so a tool that changed needs a new version there, and the app should then say
    the same version as the package it comes in.
    """
    studio = max((t["version"] for t in tools.values() if t.get("studio_app")), key=vkey, default=None)
    wrong = []
    for tool_id in wanted:
        tool = tools[tool_id]
        expected = studio if tool.get("studio_app") else tool["version"]
        found = own_version(tool)
        if found and found != expected:
            wrong.append(f"  {tool['name']}: suite.json says {expected}, {tool['folder']} says {found}")
    if wrong:
        raise SystemExit("Versions disagree; make them the same before building:\n" + "\n".join(wrong))


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


_studio_built: Path | None = None


def build_studio(tool: dict, install: bool) -> Path:
    """Snake's Studio holds seven apps: build it once, as one package they all share.

    With SNAKE_FFMPEG_DIR pointing at a folder made by `build.py ffmpeg`, ffmpeg and
    ffprobe are bundled with their licence and source notes (Player and Movie Maker then
    play and export everything out of the box).
    """
    global _studio_built
    if _studio_built is not None:
        return _studio_built
    npm = shutil.which("npm") or "npm"
    root = Path(tempfile.mkdtemp(prefix="snake-build-studio-")) / "snakes-studio"
    shutil.copytree(tool["root"], root, ignore=shutil.ignore_patterns("node_modules", "release", "dist"))
    run([npm, "ci" if (root / "package-lock.json").exists() else "install"], cwd=root)
    run([npm, "run", "build"], cwd=root)
    flag = {"linux": "--linux", "windows": "--win", "macos": "--mac"}[OS]
    npx = shutil.which("npx") or "npx"
    run([npx, "--yes", "electron-builder", flag, "dir", "--publish", "never"], cwd=root,
        env={"CSC_IDENTITY_AUTO_DISCOVERY": "false"})
    out_dir = root / "release"
    unpacked = next(p for p in out_dir.iterdir() if p.is_dir() and ("unpacked" in p.name or p.name.startswith("mac")))
    app = next(unpacked.glob("*.app"), None) if OS == "macos" else None
    resources = (app / "Contents" / "Resources") if app else (unpacked / "resources")
    ff = os.environ.get("SNAKE_FFMPEG_DIR")
    if ff:
        dest = resources / "ffmpeg"
        dest.mkdir(parents=True, exist_ok=True)
        for name in ("ffmpeg" + EXE, "ffprobe" + EXE, "LICENSE.txt", "README.txt"):
            src = Path(ff) / name
            if not src.exists():
                raise OSError(f"{src} is missing")
            shutil.copy2(src, dest / name)
        if (Path(ff) / "BUILD-INFO.txt").exists():  # the Windows build's own notes
            shutil.copy2(Path(ff) / "BUILD-INFO.txt", dest / "BUILD-INFO.txt")
        if app and shutil.which("codesign"):  # new programs inside the bundle need a fresh signature
            for name in ("ffmpeg", "ffprobe"):
                run(["codesign", "--force", "--sign", "-", dest / name])
            run(["codesign", "--force", "--deep", "--sign", "-", app])
    else:
        say("(no SNAKE_FFMPEG_DIR: Player and Movie Maker will use an ffmpeg installed on the system)")
    _, tools = catalogue()
    apps = [t for t in tools.values() if t.get("studio_app")]
    shared = {"id": "studio", "name": "Snake's Studio", "version": max((t["version"] for t in apps), key=vkey)}
    if app:
        meta = {"app_bundle": app.name, "cli": None, "shared": "studio"}
    else:
        exe = "Snake's Studio.exe" if OS == "windows" else "snakes-studio"
        meta = {"launch": exe, "cli": None, "shared": "studio"}
    _studio_built = archive(shared, unpacked, meta)
    return _studio_built


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
    if tool.get("studio_app"):
        return build_studio(tool, install)
    return BUILDERS[tool["kind"]](tool, install)


def ffmpeg_for_studio(out: Path) -> Path:
    """ffmpeg and ffprobe for this system in `out`, with their licence and where their source is.

    Linux and macOS build them from pinned sources (packaging/ffmpeg/build.sh, no network
    protocols); Windows takes gyan.dev's GPL build pinned in packaging/ffmpeg/windows.json.
    A folder that already holds them (a cache) is kept.
    """
    names = ["ffmpeg" + EXE, "ffprobe" + EXE, "LICENSE.txt", "README.txt"]
    if all((out / n).exists() for n in names):
        say(f"ffmpeg: already in {out}")
        return out
    out.mkdir(parents=True, exist_ok=True)
    if OS != "windows":
        run(["bash", FFMPEG / "build.sh", out])
        return out
    pin = json.loads((FFMPEG / "windows.json").read_text(encoding="utf-8"))
    archive_path = Path(tempfile.mkdtemp(prefix="snake-ffmpeg-")) / "ffmpeg.zip"
    say(f"Downloading {pin['url']}")
    with urllib.request.urlopen(pin["url"], timeout=600) as r, open(archive_path, "wb") as fh:
        shutil.copyfileobj(r, fh)
    if sha256(archive_path) != pin["sha256"]:
        raise OSError(f"{pin['url']} does not match its checksum")
    # Only these files, written under names we choose: nothing in the archive picks a path.
    wanted = {"bin/ffmpeg.exe": "ffmpeg.exe", "bin/ffprobe.exe": "ffprobe.exe", "LICENSE": "LICENSE.txt",
              "README.txt": "BUILD-INFO.txt"}
    with zipfile.ZipFile(archive_path) as z:
        for info in z.infolist():
            inner = info.filename.split("/", 1)[-1]
            if inner in wanted:
                with z.open(info) as src, open(out / wanted[inner], "wb") as dst:
                    shutil.copyfileobj(src, dst)
    missing = [n for n in wanted.values() if not (out / n).exists()]
    if missing:
        raise OSError(f"{pin['url']} has no {', '.join(missing)}")
    (out / "README.txt").write_text(
        f"ffmpeg.exe and ffprobe.exe in this folder are FFmpeg {pin['version']}, the essentials build\n"
        f"by {pin['builder']} ({pin['url']}),\nshipped unchanged with Snake's Studio.\n\n"
        "Licence: GNU General Public License version 3 (LICENSE.txt). You may copy, change and\n"
        f"share these programs under its terms. Corresponding source: {pin['source']}\n"
        "and the libraries and versions listed in BUILD-INFO.txt.\n", encoding="utf-8")
    return out


# --------------------------------------------------------------------------- reuse
_last_index: dict | None = None


def last_index() -> dict:
    """index.json of the latest release ({} if there is none or it cannot be read)."""
    global _last_index
    if _last_index is None:
        data, _ = catalogue()
        try:
            with urllib.request.urlopen(data["release"]["index_url"], timeout=60) as r:
                _last_index = json.load(r)
        except (OSError, ValueError, KeyError) as e:
            say(f"(no earlier release to reuse: {e})")
            _last_index = {}
    return _last_index


def fetch(old: dict, pkg: dict, out: Path) -> bool:
    """Download one file of the latest release into release/ and check it."""
    data, _ = catalogue()
    url = f"https://github.com/{data['release']['repo']}/releases/download/v{old['version']}/{pkg['file']}"
    RELEASE.mkdir(exist_ok=True)
    try:
        with urllib.request.urlopen(url, timeout=600) as r, open(out, "wb") as fh:
            shutil.copyfileobj(r, fh)
    except OSError as e:
        say(f"(could not download {pkg['file']}: {e})")
        out.unlink(missing_ok=True)
        return False
    if sha256(out) != pkg["sha256"]:
        say(f"({pkg['file']} does not match its checksum)")
        out.unlink()
        return False
    return True


def reuse(tool: dict) -> bool:
    """Take this system's package of an unchanged tool or hub from the latest release. False: build it."""
    old = last_index()
    if not old:
        return False
    if tool["id"] == "suite":
        pkg = old.get("hub", {}).get(PLATFORM)
        if not pkg or old.get("hub_version") != tool["version"]:
            return False
        ok = fetch(old, pkg, RELEASE / pkg["file"])
    else:
        entry = old.get("tools", {}).get(tool["id"], {})
        pkg = entry.get("packages", {}).get(PLATFORM)
        if not pkg or entry.get("version") != tool["version"]:
            return False
        out = RELEASE / pkg["file"]
        if pkg.get("shared") and out.exists() and sha256(out) == pkg["sha256"]:
            ok = True  # another Studio app already brought the shared package
        else:
            ok = fetch(old, pkg, out)
        if ok:  # the side file that make_index() reads
            shared = pkg.get("shared")
            meta = {"id": shared or tool["id"], "name": "Snake's Studio" if shared else tool["name"], "version": tool["version"], "platform": PLATFORM,
                    **{k: pkg[k] for k in ("launch", "cli", "cwd", "app_bundle", "shared") if k in pkg}}
            Path(str(out) + ".json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    if ok:
        say(f"{tool['name']} {tool['version']}: unchanged, reused from v{old['version']}")
    return ok


def carry_android(folder: Path) -> None:
    """Bring the Android APKs of the latest release into `folder`, for the next release to keep.

    They are signed on the developer's computer (android/, tools/release.py --publish),
    not built here. An APK already in `folder` is left as it is. The Studio APK is listed
    under each of the seven Studio apps; it is carried once, as "studio".
    """
    old = last_index()
    wanted = [(tool_id, entry, key, pkg)
              for tool_id, entry in old.get("tools", {}).items()
              for key, pkg in entry.get("packages", {}).items() if key.startswith("android")]
    wanted += [("suite", {"version": pkg.get("version", old.get("hub_version", "0"))}, key, pkg)
               for key, pkg in old.get("hub", {}).items() if key.startswith("android")]
    folder.mkdir(parents=True, exist_ok=True)
    done: set[str] = set()
    for tool_id, entry, key, pkg in wanted:
        if pkg["file"] in done:
            continue
        done.add(pkg["file"])
        out = folder / pkg["file"]
        if not out.exists() and not fetch(old, pkg, out):
            continue
        meta = {"id": pkg.get("shared") or tool_id, "name": tool_id, "version": pkg.get("version", entry["version"]), "platform": key}
        if pkg.get("shared"):
            meta["shared"] = pkg["shared"]
        Path(str(out) + ".json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        say(f"{pkg['file']}: carried over from v{old['version']}")


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
        package = {
            "file": pkg.name, "size": pkg.stat().st_size, "sha256": sha256(pkg),
            **{k: meta[k] for k in ("launch", "cli", "cwd", "app_bundle", "shared") if k in meta},
        }
        if meta["platform"].startswith("android"):
            # Android APKs are built and signed elsewhere (android/, on your computer) and can lag the
            # desktop build of the same tool, so each one says its own version.
            package["version"] = meta["version"]
            if meta["id"] == "suite":
                index["hub"][meta["platform"]] = package
                continue
        if meta["id"] == "studio":
            # One Studio package, listed under each of its apps with the switch that starts it.
            package["shared"] = "studio"
            for app in (t for t in data["tools"] if t.get("studio_app")):
                e = index["tools"].setdefault(app["id"], {"version": app.get("version", meta["version"]), "packages": {}})
                # On Android each app has its own launcher activity, so no switch is needed.
                args = {} if meta["platform"].startswith("android") else {"args": [f"--app={app['studio_app']}"]}
                e["packages"][meta["platform"]] = {**package, **args}
            continue
        entry = index["tools"].setdefault(meta["id"], {"version": meta["version"], "packages": {}})
        if not meta["platform"].startswith("android"):
            entry["version"] = meta["version"]  # the tool's version is its desktop build's
        entry["packages"][meta["platform"]] = package
    for hub in sorted(folder.glob("Snakes-Suite-*")):
        plat = hub.stem.replace("Snakes-Suite-", "") if hub.suffix in (".exe", ".dmg") else hub.name.replace("Snakes-Suite-", "")
        index["hub"][plat] = {"file": hub.name, "size": hub.stat().st_size, "sha256": sha256(hub)}
    out = folder / "index.json"
    out.write_text(json.dumps(index, indent=2), encoding="utf-8")
    key = os.environ.get("SNAKE_INDEX_KEY", "").strip()
    pubkey = data.get("release", {}).get("index_pubkey", "")
    sig_path = folder / "index.json.sig"
    sig_path.unlink(missing_ok=True)
    if key:
        # Signed so the app can tell this list really comes from you (Ed25519).
        import base64

        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        signer = Ed25519PrivateKey.from_private_bytes(base64.b64decode(key))
        sig_path.write_text(base64.b64encode(signer.sign(out.read_bytes())).decode() + "\n", encoding="utf-8")
        say("-> index.json.sig")
    if pubkey:
        # The app checks the index against this key: make sure it will pass, before anything is published.
        from snakes_suite import signing
        if not sig_path.exists():
            out.unlink()
            raise SystemExit("suite.json has release.index_pubkey but SNAKE_INDEX_KEY is not set: "
                             "the app would refuse this index. Add the secret (see MASTER_PLAN.md).")
        if not signing.verify_b64(pubkey, out.read_bytes(), sig_path.read_text(encoding="utf-8")):
            out.unlink()
            sig_path.unlink()
            raise SystemExit("SNAKE_INDEX_KEY does not match release.index_pubkey in suite.json.")
        say("   signature checks out against release.index_pubkey")
    say(f"-> {out}  ({len(index['tools'])} tools, {len(index['hub'])} hub builds)")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("what", choices=["tool", "tools", "hub", "index", "android", "keygen", "ffmpeg"])
    parser.add_argument("names", nargs="*", help="tool ids, the folder for index, or where keygen keeps the private key")
    parser.add_argument("--install", action="store_true", help="pip install PyInstaller and each Python tool first")
    parser.add_argument("--reuse", action="store_true", help="download what has not changed from the latest release")
    args = parser.parse_args()
    _, tools = catalogue()
    if args.what == "keygen":
        import base64

        from cryptography.hazmat.primitives import serialization as ser
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        # The private key goes straight into a file only you can read, never onto the screen
        # (where it could end up in a log); the GitHub secret is filled from that file.
        keyfile = Path(args.names[0]) if args.names else Path.home() / ".config" / "snakes-suite" / "index-signing-key"
        if keyfile.exists():
            raise SystemExit(f"{keyfile} already exists: a new key would lock out every app that knows the old one.")
        k = Ed25519PrivateKey.generate()
        raw = lambda b: base64.b64encode(b).decode()  # noqa: E731
        keyfile.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(keyfile, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="ascii") as fh:
            fh.write(raw(k.private_bytes(ser.Encoding.Raw, ser.PrivateFormat.Raw, ser.NoEncryption())) + "\n")
        say(f"Private key written to {keyfile} (readable only by you). Keep a backup copy somewhere safe:")
        say("if it is lost, apps that know this key can no longer update.")
        say("Make it the GitHub secret SNAKE_INDEX_KEY with:")
        say(f"  gh secret set SNAKE_INDEX_KEY --repo {catalogue()[0]['release']['repo']} < \"{keyfile}\"")
        say("Public key (suite.json: release.index_pubkey):")
        say("  " + raw(k.public_key().public_bytes(ser.Encoding.Raw, ser.PublicFormat.Raw)))
        return 0
    if args.what == "ffmpeg":
        ffmpeg_for_studio(Path(args.names[0]).resolve() if args.names else SUITE / "build" / "ffmpeg")
        return 0
    if args.what == "android":
        carry_android(Path(args.names[0]) if args.names else RELEASE)
        return 0
    if args.what == "index":
        make_index(Path(args.names[0]) if args.names else RELEASE)
        return 0
    if args.what == "hub":
        check_versions(tools, ["suite"])
        if not (args.reuse and reuse(tools["suite"])):
            build_tool(tools["suite"], args.install)
        return 0
    wanted = args.names if args.what == "tool" else [t for t in tools if t != "suite"]
    check_versions(tools, wanted)
    failed = []
    for tool_id in wanted:
        try:
            if args.reuse and OS in tools[tool_id].get("platforms", []) and reuse(tools[tool_id]):
                continue
            build_tool(tools[tool_id], args.install)
        except (subprocess.CalledProcessError, OSError, StopIteration) as e:
            say(f"!! {tools[tool_id]['name']} failed: {e}")
            failed.append(tool_id)
    if failed:
        say("Failed: " + ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
