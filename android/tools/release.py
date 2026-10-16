"""Collect the release APKs and describe them for the Snake's Master Suite release index.

    python tools/release.py                      # dist/*.apk and dist/index-android.json
    python tools/release.py --merge ../dist/index.json
                                                 # also add them to the desktop release index
    python tools/release.py --publish            # upload them to the latest GitHub release

Run after `./build.sh` (or `./gradlew assembleRelease`). The hub on a phone reads
the same index.json as the desktop hub: every tool's "packages" map gains
"android" (one APK for every phone) or "android-<abi>" entries (one per ABI, for
the tools that carry ffmpeg), and "hub" gains them for the hub itself. The Studio
APK (one app on the phone for Word, Spreadsheets, Slides, Paint, Photo, Player and
Movie Maker) is listed under each of those seven, marked "shared": "studio".

index.json is signed (index.json.sig, Ed25519). --publish changes it, so it signs it
again with your key: SNAKE_INDEX_KEY, or the file packaging/build.py keygen wrote
(~/.config/snakes-suite/index-signing-key). Without the key it stops before uploading.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
HUB = "suite"
SUITE_JSON = ROOT.parent / "suite.json"
NAME = re.compile(r"snakes-(?P<id>[a-z0-9]+)-android(?:-(?P<abi>arm64-v8a|armeabi-v7a|x86_64|x86))?-release\.apk")


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def collect() -> dict:
    """{tool id: {"version": v, "packages": {key: entry}}} from the release builds."""
    tools: dict[str, dict] = {}
    DIST.mkdir(exist_ok=True)
    for apk in sorted(ROOT.glob("apps/*/build/outputs/apk/release/*.apk")):
        m = NAME.fullmatch(apk.name)
        if not m:
            continue
        meta = json.loads((apk.parent / "output-metadata.json").read_text())
        version = meta["elements"][0]["versionName"]
        key = "android" + (f"-{m['abi']}" if m["abi"] else "")
        file = f"snakes-{m['id']}-{key}.apk"
        shutil.copy2(apk, DIST / file)
        entry = {"file": file, "size": apk.stat().st_size, "sha256": sha256(apk), "version": version}
        if m["id"] == "studio":
            # One APK, listed under each Studio app (the Android hub opens the right one).
            entry["shared"] = "studio"
            for app in studio_apps():
                tools.setdefault(app["id"], {"version": app.get("version", version), "packages": {}})["packages"][key] = entry
        else:
            tool = tools.setdefault(m["id"], {"version": version, "packages": {}})
            tool["packages"][key] = entry
        print(f"  {file:48} {apk.stat().st_size / 1e6:6.1f} MB  {version}")
    return tools


def studio_apps() -> list[dict]:
    return [t for t in json.loads(SUITE_JSON.read_text())["tools"] if t.get("studio_app")]


def sign(index: Path) -> Path:
    """Sign index.json again (it changed), as packaging/build.py index does, and check the result."""
    key = os.environ.get("SNAKE_INDEX_KEY", "").strip()
    keyfile = Path.home() / ".config" / "snakes-suite" / "index-signing-key"
    if not key and keyfile.exists():
        key = keyfile.read_text(encoding="ascii").strip()
    if not key:
        raise SystemExit("index.json is signed, and changing it needs your signing key: set SNAKE_INDEX_KEY or keep it at "
                         f"{keyfile}. Nothing was uploaded.")
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    sig = index.with_name("index.json.sig")
    signer = Ed25519PrivateKey.from_private_bytes(base64.b64decode(key))
    sig.write_text(base64.b64encode(signer.sign(index.read_bytes())).decode() + "\n", encoding="ascii")
    pubkey = json.loads(SUITE_JSON.read_text()).get("release", {}).get("index_pubkey", "")
    sys.path.insert(0, str(ROOT.parent / "hub"))
    from snakes_suite import signing
    if pubkey and not signing.verify_b64(pubkey, index.read_bytes(), sig.read_text(encoding="ascii")):
        raise SystemExit("The signing key does not match suite.json's index_pubkey: the hubs would refuse this index. "
                         "Nothing was uploaded.")
    return sig


def as_index(tools: dict) -> dict:
    hub = tools.pop(HUB, None)
    index: dict = {"tools": tools}
    if hub:
        index["hub"] = hub["packages"]
        index["hub_version"] = hub["version"]
    return index


def merge(target: Path, android: dict, copy: bool = True) -> None:
    """Add the Android packages to an existing release index, leaving the desktop ones alone."""
    index = json.loads(target.read_text())
    for tool_id, tool in android["tools"].items():
        entry = index.setdefault("tools", {}).setdefault(tool_id, {"version": tool["version"], "packages": {}})
        packages = entry.setdefault("packages", {})
        for key in [k for k in packages if k.startswith("android")]:
            del packages[key]
        packages.update(tool["packages"])
    if "hub" in android:
        hub = index.setdefault("hub", {})
        for key in [k for k in hub if k.startswith("android")]:
            del hub[key]
        hub.update(android["hub"])
    target.write_text(json.dumps(index, indent=2) + "\n")
    if copy:
        for apk in DIST.glob("*.apk"):
            shutil.copy2(apk, target.parent / apk.name)
        # Descriptions packaging/build.py index reads, so the next signed index keeps them.
        sides = {}
        for tool_id, tool in android["tools"].items():
            for key, pkg in tool["packages"].items():
                sides[pkg["file"]] = {"id": pkg.get("shared") or tool_id, "name": tool_id, "version": pkg["version"], "platform": key,
                                      **({"shared": pkg["shared"]} if pkg.get("shared") else {})}
        for key, pkg in android.get("hub", {}).items():
            sides[pkg["file"]] = {"id": HUB, "name": HUB, "version": pkg["version"], "platform": key}
        for file, meta in sides.items():
            (target.parent / (file + ".json")).write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(f"merged into {target}" + (" (APKs copied next to it; run packaging/build.py index to sign it)" if copy else ""))


def publish(android: dict) -> None:
    """Add the APKs to the latest GitHub release and its index.json.

    The release workflow carries them into every later release (packaging/build.py android),
    so this is only needed when an Android app changed.
    """
    repo = json.loads(SUITE_JSON.read_text())["release"]["repo"]
    tag = subprocess.run(["gh", "release", "view", "-R", repo, "--json", "tagName", "-q", ".tagName"],
                         check=True, capture_output=True, text=True).stdout.strip()
    with tempfile.TemporaryDirectory() as tmp:
        index = Path(tmp) / "index.json"
        subprocess.run(["gh", "release", "download", tag, "-R", repo, "-p", "index.json", "-D", tmp], check=True)
        merge(index, android, copy=False)
        sig = sign(index)
        apks = sorted(str(p) for p in DIST.glob("*.apk"))
        print(f"uploading {len(apks)} APKs, index.json and its signature to {repo} {tag}")
        subprocess.run(["gh", "release", "upload", tag, "-R", repo, "--clobber", *apks, str(index), str(sig)], check=True)
    print(f"published: https://github.com/{repo}/releases/tag/{tag}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--merge", type=Path, help="a release index.json to add the Android packages to")
    ap.add_argument("--publish", action="store_true", help="upload the APKs to the latest GitHub release")
    args = ap.parse_args()
    print("release APKs:")
    tools = collect()
    if not tools:
        raise SystemExit("no release APKs found: run ./build.sh first")
    index = as_index(tools)
    (DIST / "index-android.json").write_text(json.dumps(index, indent=2) + "\n")
    print(f"wrote {DIST / 'index-android.json'}")
    if args.merge:
        merge(args.merge, index)
    if args.publish:
        publish(index)


if __name__ == "__main__":
    main()
