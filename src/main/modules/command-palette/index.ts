import type { ModuleId, ModuleManifest, PaletteItem, SettingsTabId } from '@shared/types'
import type { PaletteModule } from '../types'
import { paletteWindow } from '../../palette-window'
import { settingsWindow } from '../../settings-window'
import { settingsStore } from '../../settings-store'
import { simulateWindowCommand, type WindowCommand } from './keystrokes'
import { executeUserCommand } from '../user-commands/executor'
import { userCommandsStore } from '../user-commands/store'
import { autoDarkModeService } from '../auto-dark-mode/service'
import { AUTO_DARK_MODE_ID } from '@shared/auto-dark-mode'

/**
 * Command Palette — system and user-defined commands exposed as palette
 * entries. Ships window-management commands (Maximize, Minimize, Restore),
 * a built-in
 * "Open Settings" entry under the Settings group, and one
 * "Open <Module> Settings" deep-link per registered module under the
 * "Module Settings" group.
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
  | { kind: 'open-settings'; tab?: SettingsTabId }
  | { kind: 'auto-dark-mode'; command: 'schedule' | 'toggle' }

/**
 * Identity of a module the Command Palette will surface as a deep-link
 * "Open <Module> Settings" entry. Caller passes the list at registration
 * time (from the other registered manifests); the factory generates one
 * command per entry and prepends a self entry for the Command Palette
 * itself.
 */
export interface ModuleSettingsTarget {
  id: ModuleId
  name: string
  icon: string
}

const MODULE_ID = 'command-palette'
const MODULE_NAME = 'Command Palette'
const MODULE_ICON = 'command'

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
  /** Hide and reject this command unless the owning module is enabled. */
  requiresModuleId?: ModuleId
  /** Longer description shown in the settings checkbox row. */
  configDescription: string
}

const STATIC_COMMANDS: CommandDef[] = [
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
    id: 'open-about',
    title: 'About runwa',
    icon: 'info',
    subtitle: 'App version, settings folder, and updates.',
    group: 'Settings',
    configKey: 'enableOpenAbout',
    defaultEnabled: true,
    action: { kind: 'open-settings', tab: 'about' },
    configDescription:
      'Open the About tab — shows the app version, the settings-data folder, and the manual update check.'
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
  },
  {
    id: 'themes-on-schedule',
    title: 'Themes on Schedule',
    icon: 'clock',
    subtitle: 'Resume automatic light and dark theme changes.',
    group: 'Themes',
    configKey: 'enableThemesOnSchedule',
    defaultEnabled: true,
    action: { kind: 'auto-dark-mode', command: 'schedule' },
    requiresModuleId: AUTO_DARK_MODE_ID,
    configDescription:
      'Switch Auto Dark Mode to Scheduled and immediately apply the theme for the current local-time interval.'
  },
  {
    id: 'toggle-theme',
    title: 'Toggle Theme',
    icon: 'sun-moon',
    subtitle: 'Switch between the light and dark system themes.',
    group: 'Themes',
    configKey: 'enableToggleTheme',
    defaultEnabled: true,
    action: { kind: 'auto-dark-mode', command: 'toggle' },
    requiresModuleId: AUTO_DARK_MODE_ID,
    configDescription:
      'Switch the system appearance and enter Manual mode so the schedule does not immediately undo the change.'
  }
]

interface WindowCommandAction {
  kind: 'window'
  command: WindowCommand
}

interface OpenSettingsAction {
  kind: 'open-settings'
  tab?: SettingsTabId
}

interface UserCommandAction {
  kind: 'user-command'
  commandId: string
}

interface AutoDarkModeAction {
  kind: 'auto-dark-mode'
  command: 'schedule' | 'toggle'
}

type ActionPayload =
  | WindowCommandAction
  | OpenSettingsAction
  | UserCommandAction
  | AutoDarkModeAction

function isActionPayload(a: unknown): a is ActionPayload {
  if (typeof a !== 'object' || a === null) return false
  const k = (a as { kind?: unknown }).kind
  if (k === 'window') {
    return typeof (a as { command?: unknown }).command === 'string'
  }
  if (k === 'open-settings') {
    const tab = (a as { tab?: unknown }).tab
    return tab === undefined || typeof tab === 'string'
  }
  if (k === 'user-command') {
    return typeof (a as { commandId?: unknown }).commandId === 'string'
  }
  if (k === 'auto-dark-mode') {
    const command = (a as { command?: unknown }).command
    return command === 'schedule' || command === 'toggle'
  }
  return false
}

function userCommandsEnabled(): boolean {
  return settingsStore.get().modules['user-commands']?.enabled ?? true
}

function requiredModuleEnabled(moduleId: ModuleId | undefined): boolean {
  if (!moduleId) return true
  if (
    moduleId === AUTO_DARK_MODE_ID &&
    process.platform !== 'win32' &&
    process.platform !== 'darwin'
  ) {
    return false
  }
  return settingsStore.get().modules[moduleId]?.enabled ?? true
}

function actionKindFor(action: CommandKind): string {
  if (action.kind === 'open-settings') return 'open-settings'
  if (action.kind === 'auto-dark-mode') return 'auto-dark-mode'
  return 'window-command'
}

function actionPayloadFor(action: CommandKind): ActionPayload {
  if (action.kind === 'open-settings') {
    return {
      kind: 'open-settings',
      ...(action.tab ? { tab: action.tab } : {})
    } satisfies OpenSettingsAction
  }
  if (action.kind === 'auto-dark-mode') {
    return {
      kind: 'auto-dark-mode',
      command: action.command
    } satisfies AutoDarkModeAction
  }
  return {
    kind: 'window',
    command: action.command
  } satisfies WindowCommandAction
}

