import { clipboard } from 'electron'
import {
  isUiohookAvailable,
  simulatePaste,
  uiohookBridge
} from '../groq-stt/uiohook-bridge'
import { keycodeToChar } from './keymap'
import {
  parseHotstringRules,
  sortRulesByTriggerLengthDesc,
  type HotstringRule
} from './parser'

/**
 * Hotstring expander — AutoHotkey-style text snippet replacement.
 *
 * Flow:
 *   1. Subscribe to every global keydown event via `uiohookBridge`.
 *   2. Translate the keycode to a printable character (US-QWERTY mapping)
 *      and append it to a small ring buffer of recently-typed characters.
 *   3. Non-character keys (arrows, backspace, function keys, focus changes)
 *      reset the buffer so a pending trigger can't span unrelated edits.
 *   4. After each character lands, check whether the buffer's tail matches
 *      any configured trigger. On match, fire the replacement: synthesise
 *      N backspaces to erase the trigger, stash the replacement text in
 *      the clipboard, send Ctrl+V (or Cmd+V on macOS), and restore the
 *      previous clipboard value once the paste has had time to land.
 *
 * The replacement path is clipboard-based rather than synthesising each
 * character, because `uiohook-napi.keyTap` requires a reverse char→keycode
 * map that's just as layout-dependent as the inbound side. Clipboard-paste
 * is correct for every character and every layout, at the cost of briefly
 * clobbering the clipboard and relying on Ctrl+V being honoured by the
 * focused app.
 *
 * No-op when uiohook-napi isn't loaded (install failure, unsupported
 * platform) — the rest of runwa keeps working and the Settings panel is
 * expected to surface the "hook unavailable" hint separately.
 */

const BUFFER_LIMIT = 64
const CLIPBOARD_RESTORE_DELAY_MS = 120
const REPLACEMENT_QUIET_WINDOW_MS = 150

class HotstringService {
  private rules: HotstringRule[] = []
  private buffer = ''
  private unsubscribe: (() => void) | null = null
  private started = false
  private suppressUntil = 0

  /** Replace the active rule set. Called at service start and every time
   *  the config text changes in settings. Safe to call while running. */
  setRules(raw: string | undefined): void {
    this.rules = sortRulesByTriggerLengthDesc(parseHotstringRules(raw))
    // Drop any in-progress trigger match — the rule that would have fired
    // may no longer exist.
    this.buffer = ''
  }

  start(raw: string | undefined): void {
    if (this.started) return
    this.setRules(raw)
    if (this.rules.length === 0) {
      // Nothing to match against — don't spin up the global hook yet. A
      // later `setRules` call with content will trigger start via the
      // module's config-change handler.
      this.started = true
      return
    }
    if (!isUiohookAvailable()) {
      console.warn(
        '[hotstrings] uiohook-napi not available — hotstrings disabled. ' +
          'Run `npm install` / `npm rebuild uiohook-napi`.'
      )
      this.started = true
      return
    }
    this.unsubscribe = uiohookBridge.subscribeKeystrokes((e) => {
      this.onKey(e.keycode, e.shiftKey, e.ctrlKey, e.altKey, e.metaKey)
    })
    this.started = true
    console.log(`[hotstrings] started with ${this.rules.length} rule(s)`)
  }

  stop(): void {
    if (!this.started) return
    this.unsubscribe?.()
    this.unsubscribe = null
    this.buffer = ''
    this.started = false
  }

  /**
   * Settings-driven reconfigure. Called when the user edits the rules
   * textarea or toggles the module on/off. Re-parses the rules and
   * transitions the uiohook subscription to match the new state.
   */
  reconfigure(raw: string | undefined, enabled: boolean): void {
    if (!enabled) {
      this.stop()
      return
    }
    const wasStarted = this.started && this.unsubscribe !== null
    this.setRules(raw)
    if (this.rules.length === 0) {
      if (wasStarted) {
        this.unsubscribe?.()
        this.unsubscribe = null
      }
      this.started = true
      return
    }
    if (!wasStarted) {
      if (!isUiohookAvailable()) {
        this.started = true
        return
      }
      this.unsubscribe = uiohookBridge.subscribeKeystrokes((e) => {
        this.onKey(e.keycode, e.shiftKey, e.ctrlKey, e.altKey, e.metaKey)
      })
      this.started = true
    }
  }

