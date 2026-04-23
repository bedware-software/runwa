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
      'Shows "Maximize window" as a command. Expands the previously-focused window to fill the screen via the OS shortcut (Win+Up on Windows / Linux, Ctrl+Cmd+F on macOS).'
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
      'Shows "Minimize window" as a command. Hides the previously-focused window via the OS shortcut (Win+Down on Windows / Linux, Cmd+M on macOS).'
  },
  {
    id: 'restore-window',
    title: 'Restore window',
    icon: 'square',
    subtitle: 'Undo a maximize / bring the window back to normal size.',
    configKey: 'enableRestore',
    defaultEnabled: true,
    command: 'restore',
    configDescription:
      'Shows "Restore window" as a command. Drives the system menu (Alt+Space, R) to return the previously-focused window to its normal size.'
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
  configFields: COMMANDS.map((c) => ({
    key: c.configKey,
    type: 'checkbox' as const,
    label: c.title,
    description: c.configDescription,
    defaultValue: c.defaultEnabled
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
      // one the user was on before the palette opened. The keystroke we
      // fire below is a global input event — it targets whichever
      // window the OS currently considers foreground.
      paletteWindow.hide(true)

      // A short delay covers the focus handoff. Empirically ~120 ms is
      // long enough on Windows for SetForegroundWindow to settle and
      // the target window to become ready to receive a Win+Up / Win+Down
      // chord. Too short and the keystroke gets eaten by our own
      // now-hiding window; too long and the user notices the lag.
      setTimeout(() => {
        const ok = simulateWindowCommand(item.action.command)
        if (!ok) {
          console.warn(
            `[command-palette] ${item.action.command} failed — uiohook unavailable?`
          )
        }
      }, 120)

      // We've handled the hide ourselves. Returning false short-circuits
      // the IPC handler's redundant `paletteWindow.hide()` call, which
      // would otherwise blur-grab the palette right after we restored
      // focus to the real target.
      return { dismissPalette: false }
    }
  }
}
