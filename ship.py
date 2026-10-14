#!/usr/bin/env python3
"""Ship your changes: install them on this computer, publish them on GitHub, or both.

    python ship.py              see what changed, then choose
    python ship.py --local      install the changed tools on this computer
    python ship.py --github     commit, push and publish a release
    python ship.py --dry-run    only show what changed and the new versions

It looks at what changed since the last release (the newest v* tag), raises
the version of every tool that changed, of the hub if it changed, and of the
release itself, unless you already raised them by hand. Then:

  Update locally   builds the changed tools from this folder and installs them
                   with install.py, keeping their desktop shortcuts.
  Update GitHub    commits everything, pushes, and pushes the tag v<version>,
                   which starts the Release workflow. Installed copies of
                   Snake's Suite then update themselves from that release.

For you, not for people using the tools.
"""

from __future__ import annotations

import argparse
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path

SUITE = Path(__file__).resolve().parent
CATALOGUE = SUITE / "suite.json"
HUB_INIT = SUITE / "hub" / "snakes_suite" / "__init__.py"
HUB_PYPROJECT = SUITE / "hub" / "pyproject.toml"
NOT_HUB = {"hub/snakes_suite/catalogue.json"}  # a copy of suite.json, changed by every version bump
VERSIONS_ONLY = {"suite.json"}  # changes on its own with every version bump: not a change worth a release

sys.path.insert(0, str(SUITE / "hub"))
from snakes_suite import integrate as ig  # noqa: E402 - stdlib only


def say(text: str = "") -> None:
    print(text, flush=True)


def git(*args: str, check: bool = True) -> str:
    return subprocess.run(["git", *args], cwd=SUITE, check=check, capture_output=True, text=True).stdout


def run(cmd: list[str]) -> None:
    say("  $ " + shlex.join(cmd))
    subprocess.run(cmd, cwd=SUITE, check=True)


def bump(version: str) -> str:
    parts = [int(p) if p.isdigit() else 0 for p in version.split(".")] + [0, 0, 0]
    major, minor, patch = parts[:3]
    return f"{major}.{minor}.{patch + 1}"


def last_release() -> str | None:
    tags = git("tag", "--list", "v*", "--sort=-v:refname").split()
    return tags[0] if tags else None


def changed_files(since: str | None) -> list[str]:
    """Every file that differs from the last release: committed since, or not committed yet."""
    if since:
        files = git("diff", "--name-only", "-z", since, "--").split("\0")
    else:
        files = git("ls-files", "-z").split("\0")
    files += git("ls-files", "--others", "--exclude-standard", "-z").split("\0")
    return sorted({f for f in files if f})


def catalogue_at(tag: str | None) -> dict:
    if not tag:
        return {"version": "0", "tools": [], "hub": {}}
    try:
        return json.loads(git("show", f"{tag}:suite.json"))
    except (subprocess.CalledProcessError, ValueError):
        return {"version": "0", "tools": [], "hub": {}}


def version_of(data: dict, tool_id: str, formerly: list[str] = ()) -> str:
    for entry in [*data.get("tools", []), data.get("hub") or {}]:
        if entry.get("id") == tool_id or entry.get("id") in formerly:  # (or the id it had before a rename)
            return entry.get("version", data.get("version", "1.0.0"))
    return "0"


def plan(tag: str | None) -> tuple[dict, list[dict], list[str]]:
    """The catalogue with new versions, what changed (with old and new versions), and the other files."""
    subprocess.run([sys.executable, str(SUITE / "shared" / "sync.py")], cwd=SUITE, check=True,
                   capture_output=True)  # so a change in shared/ shows up in the tools that copy it
    data = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    old = catalogue_at(tag)
    files = changed_files(tag)
    entries = [*data["tools"], data["hub"]]
    changes, claimed = [], set()
    for entry in entries:
        prefix = entry["folder"].rstrip("/") + "/"
        mine = [f for f in files if f.startswith(prefix) and f not in NOT_HUB]
        claimed.update(mine)
        if not mine:
            continue
        before, now = version_of(old, entry["id"], entry.get("formerly", [])), entry.get("version", data["version"])
        if now == before:  # not raised by hand: raise it
            entry["version"] = bump(now)
        changes.append({"id": entry["id"], "name": entry["name"], "from": before, "to": entry["version"],
                        "files": len(mine), "hub": entry is data["hub"], "entry": entry})
    others = [f for f in files if f not in claimed and f not in NOT_HUB and f not in VERSIONS_ONLY]
    if (changes or others) and data["version"] == old.get("version"):
        data["version"] = bump(data["version"])
    return data, changes, others


def write_versions(data: dict) -> None:
    CATALOGUE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    hub = data["hub"]["version"]
    for path, pattern in ((HUB_INIT, r'(__version__ = ")[^"]*(")'), (HUB_PYPROJECT, r'(?m)(^version = ")[^"]*(")')):
        text = path.read_text(encoding="utf-8")
        path.write_text(re.sub(pattern, rf"\g<1>{hub}\g<2>", text, count=1), encoding="utf-8")
    subprocess.run([sys.executable, str(SUITE / "shared" / "sync.py")], cwd=SUITE, check=True, capture_output=True)


