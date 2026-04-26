import type { ModuleManifest, PaletteItem } from '@shared/types'
import type { PaletteModule } from '../types'
import { paletteWindow } from '../../palette-window'
import { simulateWindowCommand, type WindowCommand } from './keystrokes'

/**
 * Command Palette — system commands exposed as palette entries. Starts
 * with three window-management commands (Maximize, Minimize, Restore)
 * that target whichever window had focus before the palette opened.
 *
 * Execution flow is different from other search modules: we actively
 * restore focus to the caller's window (via `paletteWindow.hide(true)`)
 * and then, after the OS has honoured the foreground switch, synthesise
 * the platform keystroke that performs the command. Returning
 * `dismissPalette: false` avoids the default `paletteWindow.hide()` call
 * in the IPC handler — we've already hidden with the focus-restoring
 * variant.
 *
 * Each command has its own checkbox in settings so users can hide the
 * entries they don't want cluttering the list. A disabled command also
 * declines to run if someone kept an alias or stale reference to it.
 */

interface CommandDef {
  /** Stable id used in the PaletteItem id + action payload. */
  id: string
  /** Display name in the palette + the config checkbox label. */
  title: string
  /** Lucide icon name. */
  icon: string
  /** Short help text shown under the title. */
  subtitle: string
  /** Config flag key that toggles this command on/off. */
  configKey: string
  /** Enabled by default on fresh installs. */
  defaultEnabled: boolean
  /** Abstract command the keystroke layer translates per-platform. */
  command: WindowCommand
  /** Longer description shown in the settings checkbox row. */
  configDescription: string
}

const COMMANDS: CommandDef[] = [
  {
    id: 'maximize-window',
    title: 'Maximize window',
    icon: 'maximize-2',
    subtitle: 'Expand the focused window to fill the screen.',
    configKey: 'enableMaximize',
    defaultEnabled: true,
    command: 'maximize',
    configDescription:
      'Expands the previously-focused window to fill the visible screen area (excluding menu bar and dock). Windows / Linux: Win+Up. macOS: directly sets the window position and size — no menu navigation, no green-button click, no fullscreen.'
  },
  {
    id: 'minimize-window',
    title: 'Minimize window',
    icon: 'minimize-2',
    subtitle: 'Hide the focused window to the taskbar / Dock.',
    configKey: 'enableMinimize',
    defaultEnabled: true,
    command: 'minimize',
    configDescription:
      'Hides the previously-focused window. Windows / Linux: Win+Down. macOS: sets the window\'s AXMinimized accessibility attribute.'
  },
  {
    id: 'restore-window',
    title: 'Restore window',
    icon: 'square',
    subtitle: 'Undo a maximize / fullscreen / minimize.',
    configKey: 'enableRestore',
    defaultEnabled: true,
    command: 'restore',
    configDescription:
      'Returns the previously-focused window to a normal size. Windows / Linux: drives Alt+Space → R. macOS: un-fullscreens or un-minimizes if applicable, otherwise resizes to 70% of the screen, centred.'
  }
]

const MANIFEST: ModuleManifest = {
  id: 'command-palette',
  name: 'Command Palette',
  icon: 'command',
  kind: 'search',
  description:
    'System commands you can run from the palette. Starts with window-management (Maximize, Minimize, Restore); each command is toggleable below.',
  defaultEnabled: true,
  supportsDirectLaunch: true,
  defaultDirectLaunchHotkey: 'Ctrl+Alt+P',
  // All current commands manipulate the focused window — group them under
  // a single header so users can show/hide the whole batch with one click
  // rather than ticking three checkboxes individually.
  configFields: COMMANDS.map((c) => ({
    key: c.configKey,
    type: 'checkbox' as const,
    label: c.title,
    description: c.configDescription,
    defaultValue: c.defaultEnabled,
    group: 'Windows Control'
  }))
}

interface CommandAction {
  command: WindowCommand
}

function isCommandAction(a: unknown): a is CommandAction {
  return (
    typeof a === 'object' &&
    a !== null &&
    'command' in a &&
    typeof (a as { command: unknown }).command === 'string'
  )
}

export function createCommandPaletteModule(): PaletteModule {
  return {
    manifest: MANIFEST,

    async search(query, signal, context) {
      if (signal.aborted) return []

      const trimmed = query.trim().toLowerCase()
      const items: Array<Omit<PaletteItem, 'moduleId'>> = []
      let rank = 0
      for (const c of COMMANDS) {
        const enabled = context.config[c.configKey] !== false
        if (!enabled) continue
        if (trimmed && !c.title.toLowerCase().includes(trimmed)) continue
        items.push({
          id: `cmd:${c.id}`,
          title: c.title,
          subtitle: c.subtitle,
          iconHint: c.icon,
          actionKind: 'window-command',
          action: { command: c.command } satisfies CommandAction,
          score: rank++ / 10000
        })
      }
      return items
    },

    async execute(item) {
      if (item.actionKind !== 'window-command' || !isCommandAction(item.action)) {
        console.warn('[command-palette] invalid action', item)
        return { dismissPalette: false }
      }

      // Hide with restoreFocus=true so the OS foreground window is the
      // one the user was on before the palette opened. Both the macOS
      // System Events query ("first process whose frontmost is true")
      // and the Win/Linux keystroke synthesis target whichever window
      // the OS currently considers foreground, so the handoff has to
      // settle before we run.
      paletteWindow.hide(true)

      // A short delay covers the focus handoff. ~120 ms is long enough
      // on Windows for SetForegroundWindow to settle and the target
      // window to become ready to receive a Win+Up / Win+Down chord;
      // macOS needs a touch more headroom because Electron's hide() is
      // async to the OS and `osascript` queries the frontmost process
      // at execution time — too short and we tell System Events to
      // act on our own (still-hiding) window. Too long and the user
      // notices the lag.
      const delay = process.platform === 'darwin' ? 200 : 120
      setTimeout(() => {
        const ok = simulateWindowCommand(item.action.command)
        if (!ok) {
          console.warn(
            `[command-palette] ${item.action.command} failed — driver unavailable?`
          )
        }
      }, delay)

      // We've handled the hide ourselves. Returning false short-circuits
      // the IPC handler's redundant `paletteWindow.hide()` call, which
      // would otherwise blur-grab the palette right after we restored
      // focus to the real target.
      return { dismissPalette: false }
    }
  }
}
