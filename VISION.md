# Snake's Master Suite: the vision

> **Your own software, on every device you own.**
> One family of apps that replaces the everyday stack (Office, Photoshop, VLC, VS Code,
> iTerm, Audacity, OBS, WinRAR) with programs that look alike, work alike, run on Linux,
> Windows, macOS, Android, iPhone and the web, keep your files on your machines, and
> grow by turning ideas into code.

Written 2026-10-20 after a review of everything in `Projects/`. `MASTER_PLAN.md` is what
exists; this file is where it goes. Three versions follow: **Economical** (what it costs to
keep going as now), **Mid-tier** (worked out in full: the one to build), and
**Money-no-object** (the ceiling, so the middle is aimed right).

---

## 1. Where it stands

**Built:** a hub that installs and updates 17 apps from a signed index; seven document and
media apps on one hardened runtime (Word, Spreadsheets, Slides, Paint, Photo, Player,
Movie Maker); Code, Terminal, Compressor, Converter, MP3 Converter, SoundPad, DAW, Screen
Recorder, Recompiler; Android builds of nearly all; an iOS shell; and a website that runs
most of them in the browser. One theme, one icon family, one set of ergonomics (hover
zoom, wheel-adjusts-values, right-click everywhere, command palette, pinch).

That is already more than most single-person suites ever reach. What holds it back is
not features; it is **trust, reach and glue**:

| Gap | Why it matters |
|---|---|
| Unsigned on Windows and macOS; never opened on a real Windows PC or Mac | SmartScreen and Gatekeeper scare people off; untested platforms break quietly |
| iOS never compiled; Android never run on a phone | "Runs everywhere" is a claim, not a fact, until it is |
| Apps don't know about each other | No "send this to my phone", no shared settings, no opening a Sheets chart in Slides |

Fixed in v1.4.0 (2026-10-20): Code and Terminal no longer carry their own Electron (one
runtime for all nine web-stack apps on the desktop), and the shortcuts in `Projects/` point
at the Master Suite instead of the old suite.

## 2. What makes it *Snake's*

Five principles every version keeps. When an idea conflicts with one, the principle wins.

1. **One family.** Same theme, icons, shortcuts, menus, palette and gestures in every app.
   Learn one, know them all.
2. **Everywhere.** Every app on desktop, phone and web, or a clear reason it can't be
   (Terminal on iPhone has no shell; the Recompiler needs Unix).
3. **Yours.** Files stay on your devices. No account needed, no telemetry, no
   subscription. Updates are signed. Formats are the standard ones (.docx, .xlsx, .psd, .mp4).
4. **Your devices are one system.** Anything on one device can reach the others: a file, a
   setting, a terminal, a clipboard.
5. **Built by idea.** Ideas flow in from wherever you are (`IDEAS.md`, the `idea` command,
   a GitHub issue from the phone) and come back as working code.

---

## 3. Economical: keep going for about $15 a year

Everything stays free-tier: GitHub Actions builds, GitHub Releases hosts, GitHub Pages
serves the website, apps stay unsigned with the "Run anyway" instructions.

| Do | Cost |
|---|---|
| Keep shipping with `ship.py` | $0 |
| Sync by folder: each app can keep its settings in a folder you choose (Syncthing, Nextcloud, Dropbox, a USB stick), so devices share settings with no server | $0 |
| Snake's Terminal on Windows and macOS through a friend's machine or a free CI runner smoke test (start it, take a screenshot, quit) | $0 |
| Three small new apps on the Studio runtime: **Notes** (Markdown, links, Obsidian-style vault), **PDF** (view, sign, merge, fill forms), **Files** (a file manager with previews from every Snake app) | $0 |
| A domain for the website | ~$12/yr |

**What you get:** the suite keeps growing at today's pace. **What you don't:** trust on
Windows and macOS, iPhone installs, anything that needs a server.

---

## 4. Mid-tier: the one to build

**Budget:** about **$250 the first year, then ~$15/month**, because the expensive part (a
server) is already planned in *Snake's Topography*: the homelab's Proxmox host and its
$5/month VPS front door. The suite's cloud runs on hardware you own.

### 4.1 The shape

