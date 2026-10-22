import type { ModuleManifest } from '@shared/types'
import { ULANZI_ID, ULANZI_PROFILES_KEY } from '@shared/ulanzi'
import type { PaletteModule } from '../types'

/**
 * Ulanzi — shows which Ulanzi Studio profile is active, in the shared
 * Desktop Hint, for decks without a screen (the Vibe Key).
 *
 * Service-kind module: no palette presence. Watching the log and showing
 * hints is owned by service.ts, started from src/main/index.ts; the
 * per-profile table in Settings is UlanziSection, which edits the single
 * JSON config value declared below.
 */

const MANIFEST: ModuleManifest = {
  id: ULANZI_ID,
  name: 'Ulanzi',
  icon: 'layers',
  kind: 'service',
  description:
    'Shows the active Ulanzi Studio profile at the bottom of the screen whenever it changes. Mode profiles stay on screen while they are active.',
  defaultEnabled: false,
  supportsDirectLaunch: false,
  // UlanziSection renders this with a purpose-built per-profile table;
  // declaring it here keeps default seeding on the normal module path.
  configFields: [
    {
      type: 'text',
      key: ULANZI_PROFILES_KEY,
      label: 'Profiles',
      defaultValue: '{}'
    }
  ]
}

export function createUlanziModule(): PaletteModule {
  return {
    manifest: MANIFEST,

    // Background service only — never surfaced in the palette picker.
    async search() {
      return []
    },

    async execute() {
      return { dismissPalette: false }
    }
  }
}
