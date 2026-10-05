import { randomUUID } from 'node:crypto'
import Store from 'electron-store'
import type { NewUserCommand, UserCommand, UserCommandKind } from '@shared/types'
import { COMMAND_PALETTE_ID } from '@shared/command-palette'
import { settingsStore } from '../../settings-store'
import { describeKeystrokeError, normaliseKeystrokeAction } from './keystroke'

interface PersistedShape {
  commands: UserCommand[]
}

export const MAX_USER_COMMANDS = 200
export const MAX_USER_COMMAND_NAME_LENGTH = 100
export const MAX_USER_COMMAND_ACTION_LENGTH = 4096
export const MAX_USER_COMMAND_SCOPE_LENGTH = 512
export const MAX_USER_COMMAND_ALIAS_LENGTH = 64
const MAX_USER_COMMAND_ID_LENGTH = 200

/** Prefix of the palette item ids aliases used to be keyed by, back when a
 * user command's alias lived in the Command Palette module's alias map. */
const LEGACY_ALIAS_ITEM_PREFIX = 'user-command:'

/**
 * Seed useful, harmless examples that also document the shell syntax for the
 * current platform. They are ordinary commands: users can run or remove them,
 * and an explicitly-emptied list stays empty because electron-store persists
 * `commands: []` rather than re-applying defaults.
 */
function starterCommands(platform: NodeJS.Platform = process.platform): UserCommand[] {
  const shellCommand = (
    id: string,
    name: string,
    action: string
  ): UserCommand => ({ id, name, kind: 'shell', action, appScope: '' })

  if (platform === 'win32') {
    return [
      shellCommand('example:downloads', 'Open Downloads', 'explorer.exe "%USERPROFILE%\\Downloads"'),
      shellCommand('example:calculator', 'Open Calculator', 'calc.exe'),
      shellCommand('example:notepad', 'Open Notepad', 'notepad.exe')
    ]
  }

  if (platform === 'darwin') {
    return [
      shellCommand('example:downloads', 'Open Downloads', 'open "$HOME/Downloads"'),
      shellCommand('example:calculator', 'Open Calculator', 'open -a Calculator'),
      shellCommand('example:textedit', 'Open TextEdit', 'open -a TextEdit')
    ]
  }

  return [
    shellCommand('example:downloads', 'Open Downloads', 'xdg-open "$HOME/Downloads"'),
    shellCommand('example:home', 'Open Home Folder', 'xdg-open "$HOME"'),
    shellCommand('example:terminal', 'Open Terminal', 'x-terminal-emulator')
  ]
}

function parseAppScope(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') {
    throw new Error('App scope must be text.')
  }
  const scope = value.trim()
  if (scope.length > MAX_USER_COMMAND_SCOPE_LENGTH) {
    throw new Error(`App scopes can be at most ${MAX_USER_COMMAND_SCOPE_LENGTH} characters.`)
  }
  // A bare `*` matches every app, which is what "global" already means —
  // accept it, but store it as global so the two states can't drift.
  return scope === '*' ? '' : scope
}

/** Normalise an alias the way the palette matches it: trimmed, lowercased.
 * Blank means "no alias". */
export function parseAlias(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error('Alias must be text.')
  }
  const alias = value.trim().toLowerCase()
  if (!alias) return undefined
  if (alias.length > MAX_USER_COMMAND_ALIAS_LENGTH) {
    throw new Error(`Aliases can be at most ${MAX_USER_COMMAND_ALIAS_LENGTH} characters.`)
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(alias)) {
    throw new Error('Aliases cannot contain control characters.')
  }
  return alias
}

function parseKind(value: unknown): UserCommandKind {
  if (value === undefined || value === null) return 'shell'
  if (value !== 'shell' && value !== 'keystroke') {
    throw new Error('Command type must be either a shell command or a keystroke.')
  }
  return value
}

function parseNewCommand(value: unknown): Omit<UserCommand, 'id'> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('A command name and action are required.')
  }

  const candidate = value as NewUserCommand
  if (typeof candidate.name !== 'string' || typeof candidate.action !== 'string') {
    throw new Error('A command name and action are required.')
  }

  const kind = parseKind(candidate.kind)
  const name = candidate.name.trim().replace(/\s+/g, ' ')
  const action = candidate.action.trim()
  if (!name || !action) {
    throw new Error('A command name and action are required.')
  }
  if (name.length > MAX_USER_COMMAND_NAME_LENGTH) {
    throw new Error(`Command names can be at most ${MAX_USER_COMMAND_NAME_LENGTH} characters.`)
  }
  if (action.length > MAX_USER_COMMAND_ACTION_LENGTH) {
    throw new Error(`Actions can be at most ${MAX_USER_COMMAND_ACTION_LENGTH} characters.`)
  }
  if (action.includes('\0')) {
    throw new Error('Actions cannot contain null characters.')
  }
  // Keystroke actions are a closed syntax, so a typo can be caught here
  // instead of silently doing nothing when the user runs the command.
  if (kind === 'keystroke') {
    const problem = describeKeystrokeError(action)
    if (problem) throw new Error(problem)
  }

  const alias = parseAlias(candidate.alias)
  return {
    name,
    kind,
    action: kind === 'keystroke' ? normaliseKeystrokeAction(action) : action,
    appScope: parseAppScope(candidate.appScope),
    ...(alias ? { alias } : {})
  }
}

