import type {
  ModuleConfigField,
  ModuleConfigValue,
  ModuleId,
  ModuleManifest,
  PaletteItem,
  PaletteItemConfirm,
  SettingsTabId,
  UserCommandDraftPayload
} from '@shared/types'
import type { PaletteModule } from '../types'
import { paletteWindow } from '../../palette-window'
import { settingsWindow } from '../../settings-window'
import { settingsStore } from '../../settings-store'
import { simulateWindowCommand, type WindowCommand } from './keystrokes'
import {
  powerCommandSupported,
  reopenWindowsSupported,
  runPowerCommand,
  type PowerCommand
} from './power'
import {
  executeUserCommand,
  sendUserCommandKeystroke
} from '../user-commands/executor'
import { formatKeystrokeAction } from '../user-commands/keystroke'
import {
  appScopeLabel,
  commandMatchesFocus,
  commandsInScope
} from '../user-commands/scope'
import { userCommandsStore } from '../user-commands/store'
import { autoDarkModeService } from '../auto-dark-mode/service'
import { KEYBOARD_REMAP_ID } from '@shared/keyboard-remap'
import { keyboardRemapService } from '../keyboard-remap/service'
import { appDisplayName, focusContext, type FocusedApp } from '../../focus-context'
import { AUTO_DARK_MODE_ID } from '@shared/auto-dark-mode'
import { COMMAND_PALETTE_ID, userCommandItemId } from '@shared/command-palette'

/**
 * Command Palette — system and user-defined commands exposed as palette
 * entries. Ships window-management commands (Maximize, Minimize, Restore),
 * OS power commands (Shut down, Restart, Sleep, Hibernate), a built-in
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

/** Keyboard Remap actions the palette can drive without opening settings:
 *  open the rules YAML in an editor, then re-install the hook from it. */
type KeyboardRemapCommand = 'edit-rules' | 'reload-rules'

type CommandKind =
  | { kind: 'window'; command: WindowCommand }
  | { kind: 'open-settings'; tab?: SettingsTabId }
  | { kind: 'auto-dark-mode'; command: 'schedule' | 'toggle' }
  | { kind: 'keyboard-remap'; command: KeyboardRemapCommand }
  | { kind: 'power'; command: PowerCommand }
  | { kind: 'create-user-command' }

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

const MODULE_ID = COMMAND_PALETTE_ID
const MODULE_NAME = 'Command Palette'
const MODULE_ICON = 'command'

/**
 * How long to wait after hiding the palette before acting on the window the
 * user was in. ~120 ms is long enough on Windows for SetForegroundWindow to
 * settle and the target window to become ready to receive a chord; macOS
 * needs a touch more headroom because Electron's hide() is async to the OS
 * and `osascript` queries the frontmost process at execution time — too
 * short and we act on our own (still-hiding) window. Too long and the user
 * notices the lag.
 */
const FOCUS_HANDOFF_DELAY_MS = process.platform === 'darwin' ? 200 : 120

/** Id of the contextual "Create user command for <app>" entry. Named so the
 * search builder can place it after the user's own commands rather than in
 * the built-in block where it's declared. */
const CREATE_USER_COMMAND_ID = 'create-user-command'

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
  /** Extra words the query also matches, for names people type as one
   * word or by a synonym ("shutdown", "reboot"). */
  keywords?: readonly string[]
  /** Ask before running — see PaletteItem.confirm. A function gets the
   * module's current config, for a prompt that spells out a setting. */
  confirm?:
    | PaletteItemConfirm
    | ((config: Record<string, ModuleConfigValue>) => PaletteItemConfirm)
  /** Longer description shown in the settings checkbox row. */
  configDescription: string
  /**
   * Title that depends on what the palette was opened over. Returning null
   * hides the entry for the current focus — used by "Create user command
   * for <app>", which has nothing to offer when we can't tell which app the
   * user came from. Absent = the static `title`, always shown.
   *
   * `title` stays the settings-UI label either way, so the checkbox reads
   * the same regardless of what the palette row says.
   */
  contextualTitle?: (focusedApp: FocusedApp | null) => string | null
}

