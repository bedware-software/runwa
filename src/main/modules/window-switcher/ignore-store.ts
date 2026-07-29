import { randomUUID } from 'node:crypto'
import Store from 'electron-store'
import type { NewWindowIgnoreRule, WindowIgnoreRule } from '@shared/types'

interface PersistedShape {
  rules: WindowIgnoreRule[]
}

export const MAX_IGNORE_RULES = 500
export const MAX_IGNORE_FIELD_LENGTH = 512
const MAX_IGNORE_RULE_ID_LENGTH = 200

/**
 * Compile an ignore-rule field into an anchored, case-insensitive RegExp.
 * Everything is escaped except `*`, which becomes `.*` — window titles are
 * full of regex metacharacters (`Telegram (26011)`, `C:\dev — Code`) and a
 * user typing one must not accidentally author a pattern.
 *
 * The wildcard exists because titles aren't always stable: a chat app's
 * unread badge (`Telegram (26011)`) or a document name changes between
 * sessions, so `Telegram*` is the rule that keeps working.
 */
const globCache = new Map<string, RegExp>()

function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern)
  if (cached) return cached
  const source = `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`
  const compiled = new RegExp(source, 'i')
  // The cache is keyed by user-authored patterns, so it's naturally tiny.
  // The bound is only there so a corrupted store can't grow it without end.
  if (globCache.size > MAX_IGNORE_RULES * 2) globCache.clear()
  globCache.set(pattern, compiled)
  return compiled
}

function fieldMatches(pattern: string, value: string): boolean {
  // An empty field is the "any" wildcard — that's what makes a
  // process-only rule ({ title: '', processName: 'ktalk.exe' }) hide every
  // window of an app.
  if (pattern === '') return true
  return globToRegExp(pattern).test(value.trim())
}

/**
 * True when the window should be hidden from the switcher. `title` and
 * `processName` must be the values the palette actually renders (i.e. after
 * window-switcher's blank-title → process-name fallback), because those are
 * what the user saw when they created the rule.
 */
export function isWindowIgnored(
  rules: WindowIgnoreRule[],
  title: string,
  processName: string
): boolean {
  for (const rule of rules) {
    // Defensive: sanitiseRules already drops match-everything rules.
    if (rule.title === '' && rule.processName === '') continue
    if (
      fieldMatches(rule.title, title) &&
      fieldMatches(rule.processName, processName)
    ) {
      return true
    }
  }
  return false
}

/** Normalised comparison key — used for duplicate detection on add and for
 * collapsing duplicates out of a hand-edited file. */
function ruleKey(rule: NewWindowIgnoreRule): string {
  return `${rule.title.toLowerCase()}\u0000${rule.processName.toLowerCase()}`
}

function parseNewRule(value: unknown): NewWindowIgnoreRule {
  if (typeof value !== 'object' || value === null) {
    throw new Error('A window title or an executable name is required.')
  }
  const candidate = value as { title?: unknown; processName?: unknown }
  const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
  const processName =
    typeof candidate.processName === 'string' ? candidate.processName.trim() : ''

  if (!title && !processName) {
    throw new Error('A window title or an executable name is required.')
  }
  if (
    title.length > MAX_IGNORE_FIELD_LENGTH ||
    processName.length > MAX_IGNORE_FIELD_LENGTH
  ) {
    throw new Error(
      `Titles and executable names can be at most ${MAX_IGNORE_FIELD_LENGTH} characters.`
    )
  }
  return { title, processName }
}

/** Drop malformed hand-edited entries before they reach the matcher. A rule
 * with both fields empty would hide every window, so it's discarded rather
 * than honoured. */
function sanitiseRules(value: unknown): WindowIgnoreRule[] {
  if (!Array.isArray(value)) return []
  const rules: WindowIgnoreRule[] = []
  const seenIds = new Set<string>()
  const seenKeys = new Set<string>()
  for (const entry of value) {
    if (rules.length >= MAX_IGNORE_RULES) break
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as {
      id?: unknown
      title?: unknown
      processName?: unknown
    }
    if (typeof candidate.id !== 'string') continue
    const id = candidate.id.trim()
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : ''
    const processName =
      typeof candidate.processName === 'string' ? candidate.processName.trim() : ''
    const key = ruleKey({ title, processName })
    if (
      !id ||
      id.length > MAX_IGNORE_RULE_ID_LENGTH ||
      (!title && !processName) ||
      title.length > MAX_IGNORE_FIELD_LENGTH ||
      processName.length > MAX_IGNORE_FIELD_LENGTH ||
      seenIds.has(id) ||
      seenKeys.has(key)
    ) {
      continue
    }
    seenIds.add(id)
    seenKeys.add(key)
    rules.push({ id, title, processName })
  }
  return rules
}

/**
 * Window Switcher ignore list. Lives in its own store file rather than the
 * module's `config` bag because the generic module-config schema is
 * scalar-only, and because this list is read on every keystroke of a
 * switcher search — keeping it out of the settings payload avoids
 * rebroadcasting it to every renderer whenever an unrelated setting changes.
 */
class WindowIgnoreStore {
  private store: Store<PersistedShape> | null = null
  /** Snapshot handed to `search()` so a palette keystroke doesn't hit disk.
   * Invalidated on every write. */
  private cached: WindowIgnoreRule[] | null = null

  init(): void {
    if (this.store) return
    this.store = new Store<PersistedShape>({
      name: 'runwa-window-switcher-ignore',
      defaults: { rules: [] }
    })
  }

  private ensureInit(): Store<PersistedShape> {
    if (!this.store) throw new Error('WindowIgnoreStore used before init()')
    return this.store
  }

  list(): WindowIgnoreRule[] {
    if (!this.cached) {
      this.cached = sanitiseRules(this.ensureInit().store.rules)
    }
    return this.cached.map((rule) => ({ ...rule }))
  }

  /**
   * Read path for the hot search loop — returns the shared array instead of
   * cloning it. Callers must treat the result as read-only.
   */
  listForMatching(): WindowIgnoreRule[] {
    if (!this.cached) {
      this.cached = sanitiseRules(this.ensureInit().store.rules)
    }
    return this.cached
  }

  add(value: unknown): WindowIgnoreRule[] {
    const nextRule = parseNewRule(value)
    const rules = this.list()
    if (rules.length >= MAX_IGNORE_RULES) {
      throw new Error(`You can save up to ${MAX_IGNORE_RULES} ignore rules.`)
    }
    const key = ruleKey(nextRule)
    if (rules.some((rule) => ruleKey(rule) === key)) {
      throw new Error('That rule is already in the ignore list.')
    }
    rules.push({ id: randomUUID(), ...nextRule })
    this.write(rules)
    return rules.map((rule) => ({ ...rule }))
  }

  remove(ruleId: unknown): WindowIgnoreRule[] {
    if (typeof ruleId !== 'string' || !ruleId.trim()) {
      throw new Error('A valid rule id is required.')
    }
    const id = ruleId.trim()
    if (id.length > MAX_IGNORE_RULE_ID_LENGTH) {
      throw new Error('A valid rule id is required.')
    }
    const rules = this.list().filter((rule) => rule.id !== id)
    this.write(rules)
    return rules.map((rule) => ({ ...rule }))
  }

  private write(rules: WindowIgnoreRule[]): void {
    this.ensureInit().store = { rules }
    this.cached = rules.map((rule) => ({ ...rule }))
  }
}

export const windowIgnoreStore = new WindowIgnoreStore()
