"""Keeping a log of every run, and reading it back to say what went wrong.

When you play a game, the "run" command starts it with --log, and the game
writes down how it is doing as it goes (see "The run log" in
runtime/host.c). That text is kept in logs/<game>/, one file per run, with
a copy of the save and the settings the run started from.

The "diagnose" command reads the newest logs and writes a report: for each
run, what happened (it went blank, it stopped, it crashed, it was slow),
the evidence from the log, and where in this tool to look next. With
--replay it also plays each troubled run again by itself, with no window,
feeding the game the same button presses, and saves pictures from around
the moment things went wrong.

So nobody has to describe a fault from memory: play, quit, diagnose.
"""

import glob
import json
import os
import re
import shutil
import struct
import subprocess
import time
import zlib
from dataclasses import dataclass, field

LOGS = "logs"
KEPT_PER_GAME = 10
# Lines the game writes for the log only; too many and too dull for the terminal.
QUIET = ("health ", "input ", "graphics program ", "gfx: ")


# ---- Writing the log -----------------------------------------------------------


def start_log(rom_name: str, save: str, settings: str) -> str:
    """Make room for a new log and return its path (which does not exist yet).

    Also copies the save and the settings as they are now, so that the run
    can be played again later from the same starting point.
    """
    folder = os.path.join(LOGS, rom_name)
    os.makedirs(folder, exist_ok=True)
    # Only the newest few runs of each game are kept.
    old = sorted(glob.glob(os.path.join(folder, "*.txt")))
    for path in old[: max(len(old) - KEPT_PER_GAME + 1, 0)]:
        for extra in glob.glob(path[:-4] + "*"):
            shutil.rmtree(extra) if os.path.isdir(extra) else os.remove(extra)

    base = os.path.join(folder, time.strftime("%Y-%m-%d_%H-%M-%S"))
    start = base + ".start"  # what the run started from
    os.makedirs(start, exist_ok=True)
    for path in glob.glob(glob.escape(os.path.splitext(save)[0]) + ".*"):  # .eep, and .sra if the game has one
        shutil.copy(path, start)
    if os.path.exists(settings):
        shutil.copy(settings, os.path.join(start, "settings.txt"))
    return base + ".txt"


