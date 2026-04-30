import type { ModuleManifest, PaletteItem } from '@shared/types'
import type { PaletteModule } from '../types'
import { paletteWindow } from '../../palette-window'
import { settingsWindow } from '../../settings-window'
import { simulateWindowCommand, type WindowCommand } from './keystrokes'

/**
 * Command Palette — system commands exposed as palette entries. Ships
 * window-management commands (Maximize, Minimize, Restore) plus a
 * built-in "Open Settings" entry under the Settings group.
 *
 * Execution flow is different from other search modules: for the
 * keystroke-driven window commands we actively restore focus to the
 * caller's window (via `paletteWindow.hide(true)`) and then, after the
 * OS has honoured the foreground switch, synthesise the platform
 * keystroke that performs the command. Returning `dismissPalette: false`
 * avoids the default `paletteWindow.hide()` call in the IPC handler —
 * we've already hidden with the focus-restoring variant.
 *
 * Each command has its own checkbox in settings so users can hide the
 * entries they don't want cluttering the list. The "Open Settings"
 * entry is locked on (its `readOnly` checkbox can't be toggled) so the
 * built-in route to settings is always available.
 */

type CommandKind =
  | { kind: 'window'; command: WindowCommand }
  | { kind: 'open-settings' }

interface CommandDef {
  /** Stable id used in the PaletteItem id + action payload. */
  id: string
  /** Display name in the palette + the config checkbox label. */
  title: string
  /** Lucide icon name. */
  icon: string
  /** Short help text shown under the title. */
  subtitle: string
  /** Settings-UI grouping label rendered as both a settings header and
   * a palette section header. */
  group: string
  /** Config flag key that toggles this command on/off. */
  configKey: string
  /** Enabled by default on fresh installs. */
  defaultEnabled: boolean
  /** Lock the settings checkbox so the user can't disable the command —
   * used for built-ins the module ships and depends on (Open Settings). */
  readOnly?: boolean
  /** Default per-item alias seeded into the user's settings on first
   * registration (so a fresh install already has, e.g., "," → Settings). */
  defaultAlias?: string
  /** What the command actually does on execute. */
  action: CommandKind
  /** Longer description shown in the settings checkbox row. */
  configDescription: string
}

const COMMANDS: CommandDef[] = [
  {
    id: 'open-settings',
    title: 'Open Settings',
    icon: 'settings',
    subtitle: 'Open the runwa settings window.',
    group: 'Settings',
    configKey: 'enableOpenSettings',
    defaultEnabled: true,
    readOnly: true,
    defaultAlias: ',',
    action: { kind: 'open-settings' },
    configDescription:
      'Always available. Type the alias (default ",") and press Enter — or just type "," to launch on match — to open settings without leaving the keyboard.'
  },
  {
    id: 'maximize-window',
    title: 'Maximize window',
    icon: 'maximize-2',
    subtitle: 'Expand the focused window to fill the screen.',
    group: 'Windows Control',
    configKey: 'enableMaximize',
    defaultEnabled: true,
    action: { kind: 'window', command: 'maximize' },
    configDescription:
      'Expands the previously-focused window to fill the visible screen area (excluding menu bar and dock). Windows / Linux: Win+Up. macOS: directly sets the window position and size — no menu navigation, no green-button click, no fullscreen.'
  },
  {
    id: 'minimize-window',
    title: 'Minimize window',
    icon: 'minimize-2',
    subtitle: 'Hide the focused window to the taskbar / Dock.',
    group: 'Windows Control',
    configKey: 'enableMinimize',
    defaultEnabled: true,
    action: { kind: 'window', command: 'minimize' },
    configDescription:
      'Hides the previously-focused window. Windows / Linux: Win+Down. macOS: sets the window\'s AXMinimized accessibility attribute.'
  },
  {
    id: 'restore-window',
    title: 'Restore window',
    icon: 'square',
    subtitle: 'Undo a maximize / fullscreen / minimize.',
    group: 'Windows Control',
    configKey: 'enableRestore',
    defaultEnabled: true,
    action: { kind: 'window', command: 'restore' },
    configDescription:
      'Returns the previously-focused window to a normal size. Windows / Linux: drives Alt+Space → R. macOS: un-fullscreens or un-minimizes if applicable, otherwise resizes to 70% of the screen, centred.'
  }
]

/**
 * Default aliases shipped with the module. Keyed by the same stable id
 * the search builder stamps onto each PaletteItem (`cmd:<id>`) so the
 * registry can drop them straight into the per-module aliases map.
 */
const DEFAULT_ALIASES: Record<string, string> = (() => {
  const out: Record<string, string> = {}
  for (const c of COMMANDS) {
    if (c.defaultAlias) out[`cmd:${c.id}`] = c.defaultAlias
  }
  return out
})()

const MANIFEST: ModuleManifest = {
  id: 'command-palette',
  name: 'Command Palette',
  icon: 'command',
  kind: 'search',
  description:
    'System commands you can run from the palette. Ships an "Open Settings" entry plus window-management commands (Maximize, Minimize, Restore); each command is toggleable below except the built-in Settings entry.',
  defaultEnabled: true,
  supportsDirectLaunch: true,
  defaultDirectLaunchHotkey: 'Ctrl+Alt+P',
  configFields: COMMANDS.map((c) => ({
    key: c.configKey,
    type: 'checkbox' as const,
    label: c.title,
    description: c.configDescription,
    defaultValue: c.defaultEnabled,
    group: c.group,
    ...(c.readOnly ? { readOnly: true } : {})
  })),
  defaultAliases: DEFAULT_ALIASES
}

