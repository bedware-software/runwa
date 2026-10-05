import { focusContext } from '../../focus-context'
import { paletteWindow } from '../../palette-window'
import { executeUserCommand, sendUserCommandKeystroke } from './executor'
import { commandMatchesFocus } from './scope'
import { userCommandsStore } from './store'

/**
 * How long to wait after hiding the palette before acting on the window the
 * user was in. ~120 ms is long enough on Windows for SetForegroundWindow to
 * settle and the target window to become ready to receive a chord; macOS
 * needs a touch more headroom because Electron's hide() is async to the OS
 * and `osascript` queries the frontmost process at execution time — too
 * short and we act on our own (still-hiding) window. Too long and the user
 * notices the lag.
 */
export const FOCUS_HANDOFF_DELAY_MS = process.platform === 'darwin' ? 200 : 120

/**
 * Run a user command picked from a palette row — the Command Palette's or
 * the per-app User Commands search's, which share this path.
 *
 * Re-resolves the id against the store and re-checks the app scope: the item
 * crossed the IPC boundary, and an app-scoped command must not run from a
 * stale row belonging to a different app's session.
 */
export async function runUserCommandFromPalette(
  commandId: string
): Promise<{ dismissPalette: boolean }> {
  const command = userCommandsStore.find(commandId)
  if (!command || !commandMatchesFocus(command, focusContext.get())) {
    return { dismissPalette: false }
  }

  if (command.kind === 'keystroke') {
    // Hide with restoreFocus=true so the keys land in the app the user came
    // from, then synthesise once the OS has honoured the switch. We've done
    // the hide ourselves, so the IPC handler must not hide again (that
    // would blur-grab the palette right after focus was restored).
    paletteWindow.hide(true)
    setTimeout(() => sendUserCommandKeystroke(command), FOCUS_HANDOFF_DELAY_MS)
    return { dismissPalette: false }
  }

  return { dismissPalette: await executeUserCommand(command.id) }
}