/** Drop malformed hand-edited entries before they reach the palette or
 * execution layer. This is deliberately stricter than TypeScript's on-disk
 * type, since JSON files can be edited or partially corrupted.
 *
 * Records written before app scoping / keystroke commands existed have no
 * `kind` or `appScope` — those read as a global shell command, which is
 * exactly what they were.
 *
 * A broken or clashing alias only costs the command its alias, never the
 * command itself: the first command in file order keeps a duplicated alias,
 * the same "first one wins" a hand edit would expect. */
function sanitiseCommands(value: unknown): UserCommand[] {
  if (!Array.isArray(value)) return []
  const commands: UserCommand[] = []
  const seenIds = new Set<string>()
  const seenAliases = new Set<string>()
  for (const entry of value) {
    if (commands.length >= MAX_USER_COMMANDS) break
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as Partial<UserCommand>
    if (
      typeof candidate.id !== 'string' ||
      typeof candidate.name !== 'string' ||
      typeof candidate.action !== 'string'
    ) {
      continue
    }
    const id = candidate.id.trim()
    const name = candidate.name.trim().replace(/\s+/g, ' ')
    const action = candidate.action.trim()
    const kind: UserCommandKind = candidate.kind === 'keystroke' ? 'keystroke' : 'shell'
    const appScope =
      typeof candidate.appScope === 'string' ? candidate.appScope.trim() : ''
    // A broken scope means dropping the record: silently widening an
    // app-scoped command to every app would be worse than hiding it.
    if (
      !id ||
      id.length > MAX_USER_COMMAND_ID_LENGTH ||
      !name ||
      !action ||
      seenIds.has(id) ||
      name.length > MAX_USER_COMMAND_NAME_LENGTH ||
      action.length > MAX_USER_COMMAND_ACTION_LENGTH ||
      action.includes('\0') ||
      appScope.length > MAX_USER_COMMAND_SCOPE_LENGTH
    ) {
      continue
    }
    seenIds.add(id)
    const scope = appScope === '*' ? '' : appScope
    let alias: string | undefined
    try {
      alias = parseAlias(candidate.alias)
    } catch {
      alias = undefined
    }
    if (alias) {
      const key = aliasKey(scope, alias)
      if (seenAliases.has(key)) alias = undefined
      else seenAliases.add(key)
    }
    commands.push({
      id,
      name,
      kind,
      action,
      appScope: scope,
      ...(alias ? { alias } : {})
    })
  }
  return commands
}

function aliasKey(appScope: string, alias: string): string {
  return `${scopeKey(appScope)}\u0000${alias}`
}

/** Two commands collide only when they'd be listed together — i.e. when they
 * share an app scope. That's what lets "Build" (IntelliJ) and "Build" (VS
 * Code) coexist. */
function scopeKey(appScope: string): string {
  return appScope.toLowerCase()
}

/**
 * User commands live outside the main settings payload. Command actions can
 * grow fairly large and should not be rebroadcast to every renderer whenever
 * an unrelated setting changes.
 */
class UserCommandsStore {
  private store: Store<PersistedShape> | null = null

  init(): void {
    if (this.store) return
    this.store = new Store<PersistedShape>({
      name: 'runwa-user-commands',
      defaults: { commands: starterCommands() }
    })
    this.migrateLegacyAliases()
  }

  private ensureInit(): Store<PersistedShape> {
    if (!this.store) throw new Error('UserCommandsStore used before init()')
    return this.store
  }

  /** The JSON file the commands live in — what Settings' Edit button opens. */
  filePath(): string {
    return this.ensureInit().path
  }

  /**
   * One-time move of aliases out of the Command Palette module's alias map
   * (`aliases['user-command:<id>']`, where Ctrl+K used to write them) onto
   * the commands themselves. The command record is now the only place an
   * alias lives, so every surface that lists user commands — the Command
   * Palette and the per-app User Commands search — reads the same alias,
   * and uniqueness is checked in one place. An alias that would clash is
   * dropped rather than carried over.
   */
  private migrateLegacyAliases(): void {
    const legacy = settingsStore.get().modules[COMMAND_PALETTE_ID]?.aliases ?? {}
    const entries = Object.entries(legacy).filter(([itemId]) =>
      itemId.startsWith(LEGACY_ALIAS_ITEM_PREFIX)
    )
    if (entries.length === 0) return

    const commands = this.list()
    for (const [itemId, rawAlias] of entries) {
      const command = commands.find(
        (candidate) => candidate.id === itemId.slice(LEGACY_ALIAS_ITEM_PREFIX.length)
      )
      let alias: string | undefined
      try {
        alias = parseAlias(rawAlias)
      } catch {
        alias = undefined
      }
      if (
        command &&
        alias &&
        !command.alias &&
        !findAliasClash(commands, command.appScope, alias, command.id)
      ) {
        command.alias = alias
      }
      settingsStore.patchModuleAlias(COMMAND_PALETTE_ID, itemId, null)
    }
    this.ensureInit().store = { commands }
  }