```
                      ┌──────────────── your devices ─────────────────┐
  Linux / Windows /   │  Snake's Master Suite hub  (launcher, updates, │
  macOS desktop       │  Snake Drop, settings sync, idea box)          │
                      │   └─ Snake Runtime: ONE Electron for Studio,   │
                      │      Code, Terminal (+ Notes, PDF, Files)      │
                      │   └─ native tools: Compressor, DAW (Rust),     │
                      │      Converter, MP3, SoundPad, Screen (Qt)     │
  Android / iPhone    │  the same pages in a native shell              │
  Any browser         │  the website                                   │
                      └───────────────┬────────────────────────────────┘
                                      │ end-to-end encrypted
                    ┌─────────────────▼─────────────────┐
                    │ VPS ($5/mo): Caddy + WireGuard     │  the only public address
                    └─────────────────┬─────────────────┘
                                      │ WireGuard tunnel
                    ┌─────────────────▼─────────────────┐
                    │ Homelab (Proxmox): "snake-cloud"   │
                    │  sync relay · device directory ·   │
                    │  update mirror · crash reports ·   │
                    │  local AI (Ollama, main PC GPU)    │
                    └────────────────────────────────────┘
```

The server never sees content: devices encrypt with keys only they hold. If the homelab is
off, everything still works locally; sync catches up later.

### 4.2 The pieces

**A. Trust: signed and tested everywhere (the first thing to do)**

| Item | What | Cost |
|---|---|---|
| Apple Developer Program | Notarized macOS builds (no right-click → Open), TestFlight for the iPhone app | $99/yr |
| Windows signing | Azure Trusted Signing (or an OV certificate) in the release workflow; SmartScreen warnings fade as reputation builds | ~$10/mo |
| Google Play | The Android hub and apps listed, alongside the APKs on GitHub | $25 once |
| A used Mac mini (M1) | A real Mac for testing and for iOS builds without waiting on CI | ~$300 used, optional |
| Test matrix in CI | Every app started headless on every system per release, driven over CDP: open, act, screenshot, compare (the harness used for Terminal 1.1.0, made permanent) | $0 |

**B. One runtime** *(the packaging half is done in v1.4.0)*

Snake's Code and Snake's Terminal ship inside the Studio package on the desktop, so one
Electron serves every web-stack app: one download, one security surface, one update. Each
app keeps its own name, icon, window, settings and menu entry. What remains: the shared kit
grows into **Snake Kit**: menus (Terminal's new cascading menus
and menu bar become the standard), dialogs, palette, settings pages, the clipboard rules.

**C. Snake Cloud (on the homelab)**

| Service | What it does for you |
|---|---|
| **Settings sync** | Themes, profiles, Terminal hosts, keyboard shortcuts, recent files list, follow you to every device |
| **Snake Drop** | Send a file, a link or the clipboard to another of your devices from any app's Share menu or the hub. Works on the LAN directly, through the VPS when away |
| **Device directory** | Every device you own, online or not, with how to reach it: Terminal's Devices panel stops depending on mDNS and network scans |
| **Handoff** | "Continue on phone": the doc you have open on the desktop opens at the same place on the phone |
| **Update mirror** | The signed index and packages served from home: faster on the LAN, still verified with the same key |
| **Crash reports** | Opt-in, self-hosted (GlitchTip): you see real errors from real machines, nobody else does |

Built as one small service (Rust or Go, SQLite, ~2k lines) in a Proxmox container. Pairing
a device is a QR code or a six-word phrase. Protocol: devices hold an identity key; content
is encrypted per device group; the server stores ciphertext and routes.

**D. Ask Snake: local AI, opt-in**

Topography already plans a consent-gated local AI on the main PC. The suite uses it:
an *Ask* panel in every app (Ctrl+Shift+A) that talks to Ollama on your own GPU over the
LAN or the tunnel. Off by default, never sends anything outside your network.

| App | What Ask does |
|---|---|
| Word / Notes | Rewrite, summarise, fix grammar, draft from an outline |
| Spreadsheets | "Make a formula that…", explain a formula, clean a column |
| Terminal | Explain an error, turn "find big files from last week" into a command (shown, never run by itself) |
| Code | Completions and chat from a local coder model |
| Photo / Paint | Remove background, upscale, generative fill (a local diffusion model) |
| Player / Movie | Subtitles from speech (Whisper), chapter detection |
| Converter / MP3 | Tag music by listening |

**E. New apps (all on the one runtime, all on the phone and the web)**

