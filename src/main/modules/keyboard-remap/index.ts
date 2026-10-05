import type { ModuleManifest } from '@shared/types'
import type { PaletteModule } from '../types'
import { KEYBOARD_REMAP_ID } from '@shared/keyboard-remap'
import {
  keyboardRemapService,
  WORKSPACE_BACK_AND_FORTH_DEFAULT,
  WORKSPACE_BACK_AND_FORTH_KEY
} from './service'

const MANIFEST: ModuleManifest = {
  id: KEYBOARD_REMAP_ID,
  name: 'Keyboard Remap',
  icon: 'keyboard',
  kind: 'service',
  description:
    'System-wide keyboard layer. CapsLock → Ctrl (tap = Escape); Space → modifier layer (tap = space). Mirrors AutoHotkey / Karabiner-Elements basics in one cross-platform place.',
  defaultEnabled: true,
  supportsDirectLaunch: false,
  // Rules file (path, edit, reload, parsed hotkey list) is rendered by a
  // dedicated KeyboardRemapSection in the renderer. The config schema below
  // only covers toggles that fit the generic checkbox/radio/text fields.
  configFields: [
    {
      type: 'checkbox',
      key: 'showDesktopNumberInTray',
      label: 'Show virtual-desktop number in tray icon',
      description:
        'Replaces the tray icon with a numbered glyph reflecting the current virtual desktop. Windows uses the real desktop ordinal; on macOS there is no public Space ordinal so the number stays at 1.',
      defaultValue: true
    },
    {
      type: 'checkbox',
      key: WORKSPACE_BACK_AND_FORTH_KEY,
      label: 'Switching to the current desktop jumps to the previous one',
      description:
        'When on, a switch_to_workspace rule fired while you are already on that desktop flips back to the desktop you came from, so tapping the same key toggles between your last two desktops. When off, it stays put — use an alternate_workspace rule for the toggle instead.',
      defaultValue: WORKSPACE_BACK_AND_FORTH_DEFAULT
    }
  ]
}

export const SHOW_DESKTOP_NUMBER_IN_TRAY_KEY = 'showDesktopNumberInTray'
export const SHOW_DESKTOP_NUMBER_IN_TRAY_DEFAULT = true

export function createKeyboardRemapModule(): PaletteModule {
  return {
    manifest: MANIFEST,

    // The module isn't searchable — it's a background service whose only
    // user-facing surface is settings.
    async search() {
      return []
    },

    async execute() {
      return { dismissPalette: false }
    },

    async onAction(key) {
      if (key === 'openRules') {
        await keyboardRemapService.openRulesInEditor()
      }
    }
  }
}
