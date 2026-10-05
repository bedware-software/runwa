import type { ModuleManifest, PaletteItem, UserCommand } from '@shared/types'
import { userCommandItemId } from '@shared/command-palette'
import { USER_COMMANDS_ID } from '@shared/user-commands'
import type { PaletteModule } from '../types'
import { appDisplayName, resolveWindow, type FocusedApp } from '../../focus-context'
import { fuzzyScore } from '../../fuzzy-match'
import { desktopHintWindow } from '../../desktop-hint-window'
import { paletteWindow } from '../../palette-window'
import { getForegroundWindow } from '../window-switcher/native'
import { formatKeystrokeAction } from './keystroke'
import { runUserCommandFromPalette } from './palette-run'
import { commandMatchesFocus, isGlobalCommand } from './scope'
import { userCommandsStore } from './store'

const MANIFEST: ModuleManifest = {
  id: USER_COMMANDS_ID,
  name: 'User Commands',
  icon: 'terminal',
  kind: 'service',
  description:
    'Create named actions that appear in the Command Palette — shell commands that run scripts or launch applications with arguments, and keystroke commands that press a shortcut in the app you were just in. Each command is either global or scoped to one application, in which case it is only listed while that app is focused. The hotkey opens a search over just the commands of the app in front, or says there are none.',
  defaultEnabled: true,
  supportsDirectLaunch: true,
  defaultDirectLaunchHotkey: 'Ctrl+Alt+Super+U'
}

/** Desktop Hint shown when the hotkey fires over an app with no commands. */
const NO_COMMANDS_HINT_MS = 1800

/** Commands scoped to `app` — global ones are left to the Command Palette. */
function appCommands(app: FocusedApp | null): UserCommand[] {
  if (!app) return []
  return userCommandsStore
    .list()
    .filter((command) => !isGlobalCommand(command) && commandMatchesFocus(command, app))
}

function foregroundApp(): FocusedApp | null {
  try {
    const windowId = getForegroundWindow()
    return windowId ? resolveWindow(windowId) : null
  } catch (err) {
    console.warn('[user-commands] foreground lookup failed', err)
    return null
  }
}

/**
 * Best (lowest) score for the query against a command: its name fuzzily, its
 * alias as a prefix (so a half-typed alias keeps its row on top) or fuzzily.
 */
function scoreCommand(query: string, command: UserCommand): number | null {
  const byName = fuzzyScore(query, command.name)
  if (!command.alias) return byName
  const lowered = query.toLowerCase()
  const byAlias = command.alias.startsWith(lowered)
    ? -1
    : fuzzyScore(query, command.alias)
  if (byName === null) return byAlias
  if (byAlias === null) return byName
  return Math.min(byName, byAlias)
}

/**
 * User Commands owns two surfaces:
 *  - its commands are rows of the Command Palette (built there, alongside the
 *    built-ins), and
 *  - its own direct-launch hotkey opens a search over just the commands
 *    scoped to the app in front — the "what can I do in this app" list. Over
 *    an app with no commands, the hotkey shows a Desktop Hint instead of an
 *    empty palette.
 */
export function createUserCommandsModule(): PaletteModule {
  return {
    manifest: MANIFEST,

    handleDirectLaunch(event) {
      if (event !== 'press') return
      // Second press while our search is up closes it. While the palette is
      // up for another module the foreground window is runwa itself, so the
      // app to check is the one the palette was opened over.
      const win = paletteWindow.getBrowserWindow()
      if (win && !win.isDestroyed() && win.isVisible()) {
        paletteWindow.toggle(USER_COMMANDS_ID)
        return
      }
      const app = foregroundApp()
      if (appCommands(app).length === 0) {
        desktopHintWindow.show({
          source: USER_COMMANDS_ID,
          message: app
            ? `No user commands for ${appDisplayName(app)}`
            : 'No user commands for this app',
          durationMs: NO_COMMANDS_HINT_MS
        })
        return
      }
      paletteWindow.toggle(USER_COMMANDS_ID)
    },

    async search(query, signal, context) {
      if (signal.aborted) return []
      const app = context.focusedApp
      const commands = appCommands(app)
      const group = app ? `${appDisplayName(app)} commands` : 'User Commands'

      const toItem = (
        command: UserCommand,
        score: number
      ): Omit<PaletteItem, 'moduleId'> => ({
        id: userCommandItemId(command.id),
        title: command.name,
        // Shell text stays in main / Settings; keystrokes read better spelled
        // out — same policy as the Command Palette rows.
        subtitle:
          command.kind === 'keystroke'
            ? `Sends ${formatKeystrokeAction(command.action)}`
            : 'Runs in background',
        iconHint: command.kind === 'keystroke' ? 'keyboard' : 'terminal',
        group,
        alias: command.alias,
        actionKind: 'user-command',
        action: { kind: 'user-command', commandId: command.id },
        score
      })

      const trimmed = query.trim()
      if (!trimmed) {
        return commands.map((command, i) => toItem(command, i / 10000))
      }

      // Typing an alias exactly runs it, as in the Command Palette. Aliases
      // are unique per app, so at most one row can match.
      const normalised = trimmed.toLowerCase()
      const aliased = commands.find((command) => command.alias === normalised)
      if (aliased) {
        return [{ ...toItem(aliased, -1), autoExecute: true }]
      }

      const items: Array<Omit<PaletteItem, 'moduleId'>> = []
      commands.forEach((command, i) => {
        const score = scoreCommand(trimmed, command)
        // Store order breaks ties, so equal matches keep the user's order.
        if (score !== null) items.push(toItem(command, score + i / 10000))
      })
      return items
    },

    async execute(item) {
      const action = item.action as { kind?: unknown; commandId?: unknown } | null
      if (
        item.actionKind !== 'user-command' ||
        action?.kind !== 'user-command' ||
        typeof action.commandId !== 'string'
      ) {
        return { dismissPalette: false }
      }
      return runUserCommandFromPalette(action.commandId)
    }
  }
}
