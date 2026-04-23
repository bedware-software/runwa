/**
 * Parse the hotstrings config textarea into a list of (trigger, replacement)
 * pairs.
 *
 * Syntax, one rule per line:
 *   trigger -> replacement
 *
 * Rules:
 *   - Lines starting with `#` or `//` are comments.
 *   - Blank lines are ignored.
 *   - The separator is the first `->` on the line — anything to the left is
 *     the trigger, anything to the right is the replacement. Whitespace
 *     around the separator is trimmed.
 *   - An empty trigger or a line without `->` is skipped silently (the
 *     settings panel shows a live preview so users see when a rule didn't
 *     parse).
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
}

const SEPARATOR = '->'

export function parseHotstringRules(raw: string | undefined): HotstringRule[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const byTrigger = new Map<string, string>()
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('#') || line.startsWith('//')) continue
    const idx = line.indexOf(SEPARATOR)
    if (idx < 0) continue
    const trigger = line.slice(0, idx).trim()
    const replacement = line.slice(idx + SEPARATOR.length).trim()
    if (trigger === '') continue
    byTrigger.set(trigger, replacement)
  }
  const rules: HotstringRule[] = []
  for (const [trigger, replacement] of byTrigger.entries()) {
    rules.push({ trigger, replacement })
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
