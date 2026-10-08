import { systemPreferences } from 'electron'
import { getForegroundWindow } from './native'

/**
 * macOS: most-recently-focused order for the all-Spaces listing.
 *
 * The current-Space listing is z-ordered by WindowServer, so row two is the
 * window the user was in before — what the double-press quick switch relies
 * on. The all-Spaces listing comes from the same CGWindowList call minus
 * `OnScreenOnly`, and there windows on other Spaces keep a stale order that
 * activation doesn't update: three apps on three desktops list as 1-2-3 no
 * matter which one the user was just in.
 *
 * So we keep the order ourselves, fed by events rather than sampling:
 *  - app activation and Space changes (NSWorkspace notifications) record the
 *    window that is now in front;
 *  - the palette's own open records the window the user came from;
 *  - the switcher records the window it focuses, and nothing in between
 *    (see `recordSwitcherFocus`).
 * Windows we never saw in front fall back to CGWindowList order behind the
 * ones we did.
 */

const MAX_TRACKED = 64

/** Window ids (`${pid}:${cgWindowId}`), most recent first. */
const order: string[] = []

export function recordFocusedWindow(id: string | null | undefined): void {
  if (!id) return
  const index = order.indexOf(id)
  if (index === 0) return
  if (index > 0) order.splice(index, 1)
  order.unshift(id)
  if (order.length > MAX_TRACKED) order.length = MAX_TRACKED
}

/** Switcher focuses still running; see `recordSwitcherFocus`. */
let focusesInFlight = 0

/**
 * Record a focus the switcher itself performs, and keep its intermediate
 * states out of the record. Focusing a back window of an app on another
 * Space first activates the app, which brings the app's *front* window
 * forward and fires the activation and Space-change notifications; only then
 * does the native side raise the chosen window. Recorded as-is, that
 * transient front window would land between the chosen window and the one
 * the user came from, and the double-press would bounce to it.
 */
export function recordSwitcherFocus(id: string, focus: Promise<boolean>): void {
  recordFocusedWindow(id)
  focusesInFlight++
  void focus
    .then((ok) => {
      if (ok) recordFocusedWindow(id)
    })
    .catch(() => {})
    .finally(() => {
      focusesInFlight--
    })
}

/** Stable sort: recorded windows first in recency order, the rest after in
 * their original order. */
export function sortByRecency<T extends { id: string }>(windows: T[]): T[] {
  const rank = new Map(order.map((id, i) => [id, i]))
  return windows
    .map((window, index) => ({ window, index, rank: rank.get(window.id) ?? Infinity }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.window)
}

let tracking = false

export function startRecencyTracking(): void {
  if (tracking || process.platform !== 'darwin') return
  tracking = true

  const recordFront = (): void => {
    if (focusesInFlight > 0) return
    try {
      recordFocusedWindow(getForegroundWindow())
    } catch (err) {
      console.warn('[window-switcher] recency: foreground lookup failed', err)
    }
  }

  // Activation fires before a cross-Space switch has finished, so on its own
  // it would record the window being left; the Space-change notification that
  // follows records the window that was arrived at, which ends up in front.
  systemPreferences.subscribeWorkspaceNotification(
    'NSWorkspaceDidActivateApplicationNotification',
    recordFront
  )
  systemPreferences.subscribeWorkspaceNotification(
    'NSWorkspaceActiveSpaceDidChangeNotification',
    recordFront
  )
}
