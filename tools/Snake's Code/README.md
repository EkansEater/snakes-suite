# Snake's Code 🐍

A desktop code editor in the spirit of VS Code, built on **Electron**, **Monaco** (the editor core VS Code uses), **xterm.js** and **node-pty**.

## Running it

```bash
npm install        # installs deps, downloads Electron, builds node-pty for Electron
npm start          # bundles the renderer and launches the app
```

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | Build and launch with DevTools open |
| `npm run watch` | Rebuild the renderer on change (then use *Developer: Reload Window*, `Ctrl+Shift+F5`) |
| `npm run lint` | ESLint over the sources |
| `npm run rebuild` | Rebuild `node-pty` against Electron if the terminal fails to start |
| `bin/snakes-code [path]` | Launcher script: open a folder or file |
| `bin/install-desktop-entry.sh` | Add Snake's Code to your desktop app menu |

## Features

**Editor**
- Monaco editor: IntelliSense for JS/TS/JSON/CSS/HTML, syntax highlighting for ~80 languages, multi-cursor, find/replace, folding, minimap, sticky scroll, bracket-pair colorization, go to definition, rename symbol, and format document.
- Language servers: for C/C++, Python, Rust, Go, Java, C#, PHP, Ruby, Lua, Swift, Kotlin, Dart, Zig, shell scripts, YAML, TOML and more, Snake's Code uses the server program you already have installed (clangd, pyright or pylsp, rust-analyzer, gopls...). You get completions, hover, parameter hints, inlay hints, errors and warnings in Problems, go to definition / implementation / references, rename across files, formatting, quick fixes and Go to Symbol in Workspace (`Ctrl+T`). The status bar shows which server is running (click it to restart it or see its log), or how to install one. `languageServers.custom` picks a different program or adds a file type: `python=pylsp; .nim=nimlangserver`.
- Tabs with preview mode (italic), dirty indicators, drag to reorder, drag between groups, middle-click to close, and a context menu.
- Split editors: side-by-side groups with resizable sashes; drop a tab on the right edge to split.
- Breadcrumbs: click a segment to browse sibling files.
- Diff editor for git changes, Compare with Saved, Compare with Clipboard, and comparing two files from the explorer.
- Markdown preview to the side, updated live, with syntax-highlighted code blocks.
- Image, audio and video viewers, plus binary file detection.
- Git change markers in the gutter (added, modified, deleted). Jump between them with `Alt+F5`.
- Save participants: format on save, trim trailing whitespace, insert final newline.
- Auto save (after delay, on focus change, or on window change).
- Hot exit: unsaved changes and untitled files survive a restart.
- Detects external file changes, reloads the file, and offers Compare/Overwrite/Revert when there's a conflict.

**Workbench**
- Command Palette (`Ctrl+Shift+P`) lists every app command plus Monaco's editor actions, with recently used commands first.
- Quick Open (`Ctrl+P`) does fuzzy file search and supports `:line`, `@symbol`, `>command`, `#search`, `edt ` (open editors) and `?` (help).
- Explorer: lazy file tree with file-type icons, inline create/rename (`a/b/c.txt` creates folders), cut/copy/paste/duplicate, drag & drop moves, dropping files in from your OS, Delete to trash, multi-select, type-to-find, git decorations, auto-reveal, and an Open Editors section.
- Search across files using ripgrep: regex, match case, whole word, include/exclude globs, replace with a preview diff, replace in file or replace all, and preserve case.
- Source Control: stage, unstage and discard changes, commit (smart commit, amend, commit & push), push, pull, fetch and sync, checkout/create/delete/merge branches, stash, undo last commit, a commit history list, init and clone.
- Integrated terminal: multiple terminals, shell profiles, rename, copy/paste, clickable links, Run Active File (`F5`, over 20 languages), and Run Task (auto-detects npm/yarn/pnpm scripts, Makefile, Cargo, Go, CMake, just, pytest).
- Problems panel (diagnostics) and an Output panel (git log).
- Status bar: branch, sync, error/warning counts, cursor and selection, indentation, encoding, EOL and language mode (all clickable).
- 12 color themes with live preview (`Ctrl+K Ctrl+T`): Snake Dark/Light, Dark/Light Modern, Monokai, Dracula, One Dark Pro, GitHub Dark, Nord, Solarized Dark/Light, High Contrast.
- Settings UI (`Ctrl+,`) with search, plus Settings JSON. About 90 settings.
- Keyboard Shortcuts editor (`Ctrl+K Ctrl+S`): search, record keys, rebind or remove, chords, and keybindings.json.
- Custom title bar with menus (Alt opens them), a command center, and layout toggles.
- Zen mode, full screen, zoom, a movable side bar, and togglable activity bar, status bar and panel.
- Navigation history: Go Back/Forward (`Alt+←/→`).
- Session restore per folder: open tabs, groups, side bar, panel and expanded folders.
- Welcome page with recent folders, a theme picker and shortcuts.
- Multiple windows (`Ctrl+Shift+N`) and single-instance handling.

## Project layout

```
src/main/main.js        Electron main process: windows, fs, search (ripgrep), pty, git, dialogs
src/main/preload.js     The narrow IPC bridge exposed as window.snake
src/renderer/app.js     Boot, layout, session restore, and every command registration
src/renderer/modules/   editors, explorer, search, git, panel (terminal/problems/output),
                        palette, settings, themes, keybindings, titlebar, statusbar, pages,
                        lsp (language servers: started by the main process, spoken to here)
build.mjs               esbuild bundling (app + Monaco web workers) into dist/
```

User data lives in Electron's `userData` directory (`~/.config/Snake's Code` on Linux): `settings.json`, `keybindings.json` and `state.json`.
