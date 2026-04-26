import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

/**
 * Window-command driver. Three commands — maximize / minimize /
 * restore — implemented per-OS using the most stable path available
 * on each platform.
 *
 * macOS: direct Accessibility attribute set on the frontmost window
 *   - maximize: read NSScreen.mainScreen.visibleFrame (excludes menu
 *     bar + dock, accounts for notch height), set the window's
 *     `AXPosition` + `AXSize` to fill it. Works on every standard
 *     NSWindow regardless of app cooperation — no menu navigation,
 *     no green-button-click synthesis, no lazy-validation pitfalls.
 *   - minimize: `set value of attribute "AXMinimized" to true`.
 *     Read/write everywhere, no animation gap to fight.
 *   - restore: un-fullscreen or un-minimize if applicable, otherwise
 *     resize to 70% of the visible frame centred. We don't track
 *     pre-maximize frames per-window — restoring a maximized window
 *     to a sensible default is more predictable than relying on
 *     state we'd have to store across invocations.
 *
 * Windows / Linux: synthesize the OS-native window-management chords
 * via `uiohook-napi` (Win+Up / Win+Down / Alt+Space → R). The native
 * addon is optional — a missing binary degrades to a logged no-op.
 */

export type WindowCommand = 'maximize' | 'minimize' | 'restore'

interface UiohookModule {
  uIOhook: {
    keyTap(key: number, modifiers?: number[]): void
  }
  UiohookKey: Record<string, number>
}

const nodeRequire = createRequire(
  typeof __filename !== 'undefined' ? __filename : import.meta.url
)

let cached: UiohookModule | null | undefined

function loadUiohook(): UiohookModule | null {
  if (cached !== undefined) return cached
  try {
    cached = nodeRequire('uiohook-napi') as UiohookModule
  } catch {
    cached = null
  }
  return cached
}

// ─── macOS ────────────────────────────────────────────────────────────────
//
// Each script returns silently on success and logs to stderr on failure.
// Wrapping the AX work in `try` keeps borderless / chromeless windows
// (dialogs, popovers) from surfacing as osascript errors that the caller
// would mistake for a driver fault.

interface ScriptPayload {
  lang: 'AppleScript' | 'JavaScript'
  body: string
}

const MAC_SCRIPTS: Record<WindowCommand, ScriptPayload> = {
  maximize: {
    lang: 'JavaScript',
    body: `
ObjC.import("AppKit");
const SE = Application("System Events");
const proc = SE.processes.whose({frontmost: true})[0];
if (proc) {
  const wnds = proc.windows();
  if (wnds.length > 0) {
    const wnd = wnds[0];
    const scr = $.NSScreen.mainScreen;
    const fullH = scr.frame.size.height;
    const vf = scr.visibleFrame;
    // NSScreen uses bottom-left origin; AX uses top-left. Convert.
    const x = vf.origin.x;
    const y = fullH - (vf.origin.y + vf.size.height);
    const w = vf.size.width;
    const h = vf.size.height;
    try { wnd.position = [x, y]; } catch (e) {}
    try { wnd.size = [w, h]; } catch (e) {}
  }
}
`.trim()
  },
  minimize: {
    lang: 'AppleScript',
    body: `
tell application "System Events"
  set frontProc to first process whose frontmost is true
  if (count of windows of frontProc) > 0 then
    try
      set value of attribute "AXMinimized" of front window of frontProc to true
    end try
  end if
end tell`.trim()
  },
  restore: {
    lang: 'JavaScript',
    body: `
ObjC.import("AppKit");
const SE = Application("System Events");
const proc = SE.processes.whose({frontmost: true})[0];
if (proc) {
  const wnds = proc.windows();
  if (wnds.length > 0) {
    const wnd = wnds[0];
    let handled = false;
    // 1. Un-fullscreen if currently fullscreen.
    try {
      if (wnd.attributes.byName("AXFullScreen").value() === true) {
        wnd.attributes.byName("AXFullScreen").value = false;
        handled = true;
      }
    } catch (e) {}
    // 2. Un-minimize if currently minimized.
    if (!handled) {
      try {
        if (wnd.attributes.byName("AXMinimized").value() === true) {
          wnd.attributes.byName("AXMinimized").value = false;
          handled = true;
        }
      } catch (e) {}
    }
    // 3. Otherwise resize to a "reasonable normal" — 70% of the visible
    //    frame, centred. Predictable across apps; we don't track the
    //    pre-maximize frame per-window so this is the next-best thing.
    if (!handled) {
      const scr = $.NSScreen.mainScreen;
      const fullH = scr.frame.size.height;
      const vf = scr.visibleFrame;
      const w = Math.round(vf.size.width * 0.7);
      const h = Math.round(vf.size.height * 0.7);
      const x = Math.round(vf.origin.x + (vf.size.width - w) / 2);
      const y = Math.round(fullH - (vf.origin.y + vf.size.height) + (vf.size.height - h) / 2);
      try { wnd.position = [x, y]; } catch (e) {}
      try { wnd.size = [w, h]; } catch (e) {}
    }
  }
}
`.trim()
  }
}

