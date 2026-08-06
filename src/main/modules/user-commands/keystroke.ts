import { acceleratorToKeyBinding, uiohookBridge } from '../groq-stt/uiohook-bridge'

/**
 * Keystroke user commands — "press this chord in whatever app I was just in".
 *
 * The action is a comma-separated sequence of Electron-style accelerators:
 *
 *   Ctrl+Shift+A          one chord
 *   Alt+Space, R          two steps, 60 ms apart (open the system menu, pick R)
 *   CmdOrCtrl+S           resolved per-platform at send time
 *
 * Parsing happens twice, deliberately:
 *  - `describeKeystrokeError` / `normaliseKeystrokeAction` validate and
 *    canonicalise at save time, without touching uiohook. That way a typo is
 *    reported in Settings rather than silently doing nothing later, even on
 *    machines where the native hook failed to load.
 *  - `sendKeystrokeAction` resolves the canonical text to real keycodes via
 *    `acceleratorToKeyBinding` at run time.
 *
 * Every canonical name below is one `acceleratorToKeyBinding` can resolve, so
 * anything that saves is something we can actually send.
 */

const MAX_STEPS = 8
const INTER_STEP_DELAY_MS = 60

/** Canonical modifier spellings, keyed by their lowercased synonyms. */
const MODIFIERS: Record<string, string> = {
  ctrl: 'Ctrl',
  control: 'Ctrl',
  alt: 'Alt',
  option: 'Alt',
  opt: 'Alt',
  shift: 'Shift',
  cmd: 'Cmd',
  command: 'Cmd',
  super: 'Cmd',
  meta: 'Cmd',
  win: 'Cmd',
  windows: 'Cmd',
  cmdorctrl: 'CmdOrCtrl',
  commandorcontrol: 'CmdOrCtrl'
}

/** Named (non-letter, non-digit, non-function) keys we can send. */
const NAMED_KEYS = [
  'Backspace',
  'Tab',
  'Enter',
  'CapsLock',
  'Escape',
  'Space',
  'PageUp',
  'PageDown',
  'End',
  'Home',
  'ArrowLeft',
  'ArrowUp',
  'ArrowRight',
  'ArrowDown',
  'Insert',
  'Delete',
  'NumLock',
  'ScrollLock',
  'PrintScreen',
  'Semicolon',
  'Equal',
  'Comma',
  'Minus',
  'Period',
  'Slash',
  'Backquote',
  'BracketLeft',
  'Backslash',
  'BracketRight',
  'Quote',
  'Numpad0',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9',
  'NumpadAdd',
  'NumpadSubtract',
  'NumpadMultiply',
  'NumpadDivide',
  'NumpadDecimal',
  'NumpadEnter'
]

/** Friendly spellings users reach for, mapped onto the canonical names. */
const KEY_SYNONYMS: Record<string, string> = {
  esc: 'Escape',
  return: 'Enter',
  del: 'Delete',
  ins: 'Insert',
  pgup: 'PageUp',
  pgdn: 'PageDown',
  pgdown: 'PageDown',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  plus: 'Equal',
  spacebar: 'Space'
}

const NAMED_KEYS_BY_LOWER = new Map(NAMED_KEYS.map((key) => [key.toLowerCase(), key]))

function canonicalKey(token: string): string | null {
  const lower = token.toLowerCase()
  if (/^[a-z]$/.test(lower)) return lower.toUpperCase()
  if (/^\d$/.test(lower)) return lower
  const fn = /^f(\d{1,2})$/.exec(lower)
  if (fn) {
    const num = Number(fn[1])
    return num >= 1 && num <= 24 ? `F${num}` : null
  }
  return KEY_SYNONYMS[lower] ?? NAMED_KEYS_BY_LOWER.get(lower) ?? null
}

interface ParsedKeystroke {
  /** Canonical accelerator per step, e.g. ['Alt+Space', 'R']. */
  steps: string[]
}

