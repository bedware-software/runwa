import type { UlanziProfileSummary } from './types'

export const ULANZI_ID = 'ulanzi'

/**
 * Module config key holding the per-profile overrides as a JSON object
 * string. The module config bag only stores scalars, and the set of
 * profiles is owned by Ulanzi Studio rather than by a fixed schema, so the
 * whole map travels as one value.
 */
export const ULANZI_PROFILES_KEY = 'profiles'

/** Lifetime of a hint for a profile that does not stay on screen. */
export const ULANZI_BRIEF_HINT_MS = 1500

/**
 * How the Desktop Hint treats one profile:
 *   - `auto`   sticky for a profile bound to no app (a "mode" the user
 *              toggles from the device, like "Newbro Tabs"), brief for the
 *              per-app profiles Ulanzi Studio switches to on its own
 *   - `brief`  shown for ULANZI_BRIEF_HINT_MS
 *   - `sticky` shown until another profile becomes active
 *   - `hidden` never shown; switching to it clears a sticky hint
 */
export type UlanziProfileDisplay = 'auto' | 'brief' | 'sticky' | 'hidden'
export type UlanziResolvedDisplay = Exclude<UlanziProfileDisplay, 'auto'>

export const ULANZI_PROFILE_DISPLAYS: readonly UlanziProfileDisplay[] = [
  'auto',
  'brief',
  'sticky',
  'hidden'
]

export interface UlanziProfileRule {
  /** Text shown instead of the profile name. Empty = the name itself. */
  label: string
  display: UlanziProfileDisplay
}

/** Overrides keyed by the exact profile name Ulanzi Studio reports. */
export type UlanziProfileRules = Record<string, UlanziProfileRule>

const DEFAULT_RULE: UlanziProfileRule = { label: '', display: 'auto' }

function isDisplay(value: unknown): value is UlanziProfileDisplay {
  return ULANZI_PROFILE_DISPLAYS.includes(value as UlanziProfileDisplay)
}

/**
 * Read the overrides out of the opaque module config bag. Anything
 * malformed (hand-edited settings, a value from a newer build) is dropped
 * entry by entry so one bad row never silences every hint.
 */
export function readUlanziProfileRules(
  values: Record<string, unknown> | undefined
): UlanziProfileRules {
  const raw = values?.[ULANZI_PROFILES_KEY]
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}

  const rules: UlanziProfileRules = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    rules[name] = {
      label: typeof entry.label === 'string' ? entry.label : '',
      display: isDisplay(entry.display) ? entry.display : 'auto'
    }
  }
  return rules
}

export function ulanziProfileRule(
  rules: UlanziProfileRules,
  name: string
): UlanziProfileRule {
  return rules[name] ?? DEFAULT_RULE
}

/**
 * Serialize for storage, leaving out rows that only restate the defaults so
 * the stored value stays a list of what the user actually changed.
 */
export function serializeUlanziProfileRules(rules: UlanziProfileRules): string {
  const out: Record<string, Partial<UlanziProfileRule>> = {}
  for (const name of Object.keys(rules).sort()) {
    const rule = rules[name]
    const label = rule.label.trim()
    if (!label && rule.display === 'auto') continue
    out[name] = {
      ...(label ? { label } : {}),
      ...(rule.display !== 'auto' ? { display: rule.display } : {})
    }
  }
  return JSON.stringify(out)
}

/**
 * Pick the effective behaviour for a profile. A profile Runwa could not
 * find a manifest for is treated as app-bound: a brief hint is the safe
 * default when we can't tell whether it's a mode.
 */
export function resolveUlanziDisplay(
  rule: UlanziProfileRule,
  profile: UlanziProfileSummary | undefined
): UlanziResolvedDisplay {
  if (rule.display !== 'auto') return rule.display
  return profile && profile.app === null ? 'sticky' : 'brief'
}
