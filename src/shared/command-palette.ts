export const COMMAND_PALETTE_ID = 'command-palette'

const USER_COMMAND_ITEM_PREFIX = 'user-command:'

/**
 * Palette item id for a user command. The same id is used wherever the
 * command is listed — the Command Palette and the per-app User Commands
 * search — so selection, refresh, and Ctrl+K "Set alias…" address one row
 * identity across both.
 *
 * The alias itself is stored on the command record, not in a module's alias
 * map: main routes a Ctrl+K alias write for one of these ids to the User
 * Commands store, which keeps aliases unique within each app's commands.
 */
export function userCommandItemId(commandId: string): string {
  return `${USER_COMMAND_ITEM_PREFIX}${commandId}`
}

/** Inverse of `userCommandItemId`; null for any other kind of row. */
export function userCommandIdFromItemId(itemId: string): string | null {
  if (typeof itemId !== 'string' || !itemId.startsWith(USER_COMMAND_ITEM_PREFIX)) {
    return null
  }
  return itemId.slice(USER_COMMAND_ITEM_PREFIX.length) || null
}