def update_locally(changes: list[dict]) -> bool:
    ok = True
    for change in changes:
        entry = change["entry"]
        if ig.OS not in entry.get("platforms", [ig.OS]):
            say(f"\n{change['name']}: not for this system, skipped")
            continue
        say(f"\n=== {change['name']} {change['to']} ===")
        desktop = (ig.read_manifest(change["id"]) or {}).get("desktop_shortcut", False)
        try:
            run([sys.executable, "install.py", change["id"], *(["--desktop"] if desktop else [])])
        except subprocess.CalledProcessError:
            say(f"!! {change['name']} was not installed (see above)")
            ok = False
    return ok


def update_github(data: dict, changes: list[dict], ask: bool) -> bool:
    version = data["version"]
    tag = f"v{version}"
    if git("tag", "--list", tag).strip():
        say(f"The tag {tag} already exists. Raise \"version\" in suite.json and run this again.")
        return False
    status = git("status", "--short")
    if status:
        say("\nThese files will be committed:")
        say("".join("  " + line + "\n" for line in status.splitlines()[:40]).rstrip())
        if len(status.splitlines()) > 40:
            say(f"  … and {len(status.splitlines()) - 40} more")
    summary = ", ".join(f"{c['name']} {c['to']}" for c in changes) or "fixes"
    default = f"Snake's Suite {version}: {summary}"
    if ask:
        if status:
            typed = input(f"\nDescribe this update (Enter for \"{default}\"):\n> ").strip()
        else:
            typed = ""
        if input(f"Publish {tag} on GitHub? [Y/n] ").strip().lower().startswith("n"):
            return False
    else:
        typed = ""
    try:
        if status:
            run(["git", "add", "-A"])
            run(["git", "commit", "-q", "-m", typed or default])
        branch = git("rev-parse", "--abbrev-ref", "HEAD").strip()
        run(["git", "push", "origin", branch])
        run(["git", "tag", tag])
        run(["git", "push", "origin", tag])
    except subprocess.CalledProcessError:
        say("\n!! Stopped: the git command above failed. Nothing more was done.")
        return False
    repo = data.get("release", {}).get("repo", "")
    say(f"\nPublished {tag}. GitHub is building what changed now (a few minutes for one tool, up to 30 for everything):")
    say(f"  https://github.com/{repo}/actions")
    say("When it finishes, installed copies of Snake's Suite update themselves.")
    if ask and subprocess.run(["which", "gh"], capture_output=True).returncode == 0 \
            and input("Watch the build here? [y/N] ").strip().lower().startswith("y"):
        import time

        for _ in range(20):  # the run takes a few seconds to appear
            out = subprocess.run(["gh", "run", "list", "--workflow", "release.yml", "--branch", tag, "--limit", "1",
                                  "--json", "databaseId", "--jq", ".[0].databaseId"], cwd=SUITE,
                                 capture_output=True, text=True).stdout.strip()
            if out:
                subprocess.run(["gh", "run", "watch", out, "--exit-status"], cwd=SUITE)
                break
            time.sleep(3)
        else:
            say("The build has not shown up yet; look at the link above.")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Install your changes here, publish them on GitHub, or both.")
    parser.add_argument("--local", action="store_true", help="install the changed tools on this computer")
    parser.add_argument("--github", action="store_true", help="commit, push and publish a release")
    parser.add_argument("--dry-run", action="store_true", help="only show what changed")
    args = parser.parse_args()

    tag = last_release()
    data, changes, others = plan(tag)
    say(f"Changes since {tag or 'the start'}:")
    if not changes and not others:
        say("  nothing. There is nothing to ship.")
        return 0
    width = max([len(c["name"]) for c in changes] + [len("Release")])
    for c in changes:
        raised = "" if c["from"] != "0" else "  (new)"
        say(f"  {c['name']:<{width}}  {c['from']} -> {c['to']}{raised}   ({c['files']} file{'s' if c['files'] != 1 else ''})")
    if others:
        say(f"  {'Other files':<{width}}  {len(others)} (" + ", ".join(others[:4]) + (", …" if len(others) > 4 else "") + ")")
    say(f"  {'Release':<{width}}  v{data['version']}")
    if args.dry_run:
        return 0

    local, github = args.local, args.github
    ask = not (local or github)
    if ask:
        say("\n  1  Update locally   install the changed tools on this computer")
        say(f"  2  Update GitHub    commit, push and publish v{data['version']}")
        say("  3  Both")
        say("  q  Quit")
        try:
            answer = input("> ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            return 0
        if answer not in ("1", "2", "3"):
            return 0
        local, github = answer in ("1", "3"), answer in ("2", "3")

    write_versions(data)
    ok = True
    if local:
        ok = update_locally(changes) and ok
    if github:
        ok = update_github(data, changes, ask) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