| App | Replaces | Notes |
|---|---|---|
| **Snake's Notes** | Obsidian, Notion (personal) | Markdown vault, backlinks, graph, sync via Snake Cloud. Bad Santa's vault experiment shows it's wanted |
| **Snake's PDF** | Acrobat | View, annotate, sign, fill forms, merge, split, compress, OCR |
| **Snake's Files** | Finder / Explorer extras | Previews from every Snake app, Snake Drop target, `.snake` archives inline |
| **Snake's Mail** *(late)* | Thunderbird | IMAP/SMTP, unified inbox, the suite's look |

**F. The idea pipeline, automated**

Today: `idea` command, `IDEAS.md`, `/ideas`. Mid-tier adds:
- An **Idea box** in the hub and in every app's Help menu ("Suggest a change to this
  app"), which writes to the inbox with the app already tagged and a screenshot attached.
- A nightly scheduled Claude routine that pulls phone ideas (GitHub issues), triages them
  and leaves a short morning report: what was built on a branch, what needs your answer.

### 4.3 The order

| Phase | Weeks | Delivers | Done when |
|---|---|---|---|
| 0. Ship | 1 | ✅ v1.4.0 released with one Electron; shortcuts fixed; snapshot taken. Left: the idea label on GitHub | Done 2026-10-20 |
| 1. Trust | 2–4 | Signed Windows and macOS builds; TestFlight iPhone app; Play listing; CI test matrix | A fresh Windows PC and Mac install with no warnings; every app passes its start test on 5 systems |
| 2. One runtime | 2–4 | ✅ Code and Terminal on the Studio runtime (v1.4.0). Left: Snake Kit menus everywhere | The menus of Terminal 1.2.0 in every web-stack app |
| 3. Snake Cloud | 4–6 | Settings sync, device directory, Snake Drop | Change a theme on the PC, see it on the phone; drop a photo from phone to desktop |
| 4. New apps | 6–8 | Notes, PDF, Files | Each on desktop, phone, web; listed in the hub |
| 5. Ask Snake | 3–4 | Ask panel in Word, Sheets, Terminal, Code; Whisper subtitles in Player | Works with the main PC on, says so plainly when it's off |
| 6. Handoff + idea box | 2–3 | Continue on phone; idea box in every app; nightly routine | An idea typed on the phone at night has a branch by morning |

About six months of steady work. Each phase ships on its own.

### 4.4 What it costs

| | First year | After |
|---|---|---|
| Apple Developer | $99 | $99/yr |
| Windows signing | ~$120 | ~$120/yr |
| Google Play | $25 | – |
| Domain | ~$12 | ~$12/yr |
| VPS (shared with the homelab plan) | $60 | $60/yr |
| Used Mac mini (optional) | ~$300 | – |
| **Total** | **~$316, or ~$616 with the Mac** | **~$290/yr** |

---

## 5. Money-no-object: the ceiling

What it becomes with a team and a budget. Not a plan; a compass.

- **People.** A designer for the Snake look and the icons; QA with a device lab (Macs,
  Windows laptops, iPhones, iPads, a dozen Androids, a Chromebook); a security firm for a
  yearly audit and pen-test.
- **Real-time collaboration.** Word, Sheets and Slides edited by several people at once
  (CRDTs: Yjs or Automerge), comments and presence, through Snake Cloud or peer to peer.
- **Snake Cloud as a service** for people without a homelab: a global, end-to-end encrypted
  sync service, priced at cost, with the self-hosted version still free.
- **Every store.** Microsoft Store, Mac App Store, App Store, Play, Flathub, Snap, winget,
  Homebrew, F-Droid, all from one release pipeline.
- **Native where it matters.** A native iPhone/iPad Terminal with its own SSH client;
  Metal/Vulkan rendering for Photo and Movie Maker; a native DAW plugin host (VST3/CLAP).
- **AI at full strength.** A GPU server in the rack (or rented) running larger local models;
  Ask Snake across apps with shared context ("make slides from this document and these
  charts"), still private.
- **Everyone can use it.** Screen-reader support audited in every app, full keyboard
  operation, 20+ languages, right-to-left layouts.
- **Snake OS.** A Linux image (Fedora or Arch based) with the suite as the desktop's own
  apps, the Snake theme system-wide, and Snake Cloud set up on first boot. A phone launcher
  for Android in the same spirit.
- **Snake's Games.** Bad Santa and what follows, installed and updated through the same hub.

---

## 6. How ideas become this

Every line in sections 3–5 can enter through the pipeline as an idea (`idea "[suite] snake
drop"`), get sized by `/ideas`, and either be built or get a spec in `MASTER_PLAN.md`.
When a phase above is finished, mark it here and in `MASTER_PLAN.md`'s Status.
