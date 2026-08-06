import type { ModuleManifest } from '@shared/types'
import type { PaletteModule } from '../types'

const MANIFEST: ModuleManifest = {
  id: 'user-commands',
  name: 'User Commands',
  icon: 'terminal',
  kind: 'service',
  description:
    'Create named actions that appear in the Command Palette — shell commands that run scripts or launch applications with arguments, and keystroke commands that press a shortcut in the app you were just in. Each command is either global or scoped to one application, in which case it is only listed while that app is focused.',
  defaultEnabled: true,
  supportsDirectLaunch: false
}

/**
 * Settings-only module. Its entries are deliberately contributed to the
 * existing Command Palette instead of opening a second, separate search
 * surface; the registry still requires service modules to implement the
 * search/execute contract, so both methods are inert here.
 */
export function createUserCommandsModule(): PaletteModule {
  return {
    manifest: MANIFEST,
    async search() {
      return []
    },
    async execute() {
      return { dismissPalette: false }
    }
  }
}
