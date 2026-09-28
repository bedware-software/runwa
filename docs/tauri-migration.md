# Electron → Tauri migration

Runwa's native layer was already Rust. The Electron shell existed to host
the React UI and a Node main process that glued the Rust addon to the OS
surface Electron provides (windows, tray, global shortcuts, updates). Tauri
provides that surface from Rust, so the main process can become Rust too,
and Node and the bundled Chromium go away.

## What "all Rust" means here

| Layer | Electron build | Tauri build |
| --- | --- | --- |
| Platform code (windows, focus, keyboard hook, virtual desktops, theme, elevation) | Rust, loaded as a napi addon | The same Rust, linked directly (`crates/runwa-core`) |
| App logic (modules, settings, palette/settings windows, tray, hotkeys, IPC) | TypeScript on Node (`src/main`) | Rust (`src-tauri`) |
| UI | React + TypeScript in bundled Chromium | The same React code in the OS webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux) |
| Runtime | Node.js + Chromium | none — one native binary |

TypeScript remains only as UI code. It runs in the webview the OS already
has; nothing of Electron comes along with it. Going further — replacing the
React UI with a Rust UI — is a separate, optional decision:

- **Rust → WASM UI in the same webview** (Leptos, Dioxus, Yew): shared
  types without a TS mirror, one language. Costs a rewrite of ~8k lines of
  working UI (plus replacements for lucide-react, dnd-kit, the Tailwind
  setup stays). The IPC contract below doesn't change, so it can happen
  screen by screen, later, or never.
- **Native Rust GUI without a webview** (Slint, iced, egui, gpui): smallest
  footprint, but everything visual is redone, and the hard parts of a
  launcher — focusless/transparent/non-activating windows, IME, text
  rendering, accessibility — become our problem instead of the webview's.
  Not recommended for this app.

## Layout

```
crates/runwa-core/   platform layer, moved from native/src — no napi, plain Rust API
native/              napi facade over runwa-core for the Electron build (temporary)
src-tauri/           the Tauri app
src/renderer/        React UI shared by both shells
  src/lib/tauri-bridge.ts   window.electronAPI implemented over Tauri IPC
  src/lib/shell.ts          which shell hosts the renderer
vite.tauri.config.ts renderer build for Tauri (port 5174, out/tauri-renderer)
Cargo.toml           workspace: runwa-core + src-tauri (native/ stays standalone)
```

The renderer talks to its host only through the `ElectronAPI` interface in
`src/shared/types.ts`. Under Tauri, `tauri-bridge.ts` implements that
interface: every method is an `invoke` of the Rust command with the same
name (`modules_search`, `settings_set_module`, …, see
`src-tauri/src/commands.rs`), every `on…` subscription a window-scoped
event listener. The React code itself is unchanged.

`native/` keeps the Electron build working during the migration. Its
generated `index.d.ts` / `index.js` are byte-identical to before the split,
and it is deleted together with Electron.

## Running the Tauri build

```bash
npm install
npm run tauri:dev      # Vite dev server on :5174 + debug build of src-tauri
npm run tauri:build    # release build + installers (NSIS / .app+.dmg / AppImage)
```

Linux additionally needs the WebKitGTK dev packages
(`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev`).

The npm scripts run the Tauri CLI through `scripts/tauri.mjs`, which puts
rustup's toolchain first on PATH, as the macOS addon release build already
does. A Homebrew `rust` install can otherwise shadow rustup, and its cargo
stops starting whenever Homebrew upgrades a library it links (`dyld: Library
not loaded: …/libllhttp.9.3.dylib`). Running `npx tauri …` directly skips
that step.

- **Quit the Electron runwa first.** Both register the same global hotkeys;
  the second one to start gets a "registration failed" warning in its log.
- **Data folder.** Release builds use the Electron folder (`%APPDATA%\Runwa`,
  `~/Library/Application Support/Runwa`, `~/.config/Runwa`) and its files
  as-is: `runwa-settings.json`, the ignore list, etc. keep their format.
  Debug builds use `Runwa Tauri Dev` next to it, seeded once with a copy of
  the Electron dev (or installed) data, so a dev instance never rewrites
  the data of the app you actually use.
- Settings of modules that aren't ported yet are kept untouched in the file.

## Status

Ported in this first step (a vertical slice through every layer):

| Electron (`src/main`) | Tauri (`src-tauri/src`) | Notes |
| --- | --- | --- |
| `settings-store.ts` | `settings.rs` | Same file, same merge rules; unknown keys survive |
| `modules/types.ts`, `registry.ts` | `modules/mod.rs` | `PaletteModule` trait, defaults seeding |
| `modules/window-switcher/*` | `modules/window_switcher.rs`, `stores.rs` | Incl. ignore list and fullscreen-bypass list |
| `fuzzy-match.ts`, Fuse.js fallback | `fuzzy.rs` | Typo fallback is edit distance instead of Fuse's bitap |
| `glob-match.ts` | `glob.rs` | No regex needed |
| `focus-context.ts` | `focus.rs` | |
| `icon-cache.ts` (part) | `icons.rs` | Window icons + exe icons (Windows), bundle `.icns` (macOS) |
| `palette-window.ts` | `palette.rs` | Focus capture/restore, foreground lock, blur grace, desktop-affinity rebuild, drag, size/position persistence |
| `settings-window.ts` | `settings_window.rs` | |
| `hotkey-manager.ts` (press) | `hotkeys.rs` | Electron accelerators translated for `global-hotkey` |
| `tray.ts` | `tray.rs` | Desktop-number icons pushed from the keyboard hook |
| `ipc/handlers.ts` (part) | `commands.rs` | Same sender checks per window |
| `index.ts` (part) | `app.rs` | Single instance → Settings, macOS accessory app, TCC prompts |
| `logging.ts` | `tauri-plugin-log` | |