def run_logged(command: list[str], log_path: str, facts: dict) -> int:
    """Run the game, keeping everything it says in the log. Returns how it ended."""
    with open(log_path, "w") as log:
        for key, value in facts.items():
            log.write(f"# {key}: {value}\n")
        log.write(f"# started: {time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        log.write(f"# command: {json.dumps(command)}\n")
        log.flush()
        game = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", bufsize=1)
        assert game.stdout is not None
        for line in game.stdout:
            log.write(line)
            if not line.startswith(QUIET):
                print(line, end="", flush=True)
        code = game.wait()
        log.write(f"# ended: {code}\n")
    return code


# ---- Reading a log ---------------------------------------------------------------


@dataclass
class Session:
    path: str
    facts: dict = field(default_factory=dict)  # the "# key: value" lines
    health: list = field(default_factory=list)  # one dict per second
    inputs: list = field(default_factory=list)  # (frame, buttons, x, y)
    events: list = field(default_factory=list)  # (frame, text)
    stalls: list = field(default_factory=list)  # (frame, [thread lines])
    stopped: list = field(default_factory=list)  # "game stopped: ..." and the line after
    programs: list = field(default_factory=list)  # names of the graphics chip programs
    unhandled: list = field(default_factory=list)  # drawing commands we did nothing with
    summary: dict = field(default_factory=dict)  # the numbers printed at the end
    threads: list = field(default_factory=list)  # the threads at the end
    other: list = field(default_factory=list)  # anything else the game said
    sound: tuple = ()  # samples a second wanted, made, sent to the chip; blocks refused; commands not known

    @property
    def frames(self) -> int:
        return max([self.summary.get("frames", 0)] + [h["frame"] for h in self.health[-1:]])

    @property
    def title(self) -> str:
        return self.facts.get("game", os.path.basename(os.path.dirname(self.path)))


def read_log(path: str) -> Session:
    session = Session(path)
    lines = open(path, errors="replace").read().splitlines()
    for number, line in enumerate(lines):
        if found := re.match(r"# (\w[\w ]*): (.*)", line):
            session.facts[found[1]] = found[2]
        elif line.startswith("screen: "):
            session.facts["screen"] = line[8:]
        elif found := re.match(r"health (\d+): (.*)", line):
            words = found[2].split()
            record = {"frame": int(found[1])}
            for key, value in zip(words[::2], words[1::2]):
                record[key] = int(value, 16) if key == "average" else int(value)
            session.health.append(record)
        elif found := re.match(r"input (\d+): (\S+) (-?\d+) (-?\d+)", line):
            session.inputs.append((int(found[1]), int(found[2], 16), int(found[3]), int(found[4])))
        elif found := re.match(r"event (\d+): (.*)", line):
            session.events.append((int(found[1]), found[2]))
        elif found := re.match(r"stalled (\d+):", line):
            threads = []
            for after in lines[number + 1 :]:
                if not after.startswith("  thread "):
                    break
                threads.append(after.strip())
            session.stalls.append((int(found[1]), threads))
        elif line.startswith(("game stopped:", "host:")):
            session.stopped.append(line)
            if number + 1 < len(lines) and lines[number + 1].startswith("  thread"):
                session.stopped.append(lines[number + 1].strip())
        elif found := re.match(r'graphics program at \S+ "(.*?)", checksum (\S+), dialect (\d)', line):
            session.programs.append((found[1].strip(), found[2].rstrip(","), int(found[3])))
        elif line.startswith("gfx:"):
            session.unhandled.append(line[5:])
        elif found := re.match(r"ran (\d+) frames", line):
            session.summary["frames"] = int(found[1])
        elif found := re.match(r"  sound rate:\s+wants (\d+) a second; made (\d+), sent to the chip (\d+); (\d+) blocks refused.*?(\d+) commands not known", line):
            session.summary["sound rate"] = line.split(":", 1)[1].strip()
            session.sound = tuple(int(found[i]) for i in range(1, 6))
        elif found := re.match(r"  (pictures drawn|interpreted|late refreshes|sound|frames cut short[\w ]*):\s+(.*)", line):
            session.summary[found[1]] = found[2]
        elif line.startswith("  thread ") and "priority" in line and "frames" in session.summary:
            session.threads.append(line.strip())
        elif line.strip() and not line.startswith(("  ", "trace ")):
            session.other.append(line)
    return session


# ---- Working out what went wrong -------------------------------------------------


@dataclass
class Finding:
    what: str  # one line: what happened
    evidence: list  # lines from the log that show it
    look: list  # where to look next
    frame: int = -1  # when, if it has a moment
    serious: bool = True


def clock(frame: int) -> str:
    """A frame number as minutes and seconds into the run."""
    return f"{frame // 3600}:{frame // 60 % 60:02d}"


BUTTONS = {0x8000: "A", 0x4000: "B", 0x2000: "Z", 0x1000: "Start", 0x0800: "D-up", 0x0400: "D-down", 0x0200: "D-left",
           0x0100: "D-right", 0x0020: "L", 0x0010: "R", 0x0008: "C-up", 0x0004: "C-down", 0x0002: "C-left", 0x0001: "C-right"}  # fmt: skip


def last_press(session: Session, frame: int) -> str:
    """What the player last pressed before a moment, as a hint at what set it off."""
    presses = [i for i in session.inputs if i[0] <= frame and i[1]]
    if not presses:
        return "no button had been pressed yet"
    when, buttons, _, _ = presses[-1]
    names = "+".join(name for bit, name in BUTTONS.items() if buttons & bit)
    return f"the last button before it was {names}, {(frame - when) / 60:.1f} s earlier (frame {when})"


def addresses(threads: list) -> list:
    """The places in the game's code that waiting threads last called from."""
    return sorted({found[1] for t in threads if ", waiting," in t and (found := re.search(r"last call from (0x[0-9A-F]{8})", t))})


def busy(threads: list) -> list:
    """Leave out the threads that have finished: they are not what anything is waiting for."""
    return [t for t in threads if ", finished," not in t and ", stopped," not in t]


def blank_stretches(health: list) -> list:
    """(first, last) positions in the list of each run of seconds with a blank screen."""
    stretches, start = [], None
    for i, h in enumerate(health + [{"colours": 99}]):
        if h.get("colours", 99) <= 1 and start is None:
            start = i
        elif h.get("colours", 99) > 1 and start is not None:
            stretches.append((start, i - 1))
            start = None
    return stretches


def find_problems(session: Session) -> list:
    findings = []
    health, rom = session.health, session.facts.get("rom", "<rom>")
    ended = int(session.facts.get("ended", "0") or 0)
    disasm = f'python3 -m snakedecomp disasm "{rom}" -f -a '

    # It stopped by itself.
    stops = [s for s in session.stopped if s.startswith(("game stopped", "host:"))]
    if stops:
        reason = stops[0].split(":", 1)[1].strip()
        look = []
        place = re.search(r"at (0x[0-9A-F]{8})", reason)
        caller = re.search(r"(?:return address|last call from) (0x[0-9A-F]{8})", " ".join(session.stopped))
        if "crashed" in reason:
            look.append("Our own program faulted, not the game's code: most often the renderer or the sound code "
                        "following an address the game gave it. Replay under gdb to see the line: "
                        "gdb --args <the command line in this log, with --headless>.")  # fmt: skip
        elif "stuck in a loop" in reason:
            look.append("A thread goes round forever without the frame ending. Usually it is polling a hardware "
                        "register or a flag that an interrupt would set on the console.")  # fmt: skip
        elif "nothing has run" in reason:
            look.append("Every thread is waiting for a message that never arrives: an event the console would "
                        "send (a timer, a controller or cartridge answer, the graphics chip finishing) is not sent.")  # fmt: skip
        else:
            look.append("The game reached something this tool does not do yet (an instruction or a library "
                        "function). The reason above names it.")  # fmt: skip
        if place:
            look.append(f"The place it stopped: {disasm}{place[1]}")
        if caller:
            look.append(f"What called it: {disasm}{caller[1]}")
        for address in addresses(session.threads):
            look.append(f"A waiting thread: {disasm}{address}")
        findings.append(Finding(f"The game stopped by itself: {reason}", session.stopped + busy(session.threads), look, session.frames))
    elif ended < 0:
        findings.append(Finding(f"The game program was killed (signal {-ended}) without saying why.", [], [
            "If you did not close it yourself, it crashed somewhere the crash message could not be written."], session.frames))  # fmt: skip

    # The screen went blank.
    for first, last in blank_stretches(health):
        seconds = last - first + 1
        to_the_end = last == len(health) - 1
        if seconds < 5 or (first == 0 and not to_the_end and seconds < 20):
            continue  # a fade between screens, or the dark moment before the first logo
        part = health[first : last + 1]
        frame = health[first]["frame"]
        pictures = sum(h["pictures"] for h in part)
        shapes = sum(h["triangles"] + h["rectangles"] for h in part)
        skipped = sum(h["unhandled"] for h in part)
        colour = f"{part[-1]['average']:06X}"
        how_long = "and stayed blank until the run ended" if to_the_end else f"for {seconds} seconds"
        what = (f"The screen never showed anything (blank {how_long})" if first == 0
                else f"The screen went blank at {clock(frame)} (frame {frame}) {how_long}")  # fmt: skip
        evidence = [f"blank colour #{colour}; in that time the game made {pictures} pictures holding {shapes} shapes, "
                    f"and {skipped} drawing commands were skipped", last_press(session, frame)]  # fmt: skip
        look = []
        stall = next((s for s in session.stalls if frame - 60 <= s[0] <= health[last]["frame"] + 60), None)
        quiet = sum(1 for h in part if h["pictures"] == 0)
        if quiet >= len(part) * 0.8:
            evidence.append(f"the game stopped sending pictures at all ({quiet} of those {seconds} seconds had none)")
            look.append("This is not a drawing fault: the game itself is waiting for something. See which "
                        "thread is waiting and where (runtime/host.c answers the library calls).")  # fmt: skip
            for address in addresses(stall[1] if stall else session.threads):
                look.append(f"A waiting thread: {disasm}{address}")
            look.append("TRACE_OS=1 with --replay shows the last library calls before it went quiet.")
        elif shapes == 0:
            evidence.append("the game keeps sending pictures, but nothing in them is drawn")
            look.append("The pictures hold no triangles or rectangles that we understand. If commands were skipped, "
                        "they are the missing piece (runtime/gfx.c, run_list); otherwise the game may be drawing "
                        "with a chip program we do not know (see the graphics programs below).")  # fmt: skip
        else:
            evidence.append("the game keeps drawing shapes, but they do not show")
            look.append("A renderer fault (runtime/gfx.c, gfx_gl.c): the shapes are drawn somewhere unseen (another "
                        "colour image), cut away, or fully transparent. Replay with SHOW_RECTANGLES=1 and "
                        "SHOW_SCISSORS=1 at that frame to see what is being drawn where.")  # fmt: skip
        if stall:
            evidence += busy(stall[1])
        findings.append(Finding(what, evidence, look, frame))

    # It stopped making pictures while something still showed (a frozen picture).
    if not any(f.frame >= 0 and "blank" in f.what for f in findings):
        for frame, threads in session.stalls:
            look = [f"A waiting thread: {disasm}{address}" for address in addresses(threads)]
            look.append("The game is waiting for something that never comes; the picture on screen is its last one.")
            findings.append(Finding(f"The game froze at {clock(frame - 300)} (frame {frame - 300}): no new picture for five seconds",
                                    [last_press(session, frame - 300)] + busy(threads), look, frame - 300))  # fmt: skip
            break

    # Drawing commands and chip programs we do not know.
    strange = [p for p in session.programs if re.search(r"S2D|L3D|ZSort|Turbo", p[0], re.I)]
    if strange:
        findings.append(Finding("The game draws with a chip program this tool has no drawing code for: " + ", ".join(sorted({p[0] for p in strange})),
                                [], ["Whatever that program draws (often 2D: backgrounds, sprites, text) is missing or wrong. "
                                     "It needs its own set of commands in runtime/gfx.c, picked in graphics_dialect() in host.c."]))  # fmt: skip
    skipped = sum(h["unhandled"] for h in health)
    if skipped:
        findings.append(Finding(f"{skipped} drawing commands were skipped because we do not handle them",
                                session.unhandled[:12], ["Each is named by its first byte; add them in run_list() in runtime/gfx.c. "
                                                         "Harmless ones can be ignored on purpose there."], serious=skipped > 100))  # fmt: skip

    # Sound that is lost or invented on the way: it crackles, and music plays at the wrong speed.
    if session.sound and session.frames > 600:
        wants, made, sent, refused, unknown = session.sound
        if refused > 3:
            findings.append(Finding(f"{refused} blocks of sound were thrown away because the sound chip was full", [session.summary["sound rate"]], [
                "The game is not being told the chip is full, or does not wait when told (runtime/host.c, 'Sound output'). "
                "TRACE_OS=1 shows whether it asks the library (osAiGetStatus, osAiGetLength) or reads the chip itself."]))  # fmt: skip
        if made and abs(made - sent) > sent * 0.02 + 50:
            findings.append(Finding(f"The game's sound program made {made} samples a second but {sent} reached the sound chip", [session.summary["sound rate"]], [
                "Sound is being lost (or played twice) between being made and being played: hiccups."]))  # fmt: skip
        if sent and abs(sent - wants) > wants * 0.03:
            findings.append(Finding(f"The game sends {sent} samples of sound a second but asked to play {wants}", [session.summary["sound rate"]], [
                "Too few: gaps and crackle. Too many: sound is dropped, and music runs fast. Look at how the game "
                "decides how much to make each frame (the length the chip reports, or its own count of frames)."]))  # fmt: skip
        if unknown:
            findings.append(Finding(f"{unknown} sound commands were not understood", [], [
                "The game's sound program speaks a dialect runtime/audio.c does not know (SHOW_SOUND=<list number> prints a list)."]))  # fmt: skip

    # Choppy: pictures reaching the window unevenly, or a screen they do not fit.
    steady = [h for h in health[2:] if not h["menu"] and h["speed"] <= 110 and h["pictures"] >= 10 and h.get("longest")]
    # (A wait of a whole number of screen refreshes is the game itself taking longer over a picture, as it
    # does when loading or changing scene: the console did the same. Only waits in between are the PC's doing.)
    uneven = [h for h in steady if h["longest"] > 1.5 * 10000 / h["pictures"] and abs(h["longest"] / 166.7 - round(h["longest"] / 166.7)) > 0.15]
    if len(uneven) > max(len(steady) // 10, 2):
        worst = max(uneven, key=lambda h: h["longest"])
        findings.append(Finding(f"Pictures reached the window unevenly in {len(uneven)} of {len(steady)} seconds, which looks choppy", [
            f"worst: {worst['longest'] / 10:.1f} ms between two pictures at {clock(worst['frame'])}, where "
            f"{1000 / worst['pictures']:.1f} ms was due"], ["The PC was late showing pictures (runtime/host.c: show_picture, "
            "wait_for_next_frame), or something else on the PC was holding the window up."]))  # fmt: skip
    hertz = re.search(r"at (\d+) Hz", session.facts.get("screen", ""))
    rates = sorted({h["pictures"] for h in steady})
    if hertz and steady:
        usual = max(set(h["pictures"] for h in steady), key=[h["pictures"] for h in steady].count)
        if usual and int(hertz[1]) % usual:
            findings.append(Finding(f"The game makes {usual} pictures a second but the screen redraws {hertz[1]} times a second", [
                "those do not divide evenly, so some pictures stay up longer than others: motion looks uneven"],
                ["Play on a 60 Hz screen, or set this one to 60 Hz while playing."], serious=False))  # fmt: skip

    # Fast forward: not a fault, but it looks and sounds like one.
    fast = [h for h in health[2:] if not h["menu"] and h["speed"] > 150]
    if len(fast) >= 3:
        findings.append(Finding(f"Fast forward was held for about {len(fast)} seconds (first at {clock(fast[0]['frame'])})", [
            "the game runs several times too fast then, and there is no sound"], [
            "If that was not meant, see which key or gamepad button is 'Fast forward' in the menu under Shortcuts."], fast[0]["frame"], serious=False))  # fmt: skip

    # Speed.
    normal = [h["speed"] for h in health[2:] if not h["menu"] and h["speed"] <= 110]
    slow = [s for s in normal if s < 90]
    if len(normal) >= 10 and len(slow) > len(normal) / 5:
        look = ["See the 'interpreted' and 'drawing time' lines at the end of the log: code that is interpreted "
                "rather than translated is slow, and so are very large pictures (lower the resolution in the menu)."]  # fmt: skip
        findings.append(Finding(f"It ran slowly: under 90% speed for {len(slow)} of {len(normal)} seconds "
                                f"(worst {min(slow)}%)", [f"{k}: {v}" for k, v in session.summary.items() if k != "frames"], look))  # fmt: skip
    return findings


def describe(session: Session, findings: list) -> str:
    """The part of the report about one run."""
    frames = session.frames
    presses = sum(1 for i in session.inputs if i[1])
    out = [f"== {session.title} [{session.facts.get('code', '?')}]  {session.facts.get('started', '?')}",
           f"   ran {clock(frames)} ({frames} frames), {presses} button presses, log: {session.path}"]  # fmt: skip
    if session.programs:
        out.append("   graphics programs: " + "; ".join(sorted({f"{name or '(no name)'} (dialect {d})" for name, _, d in session.programs})))
    for frame, text in session.events:
        out.append(f"   at {clock(frame)}: {text}")
    if len(session.health) < 3 and not findings:
        out.append("   Too short to say anything (under three seconds).")
    elif not findings:
        out.append("   Nothing wrong that a log can see: it drew pictures to the end and stopped when asked.")
        out.append("   (A log cannot see wrong colours, garbled text or bad sound: for those, press F12 for a")
        out.append("   screenshot at the bad moment and it will be in screenshots/.)")
    for finding in findings:
        out.append(f" {'*' if finding.serious else '-'} {finding.what}")
        out += [f"       {line}" for line in finding.evidence]
        out += [f"     > {line}" for line in finding.look]
    return "\n".join(out)


# ---- Playing a run again -----------------------------------------------------------


def write_png(path: str, ppm: bytes) -> None:
    """Save a PPM picture (what the game writes) as a PNG (what everything else reads)."""
    found = re.match(rb"P6\s+(\d+)\s+(\d+)\s+255\s", ppm)
    if not found:
        return
    w, h, pixels = int(found[1]), int(found[2]), ppm[found.end() :]
    rows = b"".join(b"\0" + pixels[y * w * 3 : (y + 1) * w * 3] for y in range(h))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    with open(path, "wb") as out:
        out.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)))
        out.write(chunk(b"IDAT", zlib.compress(rows, 6)) + chunk(b"IEND", b""))