/**
 * Config key for what Shut down and Restart leave behind: 'clean' (default)
 * or 'reopen' — the "Reopen windows when logging back in" checkbox of the
 * macOS dialog, as one standing choice. Only offered where the OS has the
 * notion (reopenWindowsSupported).
 */
const AFTER_SESSION_END_KEY = 'afterShutdownOrRestart'

function reopensWindows(
  config: Record<string, ModuleConfigValue> | undefined
): boolean {
  return (
    reopenWindowsSupported() && config?.[AFTER_SESSION_END_KEY] === 'reopen'
  )
}

const AFTER_SESSION_END_FIELD: ModuleConfigField = {
  key: AFTER_SESSION_END_KEY,
  type: 'radio',
  label: 'After Shut down or Restart',
  description:
    'Whether the apps and windows open now come back when you log back in. macOS: the "Reopen windows when logging back in" checkbox of the Apple menu dialog — a clean start also leaves that checkbox unticked. Windows: shutdown /s, /r for a clean start; /sg, /g to restart registered apps.',
  defaultValue: 'clean',
  options: [
    { value: 'clean', label: 'Start clean' },
    { value: 'reopen', label: 'Reopen windows' }
  ],
  group: 'OS'
}

/** Shared by Shut down and Restart — both close every app, and both follow
 * AFTER_SESSION_END_KEY for whether they come back. */
function closesAppsMessage(config: Record<string, ModuleConfigValue>): string {
  const message = 'Every open app will be asked to quit. Save your work first.'
  if (!reopenWindowsSupported()) return message
  return reopensWindows(config)
    ? `${message} Your apps and windows reopen when you log back in.`
    : `${message} Nothing reopens when you log back in.`
}

