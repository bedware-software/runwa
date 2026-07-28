/**
 * Parse the hotstrings config textarea into a list of (trigger, replacement)
 * pairs.
 *
 * Syntax, one rule per line:
 *   trigger -> replacement   # paste mode (default)
 *   trigger => replacement   # clipboard mode — see below
 *
 * Rules:
 *   - Lines starting with `#` or `//` are comments.
 *   - Blank lines are ignored.
 *   - The separator is the *first* occurrence of either `->` or `=>` on
 *     the line. Whatever appears first wins; the second form, if any,
 *     becomes part of the replacement. Whitespace around the separator
 *     is trimmed.
 *   - `->` (paste mode): on match, runwa erases the trigger and synthesises
 *     Cmd+V (or Ctrl+V on Windows / Linux) so the replacement lands in
 *     the focused field.
 *   - `=>` (clipboard mode): on match, runwa erases the trigger and stages
 *     the replacement on the clipboard, then shows a Desktop Hint with the
 *     platform's paste shortcut. The user pastes manually wherever they
 *     actually need the text — typical use case is "type trigger in a
 *     normal field, then switch to a password field and paste there"
 *     (password fields ignore both typed triggers and synthetic paste, so
 *     a separate stage for them is the only thing that works).
 *   - An empty trigger or a line without either separator is skipped
 *     silently (the settings panel shows a live preview so users see
 *     when a rule didn't parse).
 *   - Duplicate triggers: the last occurrence wins. The matcher short-
 *     circuits at the longest suffix match, so the rule order in the file
 *     only matters for resolving duplicates, not length ordering.
 *
 * Triggers are matched as literal byte sequences. No regex, no wildcards —
 * AutoHotkey-style immediate triggers only. If the user wants fancy
 * matching they can compose multiple rules.
 */

export interface HotstringRule {
  trigger: string
  replacement: string
  /** When true, the service erases the trigger and stages the replacement
   *  on the clipboard, then shows the manual-paste Desktop Hint — instead
   *  of synthesising the platform paste shortcut. Set when the rule line
   *  uses `=>` as its separator
   *  instead of `->`. */
  clipboardOnly: boolean
}

const PASTE_SEPARATOR = '->'
const CLIPBOARD_SEPARATOR = '=>'

interface SeparatorMatch {
  start: number
  mode: 'paste' | 'clipboard'
}

/** Scan the line for the *first* separator, preferring whichever appears
 *  earlier. Returns null when neither is present. */
function findSeparator(line: string): SeparatorMatch | null {
  const pasteIdx = line.indexOf(PASTE_SEPARATOR)
  const clipboardIdx = line.indexOf(CLIPBOARD_SEPARATOR)
  if (pasteIdx < 0 && clipboardIdx < 0) return null
  if (clipboardIdx < 0) return { start: pasteIdx, mode: 'paste' }
  if (pasteIdx < 0) return { start: clipboardIdx, mode: 'clipboard' }
  return pasteIdx < clipboardIdx
    ? { start: pasteIdx, mode: 'paste' }
    : { start: clipboardIdx, mode: 'clipboard' }
}

export function parseHotstringRules(raw: string | undefined): HotstringRule[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const byTrigger = new Map<string, { replacement: string; clipboardOnly: boolean }>()
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('#') || line.startsWith('//')) continue
    const sep = findSeparator(line)
    if (!sep) continue
    const trigger = line.slice(0, sep.start).trim()
    // Both separators are exactly 2 chars long.
    const replacement = line.slice(sep.start + 2).trim()
    if (trigger === '') continue
    byTrigger.set(trigger, { replacement, clipboardOnly: sep.mode === 'clipboard' })
  }
  const rules: HotstringRule[] = []
  for (const [trigger, payload] of byTrigger.entries()) {
    rules.push({
      trigger,
      replacement: payload.replacement,
      clipboardOnly: payload.clipboardOnly
    })
  }
  return rules
}

/** Longest trigger first — lets the matcher pick the most specific suffix
 *  when two triggers share a common tail (e.g. `ok` and `kok`). */
export function sortRulesByTriggerLengthDesc(
  rules: HotstringRule[]
): HotstringRule[] {
  return rules.slice().sort((a, b) => b.trigger.length - a.trigger.length)
}