function parse(action: string): ParsedKeystroke | { error: string } {
  const rawSteps = action
    .split(',')
    .map((step) => step.trim())
    .filter(Boolean)

  if (rawSteps.length === 0) {
    return { error: 'Enter a shortcut such as “Ctrl+Shift+A”.' }
  }
  if (rawSteps.length > MAX_STEPS) {
    return { error: `A keystroke command can have at most ${MAX_STEPS} steps.` }
  }

  const steps: string[] = []
  for (const rawStep of rawSteps) {
    const tokens = rawStep
      .split('+')
      .map((token) => token.trim())
      .filter(Boolean)
    if (tokens.length === 0) {
      return { error: `“${rawStep}” is not a valid shortcut.` }
    }

    const modifiers: string[] = []
    let key: string | null = null
    for (const token of tokens) {
      const modifier = MODIFIERS[token.toLowerCase()]
      if (modifier) {
        if (!modifiers.includes(modifier)) modifiers.push(modifier)
        continue
      }
      if (key) {
        return {
          error: `“${rawStep}” has more than one key — separate steps with a comma.`
        }
      }
      key = canonicalKey(token)
      if (!key) {
        return { error: `“${token}” is not a key runwa can send.` }
      }
    }

    if (!key) {
      // Modifier-only steps can't be tapped: there's no key to press, and
      // holding a modifier across steps isn't something a one-shot command
      // can express.
      return { error: `“${rawStep}” needs a key besides the modifiers.` }
    }
    // Canonical order matches how the rest of runwa writes accelerators.
    const order = ['Ctrl', 'CmdOrCtrl', 'Cmd', 'Alt', 'Shift']
    modifiers.sort((a, b) => order.indexOf(a) - order.indexOf(b))
    steps.push([...modifiers, key].join('+'))
  }

  return { steps }
}

/** Human-readable reason the action isn't a valid keystroke, or null when
 * it is. Used by the store so Settings can show the problem inline. */
export function describeKeystrokeError(action: string): string | null {
  const parsed = parse(action)
  return 'error' in parsed ? parsed.error : null
}

/** Canonical spelling of a valid action ("ctrl+shift+a" → "Ctrl+Shift+A").
 * Returns the input untouched when it doesn't parse — callers validate
 * first. */
export function normaliseKeystrokeAction(action: string): string {
  const parsed = parse(action)
  return 'error' in parsed ? action.trim() : parsed.steps.join(', ')
}

/** Palette-facing description: "Sends Alt+Space then R". */
export function formatKeystrokeAction(action: string): string {
  const parsed = parse(action)
  return 'error' in parsed ? action : parsed.steps.join(' then ')
}

/**
 * Synthesise the sequence into whichever window currently has focus. The
 * caller is responsible for having handed focus back to the target app
 * first — see the user-command branch of the Command Palette's execute().
 *
 * Returns false when the native hook is unavailable or the action doesn't
 * resolve; later steps in a sequence are fired on a timer, so their failures
 * are logged rather than reported back.
 */
export function sendKeystrokeAction(action: string): boolean {
  const parsed = parse(action)
  if ('error' in parsed) {
    console.warn(`[user-commands] invalid keystroke action: ${parsed.error}`)
    return false
  }

  const bindings = parsed.steps.map((step) => acceleratorToKeyBinding(resolvePlatformModifiers(step)))
  if (bindings.some((binding) => binding === null)) {
    console.warn('[user-commands] keystroke action could not be resolved to keycodes')
    return false
  }

  const [first, ...rest] = bindings
  if (!uiohookBridge.simulateChord(first!)) return false
  rest.forEach((binding, index) => {
    setTimeout(() => {
      if (!uiohookBridge.simulateChord(binding!)) {
        console.warn('[user-commands] keystroke step failed')
      }
    }, INTER_STEP_DELAY_MS * (index + 1))
  })
  return true
}

/** `CmdOrCtrl` is stored verbatim so the same command reads correctly on
 * either OS; the split happens here, at send time. */
function resolvePlatformModifiers(step: string): string {
  return step.replace(/CmdOrCtrl/g, process.platform === 'darwin' ? 'Cmd' : 'Ctrl')
}
