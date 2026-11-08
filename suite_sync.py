#!/usr/bin/env python3
"""Keep the suite in step between mainrig, the laptop and GitHub.

    python3 suite_sync.py            # what is ahead, behind, unmerged or uncommitted
    python3 suite_sync.py --brief    # warnings only, one line each (for session start)
    python3 suite_sync.py clean      # exit 1 if there are uncommitted changes (before installing a build)
    python3 suite_sync.py share      # push this machine's work: see below

The meeting point is GitHub's master-suite branch (`origin`). The laptop also has the PC as a
remote (`pc`, over Tailscale), so it can see the PC's work before it reaches GitHub.

- The PC works on master-suite and shares it by pushing to origin.
- The laptop works on the `laptop` branch while its work is not merged; `share` pushes that branch
  to origin and, when the PC is on, to the PC. The PC merges it into master-suite.
- main, tags and releases are not touched here (`python ship.py` does releases).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

SUITE = Path(__file__).resolve().parent
MAIN = "master-suite"
LAPTOP = "laptop"
SSH = "ssh -o ConnectTimeout=5 -o BatchMode=yes"


def git(*args: str, check: bool = False, timeout: int = 30) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_SSH_COMMAND=SSH, GIT_TERMINAL_PROMPT="0")
    return subprocess.run(["git", *args], cwd=SUITE, capture_output=True, text=True,
                          check=check, timeout=timeout, env=env)


def out(*args: str) -> str:
    return git(*args).stdout.strip()


def exists(ref: str) -> bool:
    return git("rev-parse", "--verify", "--quiet", ref).returncode == 0


def count(a: str, b: str) -> int:
    """Commits in b that a does not have."""
    if not (exists(a) and exists(b)):
        return 0
    return int(out("rev-list", "--count", f"{a}..{b}") or 0)


def remotes() -> list[str]:
    return out("remote").split()


def fetch(remote: str) -> str | None:
    """Fetch a remote; return why it failed, or None."""
    try:
        r = git("fetch", "--quiet", "--prune", remote, timeout=25)
    except subprocess.TimeoutExpired:
        return "timed out"
    if r.returncode:
        err = r.stderr.lower()
        if any(w in err for w in ("timed out", "could not", "no route", "resolve", "connection", "unreachable")):
            return "not reachable"
        if "permission denied" in err:
            return "no access"
        return (r.stderr.strip().splitlines() or ["failed"])[0]
    return None


def uncommitted() -> list[str]:
    return [l for l in out("status", "--porcelain").splitlines() if l.strip()]


def status(brief: bool) -> int:
    warn: list[str] = []
    info: list[str] = []
    branch = out("rev-parse", "--abbrev-ref", "HEAD")
    reach = {}
    for r in remotes():
        why = fetch(r)
        reach[r] = why is None
        if why:
            info.append(f"· {r}: not checked ({why})")

    dirty = uncommitted()
    if dirty:
        warn.append(f"⚠ {len(dirty)} uncommitted change(s) on {branch}: commit before building or installing")

    origin_main = f"origin/{MAIN}"
    # This machine's master-suite against GitHub.
    if exists(MAIN) and reach.get("origin"):
        ahead, behind = count(origin_main, MAIN), count(MAIN, origin_main)
        if ahead:
            warn.append(f"⚠ {MAIN} has {ahead} commit(s) not on GitHub: share them (suite_sync.py share)")
        if behind:
            warn.append(f"⚠ GitHub has {behind} {MAIN} commit(s) this machine lacks: git pull")
        if not ahead and not behind:
            info.append(f"✔ {MAIN} matches GitHub")

    # The PC, seen from the laptop.
    if "pc" in remotes() and reach.get("pc"):
        pc_main = f"pc/{MAIN}"
        unpushed = count(origin_main, pc_main)
        if unpushed:
            warn.append(f"⚠ the PC has {unpushed} {MAIN} commit(s) not on GitHub (push them from the PC)")
        lacking = count(MAIN, pc_main) if exists(MAIN) else 0
        if lacking:
            warn.append(f"⚠ the PC has {lacking} commit(s) this machine's {MAIN} lacks: git pull pc {MAIN}")

    # Laptop work waiting for the PC to merge it.
    targets = [r for r in (f"pc/{MAIN}", origin_main, MAIN) if exists(r)]
    for b in (LAPTOP, f"origin/{LAPTOP}", f"pc/{LAPTOP}"):
        if exists(b) and targets:
            waiting = min(count(t, b) for t in targets)
            if waiting:
                log = out("log", "--format=%s", f"{targets[0]}..{b}").splitlines()
                warn.append(f"⚠ {b}: {waiting} commit(s) not merged into {MAIN} yet: " + "; ".join(log[:3]))
                if b == LAPTOP and reach.get("origin") and (not exists(f"origin/{LAPTOP}")
                                                             or count(f"origin/{LAPTOP}", LAPTOP)):
                    warn.append(f"⚠ {LAPTOP} has commits not on GitHub: suite_sync.py share")
                break

    if brief:
        for line in warn:
            print(f"Snake's Master Suite: {line[2:]}")
        return 1 if warn else 0
    print(f"Snake's Master Suite ({SUITE}), on branch {branch}")
    for line in info + warn:
        print("  " + line)
    if not warn:
        print("  ✔ nothing to do")
    return 1 if warn else 0


def share() -> int:
    branch = out("rev-parse", "--abbrev-ref", "HEAD")
    if uncommitted():
        print("Commit first: there are uncommitted changes.")
        return 1
    if branch not in (MAIN, LAPTOP):
        print(f"On '{branch}': share works from {MAIN} (the PC) or {LAPTOP} (the laptop).")
        return 1
    ok = True
    r = git("push", "origin", branch, timeout=120)
    print(f"GitHub ({branch}): " + ("pushed" if r.returncode == 0 else "FAILED\n" + r.stderr.strip()))
    ok &= r.returncode == 0
    if branch == LAPTOP and "pc" in remotes():
        # The PC has master-suite checked out, so the laptop hands over its own branch.
        r = git("push", "pc", LAPTOP, timeout=120)
        if r.returncode == 0:
            print("PC (laptop branch): pushed; merge it there into master-suite")
        else:
            print("PC: not reachable, it will get the work from GitHub")
    return 0 if ok else 1


def main() -> int:
    args = sys.argv[1:]
    if not (SUITE / ".git").exists():
        print(f"{SUITE} is not a git checkout")
        return 2
    if args[:1] == ["clean"]:
        dirty = uncommitted()
        for line in dirty:
            print(line)
        return 1 if dirty else 0
    if args[:1] == ["share"]:
        return share()
    if args in ([], ["--brief"]):
        return status(brief=bool(args))
    print(__doc__)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
