import type { ModuleManifest } from '@shared/types'
import type { PaletteModule } from '../types'
import { keyboardRemapService } from './service'

const MANIFEST: ModuleManifest = {
  id: 'keyboard-remap',
  name: 'Keyboard Remap',
  icon: 'keyboard',
  description:
    'System-wide keyboard layer. CapsLock → Ctrl (tap = Escape); Space → modifier layer (tap = space). Mirrors AutoHotkey / Karabiner-Elements basics in one cross-platform place.',
  defaultEnabled: true,
  supportsDirectLaunch: false
  // Rules file (path, edit, reload, parsed hotkey list) is rendered by a
  // dedicated KeyboardRemapSection in the renderer — can't express in the
  // generic `configFields` schema.
}

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
