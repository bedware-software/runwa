import fs from 'fs'
import { parse as parseYaml } from 'yaml'
import type { KeyboardRemapRulesView, KeyboardRemapTriggerView } from '@shared/types'

/**
 * Parse the user's keyboard-rules.yaml into a display-ready structure.
 *
 * Mirrors the authoritative schema in `native/src/remap/rules.rs` — the Rust
 * side is what actually drives the hook, this is a best-effort read for the
 * settings UI. If the YAML is broken, `error` is populated and `triggers`
 * stays empty; the user can still hit Edit to fix it.
 */
export function buildRulesView(filePath: string): KeyboardRemapRulesView {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { filePath, triggers: [], error: 'rules file not found yet' }
    }
    return { filePath, triggers: [], error: `failed to read: ${err}` }
  }

  let cfg: unknown
  try {
    cfg = parseYaml(raw)
  } catch (err) {
    return { filePath, triggers: [], error: `YAML parse error: ${err}` }
  }

  if (cfg == null || typeof cfg !== 'object') {
    return { filePath, triggers: [] }
  }

  const triggers: KeyboardRemapTriggerView[] = []
  for (const key of ['capslock', 'space'] as const) {
    const block = (cfg as Record<string, unknown>)[key]
    if (!block || typeof block !== 'object') continue
    const view = readTriggerBlock(key, block as Record<string, unknown>)
    if (view) triggers.push(view)
  }

  return { filePath, triggers }
}

function readTriggerBlock(
  name: 'capslock' | 'space',
  block: Record<string, unknown>
): KeyboardRemapTriggerView | null {
  const toHotkey = block['to_hotkey']
  if (!toHotkey || typeof toHotkey !== 'object') return null
  const th = toHotkey as Record<string, unknown>

  const onTap = formatTapSpec(th['on_tap'])
  const hold = readHoldSpec(name, th['on_hold'])

  return {
    name: name === 'capslock' ? 'CapsLock' : 'Space',
    onTap,
    onHoldSummary: hold.summary,
    combos: hold.combos
  }
}

function formatTapSpec(raw: unknown): string | undefined {
  if (raw == null) return undefined
  if (typeof raw === 'string') return formatTokenList([raw])
  if (Array.isArray(raw)) return formatTokenList(raw.map(String))
  return String(raw)
}

interface HoldResult {
  summary: string
  combos?: KeyboardRemapTriggerView['combos']
}

function readHoldSpec(triggerName: string, raw: unknown): HoldResult {
  if (raw == null) {
    return { summary: 'passthrough' }
  }
  if (typeof raw === 'string') {
    return { summary: `${formatModifier(raw)} (transparent layer)` }
  }
  if (!Array.isArray(raw)) {
    return { summary: 'passthrough' }
  }

  const combos: NonNullable<HoldResult['combos']> = []
  let fallback: string | undefined
  let fallbackPlatform: string | undefined

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const keys = e['keys']
    const to = e['to_hotkey']
    const desc = typeof e['description'] === 'string' ? (e['description'] as string) : undefined
    const platform = typeof e['platform'] === 'string' ? (e['platform'] as string) : undefined

    if (!Array.isArray(keys) || keys.length === 0) continue
    const triggerKey = String(keys[0])

    const resultStr = formatRuleAction(e, to)

    if (triggerKey.toLowerCase() === '_default') {
      fallback = resultStr
      fallbackPlatform = platform
      continue
    }

    combos.push({
      trigger: `${capitalize(triggerName)}+${formatKey(triggerKey)}`,
      result: resultStr,
      description: desc,
      platform
    })
  }

  let summary = `explicit layer (${combos.length} ${combos.length === 1 ? 'rule' : 'rules'})`
  if (fallback) {
    const pfx = fallbackPlatform ? ` on ${fallbackPlatform}` : ''
    summary += ` · fallback ${fallback}${pfx}`
  }

  return { summary, combos }
}

function formatRuleAction(
  entry: Record<string, unknown>,
  toHotkey: unknown
): string {
  const sw = entry['switch_to_workspace']
  if (typeof sw === 'number') return `→ Desktop ${sw}`
  const mv = entry['move_to_workspace']
  if (typeof mv === 'number') return `→ move to Desktop ${mv}`
  if (typeof toHotkey === 'string') return formatTokenList([toHotkey])
  if (Array.isArray(toHotkey)) return formatTokenList(toHotkey.map(String))
  return '?'
}

function formatTokenList(tokens: string[]): string {
  return tokens.map(formatKey).join('+')
}

function formatKey(t: string): string {
  const mod = formatModifierName(t)
  if (mod) return mod
  const named = formatNamedKey(t)
  if (named) return named
  return t.length === 1 ? t.toUpperCase() : capitalize(t)
}

function formatNamedKey(s: string): string | null {
  switch (s.toLowerCase()) {
    case 'escape':
    case 'esc':
      return 'Esc'
    case 'space':
      return 'Space'
    case 'tab':
      return 'Tab'
    case 'enter':
    case 'return':
      return 'Enter'
    case 'delete':
    case 'backspace':
      return 'Backspace'
    case 'left':
      return 'Left'
    case 'right':
      return 'Right'
    case 'up':
      return 'Up'
    case 'down':
      return 'Down'
    case 'home':
      return 'Home'
    case 'end':
      return 'End'
    case 'pageup':
    case 'pgup':
      return 'PgUp'
    case 'pagedown':
    case 'pgdn':
    case 'pgdown':
      return 'PgDn'
    case 'backtick':
    case 'grave':
      return '`'
    case 'minus':
    case 'dash':
    case 'hyphen':
      return '-'
    case 'equals':
    case 'equal':
      return '='
    case 'lbracket':
    case 'leftbracket':
    case 'openbracket':
      return '['
    case 'rbracket':
    case 'rightbracket':
    case 'closebracket':
      return ']'
    case 'backslash':
      return '\\'
    case 'semicolon':
      return ';'
    case 'quote':
    case 'apostrophe':
      return "'"
    case 'comma':
      return ','
    case 'period':
    case 'dot':
      return '.'
    case 'slash':
    case 'forwardslash':
      return '/'
    default:
      if (/^f([1-9]|1[0-2])$/i.test(s)) return s.toUpperCase()
      return null
  }
}

function formatModifier(s: string): string {
  return formatModifierName(s) ?? capitalize(s)
}

function formatModifierName(s: string): string | null {
  switch (s.toLowerCase()) {
    case 'ctrl':
    case 'control':
      return 'Ctrl'
    case 'alt':
    case 'option':
    case 'opt':
      return 'Alt'
    case 'shift':
      return 'Shift'
    case 'cmd':
    case 'command':
    case 'meta':
      return 'Cmd'
    case 'win':
    case 'super':
      return 'Win'
    default:
      return null
  }
}

function capitalize(s: string): string {
  if (!s) return s
  return s[0].toUpperCase() + s.slice(1).toLowerCase()
}