def replay(session: Session, findings: list) -> list:
    """Play a run again with no window and the same button presses.

    Returns lines for the report: whether the same thing happened, and where
    the pictures from around that moment are.
    """
    try:
        command = json.loads(session.facts["command"])
    except (KeyError, ValueError):
        return ["   replay: this log does not say how the game was started"]
    if not os.path.exists(command[0]):
        return ["   replay: the game is no longer built"]
    # Loading a state or resetting cannot be played back: stop just before.
    breaks = [frame for frame, text in session.events if re.search(r"reset|load", text, re.I)]
    end = min(breaks) if breaks else session.frames
    moments = [f.frame for f in findings if 0 <= f.frame <= end]
    focus = min(moments) if moments else end
    end = min(end, focus + 600)  # ten seconds past the trouble is enough

    base = session.path[:-4]
    out_dir, start = base + ".replay", base + ".start"
    shutil.rmtree(out_dir, ignore_errors=True)
    os.makedirs(os.path.join(out_dir, "save"))
    # A copy of the save the run started from: the replay must not touch your real one.
    for path in glob.glob(os.path.join(glob.escape(start), "*")):
        shutil.copy(path, os.path.join(out_dir, "save" if not path.endswith("settings.txt") else ""))
    saves = [p for p in glob.glob(os.path.join(glob.escape(out_dir), "save", "*.eep"))]
    save = saves[0] if saves else os.path.join(out_dir, "save", "scratch.eep")

    # The same command, with our own save, settings and places for output.
    replaced = {"--save": save, "--settings": os.path.join(out_dir, "settings.txt"), "--states": os.path.join(out_dir, "state"),
                "--pictures": os.path.join(out_dir, "picture")}  # fmt: skip
    again, skip = [], False
    for i, word in enumerate(command):
        if skip:
            skip = False
        elif word in replaced:
            again += [word, replaced[word]]
            skip = True
        elif word not in ("--log", "--stats"):
            again.append(word)
    shots = os.path.join(out_dir, "shots")
    os.makedirs(shots)
    again += ["--headless", "--log", "--replay", session.path, "--frames", str(end + 1), "--screenshots", shots,
              "--from", str(max(focus - 360, 0)), "--every", "60"]  # fmt: skip
    log_path = os.path.join(out_dir, "replay.txt")
    try:
        with open(log_path, "w") as log:
            log.write(f"# game: {session.title}\n# rom: {session.facts.get('rom', '')}\n# command: {json.dumps(again)}\n")
            log.flush()
            done = subprocess.run(again, stdout=log, stderr=subprocess.STDOUT, timeout=120 + end / 20)
            log.write(f"# ended: {done.returncode}\n")
    except subprocess.TimeoutExpired:
        return ["   replay: took too long and was stopped"]
    for ppm in sorted(glob.glob(os.path.join(glob.escape(shots), "*.ppm"))):
        write_png(ppm[:-4] + ".png", open(ppm, "rb").read())
        os.remove(ppm)

    replayed = read_log(log_path)
    theirs = find_problems(replayed)
    lines = [f"   replay (no window, same buttons, to frame {end}): pictures in {shots}"]
    if not findings:
        return lines
    same = [t for t in theirs if any(t.what.split(":")[0].split(" at ")[0] == f.what.split(":")[0].split(" at ")[0] for f in findings)]
    if same:
        lines.append("   replay: THE SAME THING HAPPENED, so it can be worked on without you: " + "; ".join(t.what for t in same))
    elif theirs:
        lines.append("   replay: something else happened: " + "; ".join(t.what for t in theirs))
    else:
        lines.append("   replay: the fault did NOT happen again. Without a window the picture is drawn by other code "
                     "(gfx.c alone, not gfx_gl.c), so that points at gfx_gl.c; or the fault depends on timing.")  # fmt: skip
    return lines