Not ported yet — the bridge rejects their calls with "not available in the
Tauri build yet", and their settings panes don't render because the module
list comes from Rust:

| Module / service | Plan |
| --- | --- |
| App Search | Start Menu / `.lnk` / UWP enumeration, launcher; de-elevated launch already exists in `runwa-core` |
| Command Palette (power, keystrokes), User Commands | Straight ports; keystrokes via `runwa-core`'s synth |
| Keyboard Remap service, `hidutil`, rules view | The hook is already in `runwa-core`; port the lifecycle + YAML view |
| Hotstrings | Consume key events from `runwa-core`'s hook instead of a second global hook (`uiohook-napi`) |
| Groq transcription | `cpal` capture + `reqwest` upload instead of a hidden `MediaRecorder` window; key-up for push-to-talk |
| Auto Dark Mode | Windows path is in `runwa-core`; macOS AppleScript via `std::process::Command`; sleep/resume hooks |
| Flashcards | Straight port (parser, SRS, store) |
| Desktop Hint window | Transparent, focusless, click-through window |
| Startup integration, elevation | Run key / RUNASADMIN / scheduled task via `std::process::Command` |
| Auto-update | `tauri-plugin-updater` (signed `latest.json`); a last Electron release that hands users over |
| Wipe all data | Much simpler without Chromium's file locks |

## Known differences in the slice

- **macOS non-activating panel.** Electron built the palette as an NSPanel
  (`type: 'panel'`) so opening it never switches Spaces. Tauri has no
  built-in equivalent; the plan is `tauri-nspanel` or an objc2 class swap.
  Until then the Space "yank" the Electron build fixed can come back.
- **Opacity reveal.** Electron showed the palette at opacity 0 until fresh
  results rendered. Not ported (needs `SetLayeredWindowAttributes` /
  `NSWindow.alphaValue`); a stale frame can flash on open.
- **Settings title bar.** Native decorations on Windows/Linux (Electron drew
  a custom bar with `titleBarOverlay`); overlay title bar on macOS, where
  the React header isn't a drag region yet (`data-tauri-drag-region`).
- **Resize persistence** keys off "visible and not just resized by us"
  instead of Electron's `will-resize`.
- **Webview engines.** Windows uses WebView2, i.e. Chromium as in Electron.
  macOS uses WKWebView (Safari's engine) — the UI needs a visual pass there;
  Tailwind v4 requires Safari 16.4+.
- **Linux**: `runwa-core` has no Linux window listing (same as before), and
  WebKitGTK doesn't report Super as `metaKey` in the hotkey recorder.

## Verification done for this step

- `native/`: generated `index.d.ts` and `index.js` byte-identical before and
  after the split; a runtime probe of every export returns identical values
  and error messages; `scripts/prepare-native-release.mjs` builds and
  validates the addon.
- `cargo check` / `clippy` for `x86_64-unknown-linux-gnu`,
  `x86_64-pc-windows-msvc` and `aarch64-apple-darwin` (core, napi facade,
  Tauri app).
- Tests: `cargo test -p runwa-core` (110), `cargo test -p runwa-tauri` (32:
  settings merge rules, stores, fuzzy ranking, glob, accelerator parsing,
  icon encoding).
- The Electron bundles still build (`electron-vite build`); the Tauri bridge
  is a lazy chunk the Electron renderer never loads.
- The Tauri app was run on Linux (Xvfb + openbox): hotkey opens the
  palette, search round-trips through Rust, Tab flips the desktop filter
  and persists it, Esc hides, a second launch opens Settings, the Window
  Switcher pane adds ignore rules and clears / re-records its hotkey.
- **Not yet run on Windows or macOS hardware.** Everything Windows- and
  macOS-specific compiles for those targets but needs a manual pass there.

## Next steps

1. Run `npm run tauri:dev` on Windows and macOS; fix what the slice gets
   wrong on real desktops (focus, virtual desktops, Spaces, icons).
2. Port modules one per change, in order of risk: Keyboard Remap +
   Hotstrings (hook already in Rust), App Search, Command Palette + User
   Commands, Auto Dark Mode, Flashcards, Groq, Desktop Hint.
3. Startup / elevation, auto-update, packaging and CI (`tauri-action`),
   signing keys for the updater.
4. Hand existing installs over (same data folder, a bridging release), then
   delete Electron: `electron*`, `src/main`, `src/preload`, `native/`,
   `uiohook-napi`, `electron-store`.