  list(): UserCommand[] {
    const commands = sanitiseCommands(this.ensureInit().store.commands)
    return commands.map((command) => ({ ...command }))
  }

  find(commandId: string): UserCommand | undefined {
    const command = this.list().find((candidate) => candidate.id === commandId)
    return command ? { ...command } : undefined
  }

  add(value: unknown): UserCommand[] {
    const nextCommand = parseNewCommand(value)
    const commands = this.list()
    if (commands.length >= MAX_USER_COMMANDS) {
      throw new Error(`You can save up to ${MAX_USER_COMMANDS} user commands.`)
    }
    assertNameIsFree(commands, nextCommand)
    assertAliasIsFree(commands, nextCommand.appScope, nextCommand.alias)

    commands.push({ id: randomUUID(), ...nextCommand })
    this.ensureInit().store = { commands }
    return commands.map((command) => ({ ...command }))
  }

  /**
   * Replace every editable field of an existing command, keeping its id.
   *
   * The id is what the palette alias map and any in-flight launch guard key
   * off, so editing a command keeps its Ctrl+K alias attached instead of
   * orphaning it the way delete-and-re-add would.
   */
  update(commandId: unknown, value: unknown): UserCommand[] {
    const id = parseCommandId(commandId)
    const nextCommand = parseNewCommand(value)
    const commands = this.list()
    const index = commands.findIndex((command) => command.id === id)
    if (index < 0) {
      throw new Error('That command no longer exists.')
    }
    assertNameIsFree(commands, nextCommand, id)
    assertAliasIsFree(commands, nextCommand.appScope, nextCommand.alias, id)

    commands[index] = { id, ...nextCommand }
    this.ensureInit().store = { commands }
    return commands.map((command) => ({ ...command }))
  }

  /**
   * Set or clear (blank / null) one command's alias, leaving every other
   * field alone. This is the palette's Ctrl+K "Set alias…" path; it enforces
   * the same per-app uniqueness as saving the command from Settings.
   */
  setAlias(commandId: unknown, value: unknown): UserCommand[] {
    const id = parseCommandId(commandId)
    const alias = parseAlias(value)
    const commands = this.list()
    const command = commands.find((candidate) => candidate.id === id)
    if (!command) {
      throw new Error('That command no longer exists.')
    }
    assertAliasIsFree(commands, command.appScope, alias, id)
    if (alias) command.alias = alias
    else delete command.alias
    this.ensureInit().store = { commands }
    return commands.map((candidate) => ({ ...candidate }))
  }

  remove(commandId: unknown): UserCommand[] {
    const id = parseCommandId(commandId)
    const commands = this.list().filter((command) => command.id !== id)
    this.ensureInit().store = { commands }
    return commands.map((command) => ({ ...command }))
  }
}

function parseCommandId(commandId: unknown): string {
  if (typeof commandId !== 'string' || !commandId.trim()) {
    throw new Error('A valid command id is required.')
  }
  const id = commandId.trim()
  if (id.length > MAX_USER_COMMAND_ID_LENGTH) {
    throw new Error('A valid command id is required.')
  }
  return id
}

/** Names only have to be unique among the commands listed together — i.e.
 * within one app scope. `exceptId` excludes the command being edited so
 * saving it unchanged isn't reported as a clash with itself. */
function assertNameIsFree(
  commands: UserCommand[],
  nextCommand: Omit<UserCommand, 'id'>,
  exceptId?: string
): void {
  const scope = scopeKey(nextCommand.appScope)
  const clash = commands.some(
    (command) =>
      command.id !== exceptId &&
      scopeKey(command.appScope) === scope &&
      command.name.toLowerCase() === nextCommand.name.toLowerCase()
  )
  if (!clash) return
  throw new Error(
    nextCommand.appScope
      ? `A command named “${nextCommand.name}” already exists for ${nextCommand.appScope}.`
      : `A command named “${nextCommand.name}” already exists.`
  )
}

/** The command (other than `exceptId`) in the same app scope that already
 * uses `alias`, if any. Same scope rule as names: commands for different
 * apps are never listed together, so they may share an alias. */
function findAliasClash(
  commands: UserCommand[],
  appScope: string,
  alias: string,
  exceptId?: string
): UserCommand | undefined {
  const scope = scopeKey(appScope)
  return commands.find(
    (command) =>
      command.id !== exceptId &&
      command.alias === alias &&
      scopeKey(command.appScope) === scope
  )
}

function assertAliasIsFree(
  commands: UserCommand[],
  appScope: string,
  alias: string | undefined,
  exceptId?: string
): void {
  if (!alias) return
  const clash = findAliasClash(commands, appScope, alias, exceptId)
  if (!clash) return
  throw new Error(
    appScope
      ? `The alias “${alias}” is already used by “${clash.name}” in ${appScope}.`
      : `The alias “${alias}” is already used by “${clash.name}”.`
  )
}

export const userCommandsStore = new UserCommandsStore()
