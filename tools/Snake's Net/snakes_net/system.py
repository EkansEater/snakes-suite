"""Starting again: as administrator, or in a terminal window, on each system."""

import os
import shlex
import shutil
import subprocess
import sys

WINDOWS = sys.platform == "win32"
MACOS = sys.platform == "darwin"


def self_command():
    """How to start this app again."""
    if getattr(sys, "frozen", False):  # a packaged program
        return [sys.executable]
    launcher = os.environ.get("SNAKES_NET_LAUNCHER")
    if launcher and os.path.isfile(launcher):
        return [launcher]
    pkg_parent = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if WINDOWS:
        return [sys.executable, "-m", "snakes_net"]  # run from source: PYTHONPATH set below
    return ["env", f"PYTHONPATH={pkg_parent}", sys.executable, "-m", "snakes_net"]


def set_title(title):
    if WINDOWS:
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleTitleW(title)
        except Exception:
            pass
        return
    sys.stdout.write(f"\033]0;{title}\007")
    sys.stdout.flush()


def restart_elevated(argv):
    """Start again with administrator rights: sudo on Linux and macOS, UAC on Windows."""
    if WINDOWS:
        import ctypes
        cmd = self_command()
        params = subprocess.list2cmdline(cmd[1:] + list(argv))
        # From source, start in the folder above the package so `-m snakes_net` finds it.
        folder = os.getcwd() if getattr(sys, "frozen", False) else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        r = ctypes.windll.shell32.ShellExecuteW(None, "runas", cmd[0], params, folder, 1)
        if r <= 32:
            sys.exit("Snake's Net wasn't started as administrator (cancelled).")
        return
    print("Restarting Snake's Net with sudo, to see every app's traffic...")
    try:
        os.execvp("sudo", ["sudo", "--", *self_command(), *argv])
    except OSError as e:
        sys.exit(f"Could not run sudo: {e}")


# Terminal apps on Linux and how each one runs a command.
TERMINALS = [
    ("konsole", ["--separate", "-e"]), ("kgx", ["--"]), ("gnome-terminal", ["--"]),
    ("ptyxis", ["--"]), ("kitty", []), ("alacritty", ["-e"]), ("foot", []),
    ("wezterm", ["start", "--"]), ("ghostty", ["-e"]), ("xfce4-terminal", ["-x"]),
    ("mate-terminal", ["-x"]), ("tilix", ["-e"]), ("terminator", ["-x"]),
    ("lxterminal", ["-e"]), ("x-terminal-emulator", ["-e"]), ("xterm", ["-e"]),
]


def open_in_terminal(argv):
    """Started without a terminal (from a menu or the hub): open one to run in."""
    if os.environ.get("SNAKES_NET_SPAWNED"):
        sys.exit("Snake's Net needs a terminal.")
    cmd = self_command() + list(argv)
    env = dict(os.environ, SNAKES_NET_SPAWNED="1")
    if WINDOWS:
        subprocess.Popen(cmd, env=env, creationflags=subprocess.CREATE_NEW_CONSOLE)
        return
    if MACOS:
        line = "SNAKES_NET_SPAWNED=1 exec " + " ".join(shlex.quote(a) for a in cmd)
        script = line.replace("\\", "\\\\").replace('"', '\\"')
        subprocess.Popen(["osascript", "-e", f'tell application "Terminal" to do script "{script}"',
                          "-e", 'tell application "Terminal" to activate'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return
    wanted = os.environ.get("TERMINAL")
    choices = ([(wanted, dict(TERMINALS).get(os.path.basename(wanted), ["-e"]))] if wanted else []) + TERMINALS
    for name, flags in choices:
        exe = shutil.which(name)
        if exe:
            subprocess.Popen([exe, *flags, *cmd], env=env, start_new_session=True,
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            return
    msg = "Snake's Net runs in a terminal, and no terminal app was found. Install Konsole or GNOME Terminal."
    if shutil.which("notify-send"):
        subprocess.run(["notify-send", "-i", "network-wired", "Snake's Net", msg])
    sys.exit(msg)
