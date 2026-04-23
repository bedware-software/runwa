import type { ModuleManifest } from '@shared/types'
import type { PaletteModule } from '../types'

/**
 * Hotstrings — an AutoHotkey-style snippet expander. The user configures a
 * list of `trigger -> replacement` lines in settings; any time the trigger
 * is typed in another application, runwa erases it and pastes the
 * replacement in its place.
 *
 * Service-kind module: no palette presence, no search. The settings panel
 * renders the usual per-module pane with a single multiline text field
 * that doubles as the rules source.
 *
 * Lifecycle (start, stop, reload on config change) is handled by
 * src/main/index.ts, mirroring the keyboard-remap service.
 */

const DEFAULT_RULES = [
  '# One rule per line, in the form: trigger -> replacement',
  '# Comments start with #. Empty lines are ignored.',
  "# Try typing one of these examples in any app (you won't see the trigger",
  '# once the replacement fires):',
  '',
  ';u -> bedware',
  'AFAIK -> as far as I know',
  'BRB -> be right back',
  'TY -> thank you'
].join('\n')

export const HOTSTRINGS_RULES_KEY = 'rules'

const MANIFEST: ModuleManifest = {
  id: 'hotstrings',
  name: 'Hotstrings',
  icon: 'replace',
  kind: 'service',
  description:
    'Expand typed shortcuts into longer text anywhere on your system. Type ";u" and get "bedware"; type "AFAIK" and get "as far as I know". Rules below — one per line.',
  defaultEnabled: false,
  supportsDirectLaunch: false,
  configFields: [
    {
      key: HOTSTRINGS_RULES_KEY,
      type: 'text',
      label: 'Rules',
      description:
        'One rule per line: `trigger -> replacement`. Trigger matching is case-sensitive and only fires when the character before the trigger is not a letter or digit, so e.g. `AFAIK` will not fire inside `SAFAIKY`. Comment lines start with `#`.',
      multiline: true,
      defaultValue: DEFAULT_RULES,
      placeholder: ';addr -> 1 Infinite Loop, Cupertino, CA'
    }
  ]
}

export function createHotstringsModule(): PaletteModule {
  return {
    manifest: MANIFEST,

    // Service-only — not surfaced in the palette picker, so search/execute
    // never run. Return stubs to satisfy the interface.
    async search() {
      return []
    },

    async execute() {
      return { dismissPalette: false }
    }
  }
}