const BUILT_IN_COMMANDS: CommandDef[] = [
  {
    id: 'open-settings',
    title: 'Open settings',
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
    id: CREATE_USER_COMMAND_ID,
    title: 'Create user command for the focused app',
    icon: 'plus',
    subtitle: 'Save a command that only shows up in this app.',
    group: 'User Commands',
    configKey: 'enableCreateUserCommand',
    defaultEnabled: true,
    action: { kind: 'create-user-command' },
    requiresModuleId: 'user-commands',
    contextualTitle: (focusedApp) =>
      focusedApp ? `Create user command for ${appDisplayName(focusedApp)}` : null,
    configDescription:
      'Offer a "Create user command for <app>" entry naming whichever app the palette was opened over. Fills in the app scope for you, so a per-app command can be captured without a trip to Settings.'
  },
  {
    id: 'themes-on-schedule',
    title: 'Themes on schedule',
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
    title: 'Toggle theme',
    icon: 'sun-moon',
    subtitle: 'Switch between the light and dark system themes.',
    group: 'Themes',
    configKey: 'enableToggleTheme',
    defaultEnabled: true,
    action: { kind: 'auto-dark-mode', command: 'toggle' },
    requiresModuleId: AUTO_DARK_MODE_ID,
    configDescription:
      'Switch the system appearance and enter Manual mode so the schedule does not immediately undo the change.'
  },
  {
    id: 'edit-keyboard-remap-rules',
    title: 'Edit Keyboard Remap rules',
    icon: 'pencil',
    subtitle: 'Open the tap/hold rules YAML in your system editor.',
    group: 'Keyboard Remap',
    configKey: 'enableEditKeyboardRemapRules',
    defaultEnabled: true,
    action: { kind: 'keyboard-remap', command: 'edit-rules' },
    requiresModuleId: KEYBOARD_REMAP_ID,
    configDescription:
      'Open keyboard-rules.yaml in the system editor — the same thing the Edit button in Keyboard Remap settings does. The file is seeded from the template if it does not exist yet; edits take effect once the rules are reloaded.'
  },
  {
    id: 'reload-keyboard-remap-rules',
    title: 'Reload Keyboard Remap rules',
    icon: 'refresh-cw',
    subtitle: 'Re-install the hook from the edited YAML — no restart.',
    group: 'Keyboard Remap',
    configKey: 'enableReloadKeyboardRemapRules',
    defaultEnabled: true,
    action: { kind: 'keyboard-remap', command: 'reload-rules' },
    requiresModuleId: KEYBOARD_REMAP_ID,
    configDescription:
      'Re-read keyboard-rules.yaml and re-install the hook, the same as the Reload button in Keyboard Remap settings. A Desktop Hint confirms the reload, or reports why the file was rejected — invalid rules leave the previous working remap active.'
  },
  {
    id: 'shutdown',
    title: 'Shut down',
    icon: 'power',
    subtitle: 'Turn the computer off.',
    group: 'OS',
    configKey: 'enableShutdown',
    defaultEnabled: true,
    action: { kind: 'power', command: 'shutdown' },
    keywords: ['shutdown', 'power off', 'turn off'],
    confirm: (config) => ({
      title: 'Shut down the computer?',
      message: closesAppsMessage(config),
      confirmLabel: 'Shut down'
    }),
    configDescription:
      'Shut the computer down after a confirmation. Apps are asked to quit first, as with the OS menu. macOS: System Events "shut down". Windows: shutdown /s (/sg to reopen windows). Linux: systemctl poweroff.'
  },
  {
    id: 'restart',
    title: 'Restart',
    icon: 'rotate-cw',
    subtitle: 'Restart the computer.',
    group: 'OS',
    configKey: 'enableRestart',
    defaultEnabled: true,
    action: { kind: 'power', command: 'restart' },
    keywords: ['reboot'],
    confirm: (config) => ({
      title: 'Restart the computer?',
      message: closesAppsMessage(config),
      confirmLabel: 'Restart'
    }),
    configDescription:
      'Restart the computer after a confirmation. Apps are asked to quit first, as with the OS menu. macOS: System Events "restart". Windows: shutdown /r (/g to reopen windows). Linux: systemctl reboot.'
  },
  {
    id: 'sleep',
    title: 'Sleep',
    icon: 'moon',
    subtitle: 'Put the computer to sleep.',
    group: 'OS',
    configKey: 'enableSleep',
    defaultEnabled: true,
    action: { kind: 'power', command: 'sleep' },
    keywords: ['suspend'],
    configDescription:
      'Put the computer to sleep right away — nothing is closed, so no confirmation. macOS: pmset sleepnow. Windows: SetSuspendState. Linux: systemctl suspend.'
  },
  {
    id: 'hibernate',
    title: 'Hibernate',
    icon: 'hard-drive-download',
    subtitle: 'Save the session to disk and power off.',
    group: 'OS',
    configKey: 'enableHibernate',
    defaultEnabled: true,
    action: { kind: 'power', command: 'hibernate' },
    configDescription:
      'Save memory to disk and power off; the session comes back as it was on the next start. Windows: shutdown /h — fails if hibernation is turned off (powercfg /h on). Linux: systemctl hibernate. Not offered on macOS, which has no per-request hibernate.'
  }
]

/** The built-ins this OS can run. Hibernate is left out on macOS — from the
 * palette and from the settings checkboxes built off this list alike. */
const STATIC_COMMANDS = BUILT_IN_COMMANDS.filter(
  (c) => c.action.kind !== 'power' || powerCommandSupported(c.action.command)
)

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

interface KeyboardRemapAction {
  kind: 'keyboard-remap'
  command: KeyboardRemapCommand
}

interface PowerAction {
  kind: 'power'
  command: PowerCommand
}

interface CreateUserCommandAction {
  kind: 'create-user-command'
}

type ActionPayload =
  | WindowCommandAction
  | OpenSettingsAction
  | UserCommandAction
  | AutoDarkModeAction
  | KeyboardRemapAction
  | PowerAction
  | CreateUserCommandAction

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
  if (k === 'keyboard-remap') {
    const command = (a as { command?: unknown }).command
    return command === 'edit-rules' || command === 'reload-rules'
  }
  if (k === 'power') {
    const command = (a as { command?: unknown }).command
    return (
      command === 'shutdown' ||
      command === 'restart' ||
      command === 'sleep' ||
      command === 'hibernate'
    )
  }
  if (k === 'create-user-command') return true
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
  if (action.kind === 'keyboard-remap') return 'keyboard-remap'
  if (action.kind === 'power') return 'power'
  if (action.kind === 'create-user-command') return 'create-user-command'
  return 'window-command'
}