export function createCommandPaletteModule(
  otherModules: readonly ModuleSettingsTarget[] = []
): PaletteModule {
  // Build the per-module settings deep-link commands. Self is prepended
  // so "Open Command Palette Settings" sits alongside the other modules;
  // filtering any duplicate keeps the caller from accidentally injecting
  // it twice when iterating over the full registry.
  const settingsTargets: ModuleSettingsTarget[] = [
    { id: MODULE_ID, name: MODULE_NAME, icon: MODULE_ICON },
    ...otherModules.filter((m) => m.id !== MODULE_ID)
  ]

  const dynamicCommands: CommandDef[] = settingsTargets.map((m) => ({
    id: `open-settings-${m.id}`,
    title: `Open ${m.name} Settings`,
    icon: m.icon,
    subtitle: `Jump straight to the ${m.name} settings tab.`,
    group: 'Module Settings',
    configKey: `enableOpenSettings_${m.id}`,
    defaultEnabled: true,
    action: { kind: 'open-settings', tab: `module:${m.id}` as SettingsTabId },
    configDescription: `Open the settings window deep-linked to the ${m.name} tab.`
  }))

  const COMMANDS: CommandDef[] = [...STATIC_COMMANDS, ...dynamicCommands]

  const commandIsEnabledNow = (command: CommandDef): boolean => {
    const moduleSettings = settingsStore.get().modules[MODULE_ID]
    if (!(moduleSettings?.enabled ?? true)) return false
    if (!requiredModuleEnabled(command.requiresModuleId)) return false
    return (
      command.readOnly === true ||
      moduleSettings?.config?.[command.configKey] !== false
    )
  }

  // Default aliases shipped with the module. Keyed by the same stable id
  // the search builder stamps onto each PaletteItem (`cmd:<id>`) so the
  // registry can drop them straight into the per-module aliases map.
  const DEFAULT_ALIASES: Record<string, string> = {}
  for (const c of COMMANDS) {
    if (c.defaultAlias) DEFAULT_ALIASES[`cmd:${c.id}`] = c.defaultAlias
  }

  const MANIFEST: ModuleManifest = {
    id: MODULE_ID,
    name: MODULE_NAME,
    icon: MODULE_ICON,
    kind: 'search',
    description:
      'System and user-defined commands you can run from the palette. Ships an "Open Settings" entry, window-management commands (Maximize, Minimize, Restore), and a deep-link "Open <Module> Settings" entry for every registered module. User-created entries are managed in User Commands under Other.',
    defaultEnabled: true,
    supportsDirectLaunch: true,
    defaultDirectLaunchHotkey: 'Ctrl+Alt+Super+P',
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

      const appendUserCommands = (): void => {
        if (!userCommandsEnabled()) return
        for (const command of userCommandsStore.list()) {
          if (trimmed && !command.name.toLowerCase().includes(normalisedQuery)) {
            continue
          }
          items.push({
            id: `user-command:${command.id}`,
            title: command.name,
            // Do not send saved shell text to the palette renderer: actions
            // may contain tokens and Settings is the authorized detail view.
            subtitle: 'Runs in background',
            iconHint: 'terminal',
            group: 'User Commands',
            actionKind: 'user-command',
            action: {
              kind: 'user-command',
              commandId: command.id
            } satisfies UserCommandAction,
            score: rank++ / 10000
          })
        }
      }

      for (let commandIndex = 0; commandIndex < COMMANDS.length; commandIndex++) {
        // Keep user-authored entries above the long generated list of module
        // settings links, while preserving the concise built-in Settings and
        // Windows Control groups at the top.
        if (commandIndex === STATIC_COMMANDS.length) appendUserCommands()
        const c = COMMANDS[commandIndex]
        if (!requiredModuleEnabled(c.requiresModuleId)) continue
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
          actionKind: actionKindFor(c.action),
          action: actionPayloadFor(c.action),
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
            actionKind: actionKindFor(c.action),
            action: actionPayloadFor(c.action),
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

      if (item.action.kind === 'user-command') {
        if (item.actionKind !== 'user-command' || !userCommandsEnabled()) {
          return { dismissPalette: false }
        }
        return {
          dismissPalette: await executeUserCommand(item.action.commandId)
        }
      }

      if (item.action.kind === 'open-settings') {
        // Open Settings: hide the palette without restoring focus to the
        // previous window — settings is what should land in front. The
        // optional `tab` deep-links into a specific module's panel for the
        // dynamic "Open <Module> Settings" entries.
        paletteWindow.hide()
        settingsWindow.open(item.action.tab)
        return { dismissPalette: false }
      }

      if (item.action.kind === 'auto-dark-mode') {
        const command = COMMANDS.find(
          (candidate) => `cmd:${candidate.id}` === item.id
        )
        if (
          item.moduleId !== MODULE_ID ||
          item.actionKind !== 'auto-dark-mode' ||
          !command ||
          command.action.kind !== 'auto-dark-mode' ||
          command.action.command !== item.action.command ||
          !commandIsEnabledNow(command)
        ) {
          return { dismissPalette: false }
        }

        // Restore the previous app before the OS appearance animation and
        // Desktop Hint begin. The hint itself is focusless/click-through.
        paletteWindow.hide(true)
        try {
          if (item.action.command === 'schedule') {
            await autoDarkModeService.enableScheduledMode()
          } else {
            await autoDarkModeService.toggleTheme()
          }
        } catch (error) {
          // The service already logged the detailed platform error and showed
          // a concise failure Desktop Hint. Keep the palette dismissed.
          console.warn('[command-palette] Auto Dark Mode command failed:', error)
        }
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
