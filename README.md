# runwa

A cross-platform (Windows-first) command palette launcher inspired by [PowerToys Command Palette](https://learn.microsoft.com/en-us/windows/powertoys/command-palette/overview). Invoke with a global hotkey, fuzzy-search anything, extend via pluggable modules.

## Features

**Shipped (iteration 1):**

- **Window Switcher** — list and focus any open window (Win32 API on Windows, `osascript` fallback on macOS)
- **Settings UI** — per-module on/off toggles
- **Hotkey system** — global activation chord (default `Super+Alt+Space`) plus per-module direct-launch hotkeys
- **Module registry** — prefix routing, request cancellation, firewalled providers

**Roadmap:** Apps launcher · Files/folders search · Calculator · Bookmarks · Clipboard history · Time/date · System commands · Web search · Windows Services · Terminal profiles · Registry · WinGet lookup · Windows Settings pages · Dock

## Tech stack

Electron 34 · React 19 · TypeScript (strict) · Vite · Tailwind CSS v4 · Zustand · Fuse.js · Rust (napi-rs native addon)

## Getting started

```bash
npm install
npm run build:native   # compile the Rust native addon
npm run dev
```

Requires a stable Rust toolchain for the `native/` crate.

## Building

```bash
npm run dist:win    # Windows installer
npm run dist:mac    # macOS dmg
npm run dist:linux  # Linux AppImage
```

