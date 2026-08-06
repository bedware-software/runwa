export const COMMAND_PALETTE_ID = 'command-palette'

/**
 * Palette item id for a user command. User commands are surfaced by the
 * Command Palette module rather than their own search surface, so they take
 * part in that module's per-item alias map like any other row: the palette's
 * Ctrl+K "Set alias…" writes `aliases['user-command:<id>']`, and the search
 * builder reads it back onto the row.
 *
 * The alias is keyed by command id, never by the alias text, so two commands
 * scoped to different apps can carry the same alias without colliding —
 * only one of them is ever in the list at a time.
 */
export function userCommandItemId(commandId: string): string {
  return `user-command:${commandId}`
}
