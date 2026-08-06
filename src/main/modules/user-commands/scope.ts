import type { UserCommand } from '@shared/types'
import {
  appDisplayName,
  appIdentityCandidates,
  type FocusedApp
} from '../../focus-context'
import { globMatches } from '../../glob-match'

/**
 * App scoping for user commands.
 *
 * A command with an empty `appScope` is global and always listed. A scoped
 * one is listed only while its app is the one behind the palette — that's
 * what makes "Reformat code" mean something in IntelliJ and stay out of the
 * way everywhere else, and what keeps two identical aliases for two
 * different apps from ever competing.
 */

export function isGlobalCommand(command: UserCommand): boolean {
  return command.appScope === ''
}

/** True when the command should be visible for the given focused app. */
export function commandMatchesFocus(
  command: UserCommand,
  focusedApp: FocusedApp | null
): boolean {
  if (isGlobalCommand(command)) return true
  if (!focusedApp) return false
  return appIdentityCandidates(focusedApp).some((candidate) =>
    globMatches(command.appScope, candidate)
  )
}

/**
 * Label for the chip that marks an app-scoped row in the palette.
 *
 * Normally the scope as the user wrote it — that's the app they had in mind.
 * Wildcard patterns are the exception: `*idea*` is a rule, not a name, so the
 * chip shows what the rule actually matched instead.
 */
export function appScopeLabel(
  command: UserCommand,
  focusedApp: FocusedApp | null
): string | undefined {
  if (isGlobalCommand(command)) return undefined
  if (!command.appScope.includes('*')) return command.appScope
  return focusedApp ? appDisplayName(focusedApp) : command.appScope
}

/**
 * Commands currently in scope, app-specific ones first.
 *
 * The ordering is what resolves an alias shared by a global command and an
 * app-scoped one: the more specific entry is found first, so inside IntelliJ
 * the IntelliJ "b" wins and everywhere else the global "b" still works.
 */
export function commandsInScope(
  commands: UserCommand[],
  focusedApp: FocusedApp | null
): UserCommand[] {
  const scoped: UserCommand[] = []
  const global: UserCommand[] = []
  for (const command of commands) {
    if (!commandMatchesFocus(command, focusedApp)) continue
    if (isGlobalCommand(command)) global.push(command)
    else scoped.push(command)
  }
  return [...scoped, ...global]
}
