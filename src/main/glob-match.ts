/**
 * Anchored, case-insensitive glob matching for the small user-authored
 * patterns runwa stores: Window Switcher ignore rules and User Command app
 * scopes.
 *
 * Everything is escaped except `*`, which becomes `.*`. The values these
 * patterns run against — window titles, executable paths — are full of regex
 * metacharacters (`Telegram (26011)`, `C:\dev — Code`), so a user typing one
 * must never accidentally author a pattern.
 *
 * The wildcard exists because those values aren't always stable: a chat app's
 * unread badge (`Telegram (26011)`) or a document name changes between
 * sessions, so `Telegram*` is the rule that keeps working.
 */

const MAX_CACHED_PATTERNS = 1000

const globCache = new Map<string, RegExp>()

export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern)
  if (cached) return cached
  const source = `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`
  const compiled = new RegExp(source, 'i')
  // The cache is keyed by user-authored patterns, so it's naturally tiny.
  // The bound is only there so a corrupted store can't grow it without end.
  if (globCache.size > MAX_CACHED_PATTERNS) globCache.clear()
  globCache.set(pattern, compiled)
  return compiled
}

/**
 * True when `value` matches `pattern`. An empty pattern is the "any"
 * wildcard — that's what makes a process-only ignore rule
 * ({ title: '', processName: 'ktalk.exe' }) hide every window of an app.
 * Callers that treat "empty" as something other than "match everything"
 * must check for it before calling.
 */
export function globMatches(pattern: string, value: string): boolean {
  if (pattern === '') return true
  return globToRegExp(pattern).test(value.trim())
}