  /**
   * Internal handler for a single keydown event. Exposed via `onKey` for
   * unit tests so the trigger-match logic can be exercised without the
   * uiohook plumbing.
   */
  onKey(
    keycode: number,
    shift: boolean,
    ctrl: boolean,
    alt: boolean,
    meta: boolean
  ): void {
    // During a replacement we synthesise backspaces and paste — those
    // events are visible to the subscriber, and would either poison the
    // buffer with the replacement text or loop. The quiet window blocks
    // all inbound events for a short spell after we fire a paste.
    if (Date.now() < this.suppressUntil) return

    // Any modifier-qualified keypress except plain Shift is almost certainly
    // a shortcut, not user typing — break the buffer and bail. This also
    // prevents Ctrl+Z, Alt+Tab, etc. from accidentally matching a trigger.
    if (ctrl || alt || meta) {
      this.buffer = ''
      return
    }

    const ch = keycodeToChar(keycode, shift)
    if (ch === null) {
      // Navigation / function / control key — reset so a pending trigger
      // doesn't carry across an arrow key or focus change.
      this.buffer = ''
      return
    }

    this.buffer = (this.buffer + ch).slice(-BUFFER_LIMIT)

    for (const rule of this.rules) {
      if (!this.buffer.endsWith(rule.trigger)) continue
      // Word-boundary guard: prevents a letter-prefixed trigger like
      // `AFAIK` from firing inside a longer typed word (e.g. `gAFAIK`).
      // Skipped when the trigger starts with a symbol — `;u` should still
      // fire in `word;u` because the `;` is itself a natural break.
      if (/[A-Za-z0-9]/.test(rule.trigger[0] ?? '')) {
        const beforeIdx = this.buffer.length - rule.trigger.length - 1
        if (beforeIdx >= 0 && /[A-Za-z0-9]/.test(this.buffer[beforeIdx] ?? '')) {
          continue
        }
      }
      this.fireReplacement(rule)
      return
    }
  }

  private fireReplacement(rule: HotstringRule): void {
    // Stamp the quiet window *before* we synthesise anything so inbound
    // events from the backspace / paste chord are ignored.
    this.suppressUntil = Date.now() + REPLACEMENT_QUIET_WINDOW_MS
    this.buffer = ''

    const saved = safeReadClipboard()
    try {
      // Erase the trigger characters the user just typed.
      uiohookBridge.simulateBackspaces(rule.trigger.length)
      clipboard.writeText(rule.replacement)
      if (!simulatePaste()) {
        // Paste failed — restore the clipboard immediately so the user
        // doesn't lose their previous clipboard contents for nothing.
        restoreClipboard(saved)
        return
      }
    } catch (err) {
      console.warn('[hotstrings] replacement failed:', err)
      restoreClipboard(saved)
      return
    }

    // Give the focused app time to process the paste before we put the
    // previous clipboard value back. Too short and some apps grab the
    // restored text instead; too long and the user might try to paste
    // manually and get the replacement a second time.
    setTimeout(() => restoreClipboard(saved), CLIPBOARD_RESTORE_DELAY_MS)
  }
}

function safeReadClipboard(): string | null {
  try {
    return clipboard.readText()
  } catch {
    return null
  }
}

function restoreClipboard(previous: string | null): void {
  if (previous === null) return
  try {
    clipboard.writeText(previous)
  } catch (err) {
    console.warn('[hotstrings] clipboard restore failed:', err)
  }
}

export const hotstringService = new HotstringService()
