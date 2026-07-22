import { randomUUID } from 'node:crypto'
import Store from 'electron-store'
import type { UserCommand } from '@shared/types'

interface PersistedShape {
  commands: UserCommand[]
}

export const MAX_USER_COMMANDS = 200
export const MAX_USER_COMMAND_NAME_LENGTH = 100
export const MAX_USER_COMMAND_ACTION_LENGTH = 4096
const MAX_USER_COMMAND_ID_LENGTH = 200

/**
 * Seed useful, harmless examples that also document the shell syntax for the
 * current platform. They are ordinary commands: users can run or remove them,
 * and an explicitly-emptied list stays empty because electron-store persists
 * `commands: []` rather than re-applying defaults.
 */
function starterCommands(platform: NodeJS.Platform = process.platform): UserCommand[] {
  if (platform === 'win32') {
    return [
      {
        id: 'example:downloads',
        name: 'Open Downloads',
        action: 'explorer.exe "%USERPROFILE%\\Downloads"'
      },
      {
        id: 'example:calculator',
        name: 'Open Calculator',
        action: 'calc.exe'
      },
      {
        id: 'example:notepad',
        name: 'Open Notepad',
        action: 'notepad.exe'
      }
    ]
  }

  if (platform === 'darwin') {
    return [
      {
        id: 'example:downloads',
        name: 'Open Downloads',
        action: 'open "$HOME/Downloads"'
      },
      {
        id: 'example:calculator',
        name: 'Open Calculator',
        action: 'open -a Calculator'
      },
      {
        id: 'example:textedit',
        name: 'Open TextEdit',
        action: 'open -a TextEdit'
      }
    ]
  }

  return [
    {
      id: 'example:downloads',
      name: 'Open Downloads',
      action: 'xdg-open "$HOME/Downloads"'
    },
    {
      id: 'example:home',
      name: 'Open Home Folder',
      action: 'xdg-open "$HOME"'
    },
    {
      id: 'example:terminal',
      name: 'Open Terminal',
      action: 'x-terminal-emulator'
    }
  ]
}

function parseNewCommand(value: unknown): Omit<UserCommand, 'id'> {
  if (typeof value !== 'object' || value === null) {
    throw new Error('A command name and action are required.')
  }

  const candidate = value as { name?: unknown; action?: unknown }
  if (typeof candidate.name !== 'string' || typeof candidate.action !== 'string') {
    throw new Error('A command name and action are required.')
  }

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

  return { name, action }
}

/** Drop malformed hand-edited entries before they reach the palette or
 * execution layer. This is deliberately stricter than TypeScript's on-disk
 * type, since JSON files can be edited or partially corrupted. */
function sanitiseCommands(value: unknown): UserCommand[] {
  if (!Array.isArray(value)) return []
  const commands: UserCommand[] = []
  const seenIds = new Set<string>()
  for (const entry of value) {
    if (commands.length >= MAX_USER_COMMANDS) break
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as { id?: unknown; name?: unknown; action?: unknown }
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
    if (
      !id ||
      id.length > MAX_USER_COMMAND_ID_LENGTH ||
      !name ||
      !action ||
      seenIds.has(id) ||
      name.length > MAX_USER_COMMAND_NAME_LENGTH ||
      action.length > MAX_USER_COMMAND_ACTION_LENGTH ||
      action.includes('\0')
    ) {
      continue
    }
    seenIds.add(id)
    commands.push({ id, name, action })
  }
  return commands
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
  }

  private ensureInit(): Store<PersistedShape> {
    if (!this.store) throw new Error('UserCommandsStore used before init()')
    return this.store
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
    if (
      commands.some(
        (command) => command.name.toLowerCase() === nextCommand.name.toLowerCase()
      )
    ) {
      throw new Error(`A command named “${nextCommand.name}” already exists.`)
    }

    commands.push({ id: randomUUID(), ...nextCommand })
    this.ensureInit().store = { commands }
    return commands.map((command) => ({ ...command }))
  }

  remove(commandId: unknown): UserCommand[] {
    if (typeof commandId !== 'string' || !commandId.trim()) {
      throw new Error('A valid command id is required.')
    }
    const id = commandId.trim()
    if (id.length > MAX_USER_COMMAND_ID_LENGTH) {
      throw new Error('A valid command id is required.')
    }
    const commands = this.list().filter((command) => command.id !== id)
    this.ensureInit().store = { commands }
    return commands.map((command) => ({ ...command }))
  }
}

export const userCommandsStore = new UserCommandsStore()
