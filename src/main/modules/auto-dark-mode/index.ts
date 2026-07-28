import type { ModuleManifest } from '@shared/types'
import {
  AUTO_DARK_MODE_DARK_TIME_KEY,
  AUTO_DARK_MODE_ID,
  AUTO_DARK_MODE_LIGHT_TIME_KEY,
  AUTO_DARK_MODE_MODE_KEY,
  DEFAULT_AUTO_DARK_MODE_CONFIG
} from '@shared/auto-dark-mode'
import type { PaletteModule } from '../types'

const MANIFEST: ModuleManifest = {
  id: AUTO_DARK_MODE_ID,
  name: 'Auto Dark Mode',
  icon: 'sun-moon',
  kind: 'service',
  description:
    'Switches the Windows or macOS system appearance between light and dark, either manually or at two local times each day.',
  defaultEnabled: true,
  supportsDirectLaunch: false,
  // AutoDarkModeSection renders these three values as a compact segmented
  // mode control plus native time inputs. Keeping them in the manifest still
  // lets the registry seed/backfill defaults through the normal module
  // persistence path.
  configFields: [
    {
      type: 'radio',
      key: AUTO_DARK_MODE_MODE_KEY,
      label: 'Mode',
      description:
        'Scheduled follows the two times below. Manual changes only when you run Toggle Theme.',
      defaultValue: DEFAULT_AUTO_DARK_MODE_CONFIG.mode,
      options: [
        { value: 'scheduled', label: 'Scheduled' },
        { value: 'manual', label: 'Manual' }
      ]
    },
    {
      type: 'text',
      key: AUTO_DARK_MODE_LIGHT_TIME_KEY,
      label: 'Light theme starts',
      defaultValue: DEFAULT_AUTO_DARK_MODE_CONFIG.lightTime
    },
    {
      type: 'text',
      key: AUTO_DARK_MODE_DARK_TIME_KEY,
      label: 'Dark theme starts',
      defaultValue: DEFAULT_AUTO_DARK_MODE_CONFIG.darkTime
    }
  ]
}

export function createAutoDarkModeModule(): PaletteModule {
  return {
    manifest: MANIFEST,

    // Background service only. Its two user-facing actions live in the
    // Command Palette, while lifecycle/scheduling is owned by service.ts.
    async search() {
      return []
    },

    async execute() {
      return { dismissPalette: false }
    }
  }
}