interface WindowCommandAction {
  kind: 'window'
  command: WindowCommand
}

interface OpenSettingsAction {
  kind: 'open-settings'
}

type ActionPayload = WindowCommandAction | OpenSettingsAction

function isActionPayload(a: unknown): a is ActionPayload {
  if (typeof a !== 'object' || a === null) return false
  const k = (a as { kind?: unknown }).kind
  if (k === 'window') {
    return typeof (a as { command?: unknown }).command === 'string'
  }
  return k === 'open-settings'
}

export function createCommandPaletteModule(): PaletteModule {
  return {
    manifest: MANIFEST,

    async search(query, signal, context) {
      if (signal.aborted) return []

      const trimmed = query.trim()
      const normalisedQuery = trimmed.toLowerCase()
      const aliases = context.aliases ?? {}

      // Walk the command list once, building two parallel things:
      //  - the visible item list (filtered by enabled + query substring)
      //  - the alias-match check, so a typed alias short-circuits even
      //    when its title wouldn't match the query
      const items: Array<Omit<PaletteItem, 'moduleId'>> = []
      let aliasMatch: { c: CommandDef; alias: string } | undefined
      let rank = 0
      for (const c of COMMANDS) {
        // readOnly entries always run regardless of stored config — the
        // settings UI hides the toggle so this guards against a hand-edited
        // settings.json zero-ing the flag.
        const enabled =
          c.readOnly === true || context.config[c.configKey] !== false
        if (!enabled) continue

        const itemId = `cmd:${c.id}`
        const alias = aliases[itemId]

        // Exact alias match wins outright — see the autoExecute return
        // below. We still build the regular item so it lands in the
        // result list with its alias chip; the autoExecute flag on the
        // matching row tells the renderer to fire it without an Enter.
        if (alias && alias === normalisedQuery && aliasMatch === undefined) {
          aliasMatch = { c, alias }
        }

        if (trimmed && !c.title.toLowerCase().includes(normalisedQuery)) {
          // The title doesn't match the query — but a typed alias will
          // still surface this command via the autoExecute path below.
          // Skip the regular row so the user only sees title-matches.
          continue
        }
        items.push({
          id: itemId,
          title: c.title,
          subtitle: c.subtitle,
          iconHint: c.icon,
          alias,
          group: c.group,
          actionKind:
            c.action.kind === 'open-settings' ? 'open-settings' : 'window-command',
          action:
            c.action.kind === 'open-settings'
              ? ({ kind: 'open-settings' } satisfies OpenSettingsAction)
              : ({
                  kind: 'window',
                  command: c.action.command
                } satisfies WindowCommandAction),
          score: rank++ / 10000
        })
      }

      // Alias short-circuit: typing the exact alias ("," → Open Settings)
      // returns just the matching row with autoExecute, mirroring
      // app-search's launch-on-alias mode. The user never sees the rest
      // of the result list flicker past — feels like a hotkey.
      if (aliasMatch) {
        const { c, alias } = aliasMatch
        return [
          {
            id: `cmd:${c.id}`,
            title: c.title,
            subtitle: c.subtitle,
            iconHint: c.icon,
            alias,
            group: c.group,
            autoExecute: true,
            actionKind:
              c.action.kind === 'open-settings'
                ? 'open-settings'
                : 'window-command',
            action:
              c.action.kind === 'open-settings'
                ? ({ kind: 'open-settings' } satisfies OpenSettingsAction)
                : ({
                    kind: 'window',
                    command: c.action.command
                  } satisfies WindowCommandAction),
            score: -1
          }
        ]
      }

      return items
    },

    async execute(item) {
      if (!isActionPayload(item.action)) {
        console.warn('[command-palette] invalid action', item)
        return { dismissPalette: false }
      }

      if (item.action.kind === 'open-settings') {
        // Open Settings: hide the palette without restoring focus to the
        // previous window — settings is what should land in front.
        paletteWindow.hide()
        settingsWindow.open()
        return { dismissPalette: false }
      }

      // Window command — hide with restoreFocus=true so the OS
      // foreground window is the one the user was on before the palette
      // opened. Both the macOS System Events query ("first process whose
      // frontmost is true") and the Win/Linux keystroke synthesis
      // target whichever window the OS currently considers foreground,
      // so the handoff has to settle before we run.
      paletteWindow.hide(true)

      // A short delay covers the focus handoff. ~120 ms is long enough
      // on Windows for SetForegroundWindow to settle and the target
      // window to become ready to receive a Win+Up / Win+Down chord;
      // macOS needs a touch more headroom because Electron's hide() is
      // async to the OS and `osascript` queries the frontmost process
      // at execution time — too short and we tell System Events to act
      // on our own (still-hiding) window. Too long and the user
      // notices the lag.
      const delay = process.platform === 'darwin' ? 200 : 120
      const command = item.action.command
      setTimeout(() => {
        const ok = simulateWindowCommand(command)
        if (!ok) {
          console.warn(
            `[command-palette] ${command} failed — driver unavailable?`
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