# ---- The report ----------------------------------------------------------------------


def newest_logs(count: int, games: list) -> list:
    """The newest log of each game, newest first; or the newest few of the games named."""
    paths = sorted(glob.glob(os.path.join(LOGS, "*", "*.txt")), key=os.path.getmtime, reverse=True)
    if games:
        return [p for p in paths if any(g.lower() in os.path.dirname(p).lower() for g in games)][:count]
    chosen, seen = [], set()
    for path in paths:
        if os.path.dirname(path) not in seen:
            seen.add(os.path.dirname(path))
            chosen.append(path)
    return chosen[:count]


def report(count: int = 6, games: tuple = (), with_replay: bool = False) -> str:
    parts = []
    for path in newest_logs(count, list(games)):
        session = read_log(path)
        findings = find_problems(session)
        text = describe(session, findings)
        if with_replay and (findings or games):
            print(f"Replaying {session.title}...", flush=True)
            text += "\n" + "\n".join(replay(session, findings))
        parts.append(text)
    if not parts:
        return "No logs yet. Play a game with ./play and quit it; then run this again."
    text = "\n\n".join(parts)
    with open(os.path.join(LOGS, "report.txt"), "w") as out:
        out.write(f"Report written {time.strftime('%Y-%m-%d %H:%M:%S')}: the newest runs, newest first.\n\n{text}\n")
    return text
