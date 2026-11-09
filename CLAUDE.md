# Snake's Master Suite

- `MASTER_PLAN.md`: what exists, status, where work stopped. Update its Status when a piece lands.
- `VISION.md`: where the suite is going (economical, mid-tier, money-no-object).
- `README.md`: for users and for releasing. Each app has its own README; keep it in step.
- Ideas come through `../IDEAS.md` (see `../CLAUDE.md`).

## Rules that bite

- Work on the `master-suite` branch. `main` is what is released; never push, tag or release
  without the owner saying so (`python ship.py` does releases).
- Changing an app: raise its `version` in `suite.json` **and** in the app's own manifest
  (`package.json`, `pyproject.toml`, `Cargo.toml`) together; `packaging/build.py` stops when they
  differ.
- On the desktop, Code and Terminal ship inside the Studio package (`"hosted"` in suite.json,
  Studio's `src/main/boot.js`): the nine apps share one Electron and one version, and
  `ship.py` raises them together. Run Code or Terminal from their own folders while developing;
  test the merged package with `python packaging/build.py tool terminal`. On Android they are
  still their own APKs, and `studio_app` still means "one of the seven in the Studio APK".
- Studio, Code and Terminal are hardened Electron apps: context isolation, sandbox, CSP, IPC
  checks the sender. New main-process powers go through the preload bridge and write only where
  the user chose (a dialog), never a path the page sends.
- Snake's Terminal's pages also run on Android (`android/apps/terminal`, its own bridge in
  `src/main/web/android-bridge.js`): guard any new `window.snake.*` call that only the desktop has.
- `shared/` holds the originals of the theme and icons; run `python shared/sync.py` after changing them.

## Apply every change live (always, without being asked)

The owner tests in the copy they launch from the app menu, not the source folder. After
changing an app, building, linting and testing it, put it into the installed copy:

1. `python packaging/build.py tool <id>` → `release/snakes-<x>-linux-x86_64.tar.gz`. Code,
   Terminal and the seven Studio apps all build the one Studio package.
2. Find the install folder in `~/.local/share/snakes-suite/apps/`: the one whose
   `snake-package.json` has that id (`_studio` for the Studio package; `daw`, `converter`, ...).
3. Check the app is not running (`pgrep -x snakes-studio` etc.); if it is, ask the owner to close it.
4. Unpack into `<folder>.new`; for `_studio`, copy `resources/ffmpeg` over from the old copy if
   the new one has none (build.py only bundles it with `SNAKE_FFMPEG_DIR`). Then
   `<folder>` → `<folder>.old` (replace any older backup) and `<folder>.new` → `<folder>`.
5. Launch the installed program headless (below, with its `--app=<id>` if it has one and port
   9336) and check the change there.
6. **Do the same on the laptop** (`lenovoloq`): `scp` the archive to `lenoloq-ts:/tmp/`, then
   steps 2-4 over `ssh lenoloq-ts 'sh -s' <<'EOF' ... EOF` (its login shell is fish). It has no
   gamescope or Node, so check it by comparing `sha256sum` of the installed `resources/app.asar`
   (or the program) with the one tested here. If it is offline, say so and do it next time.
7. Tell the owner it is live on both machines and to restart the app. This is local: no commit,
   push or release.

If the app is not installed on a machine, say so instead of installing it there.

Sessions started from the Claude app on the laptop work in scratch folders and reach this PC
with `ssh pc` (or `pc-ts` away from home); its `~/.claude/CLAUDE.md` points them here, so this
section applies to them too: build here, install on both.

## Running and testing an Electron app headless

```bash
gamescope --backend headless -W 1280 -H 800 -- ./node_modules/.bin/electron . \
  --remote-debugging-port=9335 --user-data-dir=<scratch dir>
```

Then drive it over CDP (`curl localhost:9335/json` for the page, `Runtime.evaluate`,
`Input.dispatchMouseEvent`, `Page.captureScreenshot`). Snake's Terminal exposes
`window.snakeTerminal` (`run(id)`, `activeSession()`, `settings`); the Studio exposes
`window.snakeApp`. A separate `--user-data-dir` keeps the owner's settings and the
single-instance lock out of it.

Stop it by PID (`pgrep gamescope`, check its args, `kill <pid>`). `pkill -f <pattern>` also
kills your own shell when the pattern is in your command line.