function runMacWindowCommand(command: WindowCommand): boolean {
  try {
    const { lang, body } = MAC_SCRIPTS[command]
    const args = lang === 'JavaScript' ? ['-l', 'JavaScript', '-e', body] : ['-e', body]
    const proc = spawn('osascript', args, {
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    proc.stderr?.on('data', (c) => (stderr += c.toString()))
    proc.on('close', (code) => {
      const trimmed = stderr.trim()
      if (code !== 0) {
        console.warn(
          `[command-palette] osascript ${command} exited ${code}: ${trimmed}`
        )
      } else if (trimmed) {
        console.log(`[command-palette] ${command}: ${trimmed}`)
      }
    })
    proc.on('error', (err) => {
      console.warn(`[command-palette] osascript ${command} spawn failed:`, err)
    })
    return true
  } catch (err) {
    console.warn('[command-palette] runMacWindowCommand failed:', err)
    return false
  }
}

// ─── Windows / Linux ─────────────────────────────────────────────────────

interface Step {
  key: number
  modifiers?: number[]
}

function stepsFor(
  command: WindowCommand,
  K: UiohookModule['UiohookKey']
): Step[] | null {
  switch (command) {
    case 'maximize':
      return [{ key: K.ArrowUp, modifiers: [K.Meta] }]
    case 'minimize':
      return [{ key: K.ArrowDown, modifiers: [K.Meta] }]
    case 'restore':
      // Alt+Space opens the system menu, R picks "Restore". A small
      // gap between the two so the menu has time to render.
      return [
        { key: K.Space, modifiers: [K.Alt] },
        { key: K.R }
      ]
  }
}

const INTER_STEP_DELAY_MS = 60

// ─── Public entry point ──────────────────────────────────────────────────

/**
 * Run the OS action for `command`. Returns false when the platform
 * driver isn't available (uiohook missing on Windows / Linux); the
 * caller surfaces a warning. macOS always returns true synchronously
 * — `osascript` errors are async, so they're logged as they happen
 * rather than reported back here.
 */
export function simulateWindowCommand(command: WindowCommand): boolean {
  if (process.platform === 'darwin') {
    return runMacWindowCommand(command)
  }
  const mod = loadUiohook()
  if (!mod) return false
  const steps = stepsFor(command, mod.UiohookKey)
  if (!steps || steps.length === 0) return false
  try {
    const [first, ...rest] = steps
    mod.uIOhook.keyTap(first.key, first.modifiers ?? [])
    for (let i = 0; i < rest.length; i++) {
      const step = rest[i]
      setTimeout(() => {
        try {
          mod.uIOhook.keyTap(step.key, step.modifiers ?? [])
        } catch (err) {
          console.warn('[command-palette] keystroke step failed:', err)
        }
      }, INTER_STEP_DELAY_MS * (i + 1))
    }
    return true
  } catch (err) {
    console.warn('[command-palette] simulateWindowCommand failed:', err)
    return false
  }
}
