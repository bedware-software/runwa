import { execFileSync } from 'child_process'

/**
 * macOS recovery paths for the CapsLock→F19 `hidutil` remap.
 *
 * The native addon calls `hidutil property --set ...` at hook-install time
 * to get proper KeyDown/KeyUp events for the physical CapsLock key (see
 * native/src/remap/macos.rs). The graceful revert path runs from
 * `MacosHook::stop()` on `will-quit`.
 *
 * Gap: `will-quit` doesn't fire on hard crashes, SIGKILL, OOM, or log-outs
 * mid-session, so the mapping can outlive the runwa process and leave
 * CapsLock generating F19 system-wide. The helpers below give two recovery
 * paths that don't require reboot or a terminal:
 *   - `cleanupStaleCapsLockRemap()` runs at every runwa launch and does a
 *     surgical clean-up when we detect our specific mapping as the only
 *     one configured.
 *   - `resetCapsLockRemap()` is wired to a tray menu action — the user's
 *     escape hatch when the surgical path refuses to touch state (e.g.,
 *     because another tool's mapping is also present).
 */

// HID Usage Page 0x07 (Keyboard/Keypad), usage 0x39 = CapsLock.
const HID_USAGE_CAPS_LOCK = '30064771129'
// HID Usage Page 0x07, usage 0x6E = Keyboard F19.
const HID_USAGE_F19 = '30064771182'

const HIDUTIL = '/usr/bin/hidutil'

function currentMapping(): string | null {
  try {
    return execFileSync(HIDUTIL, ['property', '--get', 'UserKeyMapping'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    console.warn('[keyboard-remap] hidutil get failed:', err)
    return null
  }
}

function clearMapping(): void {
  try {
    execFileSync(HIDUTIL, ['property', '--set', '{"UserKeyMapping":[]}'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (err) {
    console.warn('[keyboard-remap] hidutil clear failed:', err)
  }
}

/**
 * Surgical self-heal: only acts when our specific CapsLock→F19 mapping is
 * present AND it's the only entry. Coexisting third-party mappings are
 * left alone — the user would rather see a log line than have another
 * tool's config silently wiped.
 */
export function cleanupStaleCapsLockRemap(): void {
  if (process.platform !== 'darwin') return
  const mapping = currentMapping()
  if (!mapping) return

  const hasOurPair =
    mapping.includes(HID_USAGE_CAPS_LOCK) && mapping.includes(HID_USAGE_F19)
  if (!hasOurPair) return

  // Count total entries via the Src marker; each entry emits exactly one.
  const entryCount = (mapping.match(/HIDKeyboardModifierMappingSrc/g) || []).length
  if (entryCount === 1) {
    clearMapping()
    console.log('[keyboard-remap] cleared stale CapsLock→F19 hidutil mapping')
    return
  }

  console.warn(
    '[keyboard-remap] stale CapsLock→F19 hidutil mapping detected, but ' +
      `${entryCount - 1} other mapping(s) also present — leaving alone to ` +
      'avoid clobbering. Use Tray → "Reset CapsLock HID remap" to force.'
  )
}

/**
 * Blunt reset: clears ALL hidutil user mappings unconditionally. Wired to
 * the tray menu item for post-crash recovery — the user explicitly asks,
 * so the minor collateral damage to other hidutil-based tools is accepted.
 */
export function resetCapsLockRemap(): void {
  if (process.platform !== 'darwin') return
  clearMapping()
  console.log('[keyboard-remap] hidutil UserKeyMapping cleared via tray')
}