function actionPayloadFor(action: CommandKind): ActionPayload {
  if (action.kind === 'create-user-command') {
    return { kind: 'create-user-command' } satisfies CreateUserCommandAction
  }
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
  if (action.kind === 'keyboard-remap') {
    return {
      kind: 'keyboard-remap',
      command: action.command
    } satisfies KeyboardRemapAction
  }
  if (action.kind === 'power') {
    return {
      kind: 'power',
      command: action.command
    } satisfies PowerAction
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
    title: `Open ${m.name} settings`,
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
      'System and user-defined commands you can run from the palette. Ships an "Open Settings" entry, window-management commands (Maximize, Minimize, Restore), OS power commands (Shut down, Restart, Sleep, Hibernate), and a deep-link "Open <Module> Settings" entry for every registered module. User-created entries are managed in User Commands under Other; the ones scoped to an application are listed only while that application is the one behind the palette.',
    defaultEnabled: true,
    supportsDirectLaunch: true,
    defaultDirectLaunchHotkey: 'Ctrl+Alt+Super+P',
    configFields: (() => {
      const fields: ModuleConfigField[] = COMMANDS.map((c) => ({
        key: c.configKey,
        type: 'checkbox' as const,
        label: c.title,
        description: c.configDescription,
        defaultValue: c.defaultEnabled,
        group: c.group,
        ...(c.readOnly ? { readOnly: true } : {})
      }))
      if (!reopenWindowsSupported()) return fields
      // Closes the OS group, below its commands' checkboxes. A radio, so
      // the group's toggle-all leaves it be.
      const osEnd = fields.map((f) => f.group).lastIndexOf('OS') + 1
      fields.splice(osEnd, 0, AFTER_SESSION_END_FIELD)
      return fields
    })(),
    defaultAliases: DEFAULT_ALIASES
  }

  return {
    manifest: MANIFEST,

    async search(query, signal, context) {
      if (signal.aborted) return []

      const trimmed = query.trim()
      const normalisedQuery = trimmed.toLowerCase()
      const aliases = context.aliases ?? {}

      /** One candidate row, before query filtering. Built for built-in
       * commands and user commands alike so both take part in the alias
       * short-circuit below on equal terms. */
      interface Entry {
        id: string
        title: string
        subtitle: string
        iconHint: string
        group: string
        alias?: string
        badge?: string
        confirm?: PaletteItemConfirm
        /** Matched by the query alongside the title; not sent to the palette. */
        keywords?: readonly string[]
        actionKind: string
        action: ActionPayload
      }

      const entries: Entry[] = []

      const appendCommandDefs = (defs: CommandDef[]): void => {
        for (const c of defs) {
          if (!requiredModuleEnabled(c.requiresModuleId)) continue
          // readOnly entries always run regardless of stored config — the
          // settings UI hides the toggle so this guards against a
          // hand-edited settings.json zero-ing the flag.
          const enabled =
            c.readOnly === true || context.config[c.configKey] !== false
          if (!enabled) continue
          // A contextual entry names what the palette was opened over, and
          // opts out entirely when there's nothing to name.
          const title = c.contextualTitle
            ? c.contextualTitle(context.focusedApp)
            : c.title
          if (title === null) continue
          const id = `cmd:${c.id}`
          entries.push({
            id,
            title,
            subtitle: c.subtitle,
            iconHint: c.icon,
            group: c.group,
            alias: aliases[id],
            confirm:
              typeof c.confirm === 'function'
                ? c.confirm(context.config)
                : c.confirm,
            keywords: c.keywords,
            actionKind: actionKindFor(c.action),
            action: actionPayloadFor(c.action)
          })
        }
      }

      /**
       * User commands, app-scoped ones first. A command scoped to an app is
       * only listed while that app is the one behind the palette, so
       * "Reformat code" shows up in IntelliJ and stays out of the way
       * everywhere else — and two apps can reuse the same alias without ever
       * competing for it, since only one of them is ever in the list.
       *
       * Scoped and global commands share the one "User Commands" group: from
       * the user's side they're all just their commands, and the app a row
       * belongs to is carried by its badge chip instead of by a section of
       * its own.
       *
       * Aliases come from the module's ordinary alias map, keyed by the same
       * `user-command:<id>` item id the palette's Ctrl+K menu writes.
       */
      const appendUserCommands = (): void => {
        if (!userCommandsEnabled()) return
        const focusedApp = context.focusedApp
        for (const command of commandsInScope(userCommandsStore.list(), focusedApp)) {
          const id = userCommandItemId(command.id)
          entries.push({
            id,
            title: command.name,
            // Do not send saved shell text to the palette renderer: actions
            // may contain tokens and Settings is the authorized detail view.
            // Keystrokes carry nothing sensitive and read better spelled out.
            subtitle:
              command.kind === 'keystroke'
                ? `Sends ${formatKeystrokeAction(command.action)}`
                : 'Runs in background',
            iconHint: command.kind === 'keystroke' ? 'keyboard' : 'terminal',
            group: 'User Commands',
            alias: aliases[id],
            badge: appScopeLabel(command, focusedApp),
            actionKind: 'user-command',
            action: {
              kind: 'user-command',
              commandId: command.id
            } satisfies UserCommandAction
          })
        }
      }

      // Keep user-authored entries above the long generated list of module
      // settings links, while preserving the concise built-in Settings and
      // Windows Control groups at the top. "Create user command for <app>"
      // shares the User Commands group and trails the commands themselves —
      // it's the way to add another one, so it reads best at the end of the
      // list it adds to.
      appendCommandDefs(
        STATIC_COMMANDS.filter((c) => c.id !== CREATE_USER_COMMAND_ID)
      )
      appendUserCommands()
      appendCommandDefs(
        STATIC_COMMANDS.filter((c) => c.id === CREATE_USER_COMMAND_ID)
      )
      appendCommandDefs(dynamicCommands)

      // Alias short-circuit: typing the exact alias ("," → Open Settings)
      // returns just the matching row with autoExecute, mirroring
      // app-search's launch-on-alias mode. The user never sees the rest
      // of the result list flicker past — feels like a hotkey.
      //
      // Ties are broken by list order, which is also specificity order for
      // the entries that can realistically collide: a user command scoped to
      // the focused app beats a global one spelled the same way. (The store
      // rejects a duplicate alias within one scope outright, so the only
      // collisions that reach here are across scopes.)
      const aliasMatch = normalisedQuery
        ? entries.find((entry) => entry.alias === normalisedQuery)
        : undefined
      if (aliasMatch) {
        const { keywords: _keywords, ...item } = aliasMatch
        return [{ ...item, autoExecute: true, score: -1 }]
      }

      const items: Array<Omit<PaletteItem, 'moduleId'>> = []
      for (const { keywords, ...entry } of entries) {
        const matches =
          !trimmed ||
          entry.title.toLowerCase().includes(normalisedQuery) ||
          keywords?.some((k) => k.includes(normalisedQuery))
        if (!matches) continue
        items.push({ ...entry, score: items.length / 10000 })
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
        // Re-resolve against the store and re-check the app scope: the item
        // crossed the IPC boundary, and an app-scoped command must not run
        // from a stale row belonging to a different app's session.
        const command = userCommandsStore.find(item.action.commandId)
        if (!command || !commandMatchesFocus(command, focusContext.get())) {
          return { dismissPalette: false }
        }

        if (command.kind === 'keystroke') {
          // Same handoff as the window commands below: hide with
          // restoreFocus=true so the keys land in the app the user came
          // from, then synthesise once the OS has honoured the switch.
          paletteWindow.hide(true)
          setTimeout(
            () => sendUserCommandKeystroke(command),
            FOCUS_HANDOFF_DELAY_MS
          )
          return { dismissPalette: false }
        }

        return {
          dismissPalette: await executeUserCommand(command.id)
        }
      }

      if (item.action.kind === 'create-user-command') {
        // Hand the palette its own new-command form rather than opening
        // Settings: the point of the entry is capturing a command in the
        // moment, without leaving the app the command is for. The palette
        // stays up (dismissPalette: false) with the form over it, and main
        // — not the renderer — decides which app the result is scoped to.
        const focusedApp = focusContext.get()
        const win = paletteWindow.getBrowserWindow()
        if (
          item.actionKind !== 'create-user-command' ||
          !userCommandsEnabled() ||
          !focusedApp ||
          !win
        ) {
          return { dismissPalette: false }
        }
        win.webContents.send('user-commands:draft', {
          appLabel: appDisplayName(focusedApp)
        } satisfies UserCommandDraftPayload)
        return { dismissPalette: false }
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

      if (item.action.kind === 'keyboard-remap') {
        const command = COMMANDS.find(
          (candidate) => `cmd:${candidate.id}` === item.id
        )
        if (
          item.moduleId !== MODULE_ID ||
          item.actionKind !== 'keyboard-remap' ||
          !command ||
          command.action.kind !== 'keyboard-remap' ||
          command.action.command !== item.action.command ||
          !commandIsEnabledNow(command)
        ) {
          return { dismissPalette: false }
        }

        if (item.action.command === 'reload-rules') {
          // Nothing new comes to the front — the reload reports itself
          // through a focusless Desktop Hint — so hand focus back to
          // whatever the user was editing the rules in.
          paletteWindow.hide(true)
          try {
            keyboardRemapService.reloadFromCommand()
          } catch (error) {
            console.warn(
              '[command-palette] reloading keyboard rules failed:',
              error
            )
          }
          return { dismissPalette: false }
        }

        // Same handoff as Open Settings: the editor is what should land in
        // front, so hide without restoring focus to the previous window.
        paletteWindow.hide()
        try {
          await keyboardRemapService.openRulesInEditor()
        } catch (error) {
          console.warn(
            '[command-palette] opening keyboard rules failed:',
            error
          )
        }
        return { dismissPalette: false }
      }

      if (item.action.kind === 'power') {
        const command = COMMANDS.find(
          (candidate) => `cmd:${candidate.id}` === item.id
        )
        if (
          item.moduleId !== MODULE_ID ||
          item.actionKind !== 'power' ||
          !command ||
          command.action.kind !== 'power' ||
          command.action.command !== item.action.command ||
          !commandIsEnabledNow(command)
        ) {
          return { dismissPalette: false }
        }

        // Hand focus back first, so the app the user was in is the one in
        // front after waking from sleep. Any confirmation already happened
        // in the palette (PaletteItem.confirm) before this call was made.
        paletteWindow.hide(true)
        runPowerCommand(item.action.command, {
          reopenWindows: reopensWindows(
            settingsStore.get().modules[MODULE_ID]?.config
          )
        })
        return { dismissPalette: false }
      }

      // Window command — hide with restoreFocus=true so the OS
      // foreground window is the one the user was on before the palette
      // opened. Both the macOS System Events query ("first process whose
      // frontmost is true") and the Win/Linux keystroke synthesis
      // target whichever window the OS currently considers foreground,
      // so the handoff has to settle before we run.
      paletteWindow.hide(true)

      // A short delay covers the focus handoff — see FOCUS_HANDOFF_DELAY_MS.
      const command = item.action.command
      setTimeout(() => {
        const ok = simulateWindowCommand(command)
        if (!ok) {
          console.warn(
            `[command-palette] ${command} failed — driver unavailable?`
          )
        }
      }, FOCUS_HANDOFF_DELAY_MS)

      // We've handled the hide ourselves. Returning false short-circuits
      // the IPC handler's redundant `paletteWindow.hide()` call, which
      // would otherwise blur-grab the palette right after we restored
      // focus to the real target.
      return { dismissPalette: false }
    }
  }
}
