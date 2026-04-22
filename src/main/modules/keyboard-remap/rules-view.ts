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
  for (const [name, block] of Object.entries(cfg as Record<string, unknown>)) {
    if (!block || typeof block !== 'object') continue
    const view = readTriggerBlock(name, block as Record<string, unknown>)
    if (view) triggers.push(view)
  }

  return { filePath, triggers }
}

function readTriggerBlock(
  name: string,
  block: Record<string, unknown>
): KeyboardRemapTriggerView | null {
  const onTap = formatTapSpec(block['on_tap'])
  const hold = readHoldSpec(name, block['on_hold'])

  return {
    name: displayTriggerName(name),
    onTap,
    onHoldKind: hold.kind,
    onHoldModifier: hold.modifier,
    combos: hold.combos
  }
}

function displayTriggerName(raw: string): string {
  const lower = raw.toLowerCase()
  switch (lower) {
    case 'capslock':
    case 'caps_lock':
    case 'caps-lock':
      return 'CapsLock'
    case 'pageup':
    case 'pgup':
      return 'PgUp'
    case 'pagedown':
    case 'pgdn':
    case 'pgdown':
      return 'PgDn'
    default:
      return capitalize(raw)
  }
}

function formatTapSpec(raw: unknown): string | undefined {
  if (raw == null) return undefined
  if (typeof raw === 'string') return formatTokenList([raw])
  if (Array.isArray(raw)) return formatTokenList(raw.map(String))
  return String(raw)
}

interface HoldResult {
  kind: 'transparent' | 'explicit' | 'passthrough'
  /** Populated for `transparent`. Raw modifier name ("Ctrl") so the
   *  renderer can chip-render it alongside the "(transparent layer)"
   *  caption, same way config mirrors what's in the YAML. */
  modifier?: string
  /** Populated for `explicit`. Includes any `_default` row — the view
   *  follows the YAML 1:1 so users see the same list they wrote. */
  combos?: KeyboardRemapTriggerView['combos']
}

function readHoldSpec(triggerName: string, raw: unknown): HoldResult {
  if (raw == null) {
    return { kind: 'passthrough' }
  }
  if (typeof raw === 'string') {
    return { kind: 'transparent', modifier: formatModifier(raw) }
  }
  if (!Array.isArray(raw)) {
    return { kind: 'passthrough' }
  }
  // A list of plain strings is the transparent-modifier shape
  // (`on_hold: [ctrl]`), not a rules list. Render the single entry as a
  // chip-able modifier name; the multi-element shape is rejected by the
  // Rust parser so we only handle length-1 here.
  if (raw.length > 0 && raw.every((e) => typeof e === 'string')) {
    const names = (raw as string[]).map(formatModifier).join('+')
    return { kind: 'transparent', modifier: names }
  }

  const combos: NonNullable<HoldResult['combos']> = []

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const keys = e['keys']
    const to = e['to_hotkey']
    const desc = typeof e['description'] === 'string' ? (e['description'] as string) : undefined
    const os = typeof e['os'] === 'string' ? (e['os'] as string) : undefined

    if (!Array.isArray(keys) || keys.length === 0) continue
    // Last element is the trigger key; any preceding elements are required
    // modifier prefixes (`keys: [shift, 1]` → modifiers = [shift], key = 1).
    const triggerKey = String(keys[keys.length - 1])
    const modifierPrefix = keys.slice(0, -1).map(String)

    const resultStr = formatRuleAction(e, to)

    // The fallback-combo sentinel (`any`, or the legacy `_default`) is
    // kept as a regular combo row so the UI mirrors the YAML file's
    // order and shape — no hidden "fallback: X" summary, just the same
    // list the user wrote.
    const triggerKeyLower = triggerKey.toLowerCase()
    const isDefault = triggerKeyLower === 'any' || triggerKeyLower === '_default'
    const chord = isDefault
      ? '…'
      : formatTokenList([...modifierPrefix, triggerKey])
    const triggerLabel = `${displayTriggerName(triggerName)}+${chord}`

    combos.push({
      trigger: triggerLabel,
      result: resultStr,
      description: desc,
      os
    })
  }

  return { kind: 'explicit', combos }
}

function formatRuleAction(
  entry: Record<string, unknown>,
  toHotkey: unknown
): string {
  const sw = entry['switch_to_workspace']
  if (typeof sw === 'number') return `switch to Desktop ${sw}`
  const mv = entry['move_to_workspace']
  if (typeof mv === 'number') return `move to Desktop ${mv}`
  if (typeof toHotkey === 'string') return formatTokenList([toHotkey])
  if (Array.isArray(toHotkey)) return formatTokenList(toHotkey.map(String))
  return '?'
}

// rules-view.ts emits platform-neutral English token names joined with `+`
// ("Space+Shift+1", "Ctrl+Alt+S"). Platform-specific display (mac glyphs,
// chip-per-key rendering) happens in the renderer's `lib/hotkey-display.ts`
// so the same conversion runs for every hotkey surface (palette footer,
// HotkeyRecorder, per-module hotkeys, keyboard-remap rules).

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
