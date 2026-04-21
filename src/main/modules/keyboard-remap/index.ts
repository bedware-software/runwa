import type { ModuleManifest } from '@shared/types'
import type { PaletteModule } from '../types'
import { keyboardRemapService } from './service'

const MANIFEST: ModuleManifest = {
  id: 'keyboard-remap',
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
