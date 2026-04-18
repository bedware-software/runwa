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
  supportsDirectLaunch: false,
  configFields: [
    {
      key: 'openRules',
      type: 'action',
      label: 'Rules file',
      description:
        'Rules are stored as YAML at <userData>/keyboard-rules.yaml. The button opens the file in your system default editor. Restart runwa to apply changes.',
      buttonLabel: 'Edit rules'
    }
  ]
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
