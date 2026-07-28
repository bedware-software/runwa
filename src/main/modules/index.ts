import { moduleRegistry } from './registry'
import { createWindowSwitcherModule } from './window-switcher'
import { createAppSearchModule } from './app-search'
import { createCommandPaletteModule } from './command-palette'
import { createKeyboardRemapModule } from './keyboard-remap'
import { createGroqSttModule } from './groq-stt'
import { createHotstringsModule } from './hotstrings'
import { createFlashcardsModule } from './flashcards'
import { createUserCommandsModule } from './user-commands'
import { createAutoDarkModeModule } from './auto-dark-mode'

/**
 * Hard-coded module registration. Adding a new module is a one-file change:
 *   1. Create src/main/modules/<id>/index.ts exporting a factory
 *   2. Import it here and call moduleRegistry.register(...)
 *
 * Registration order is what both the palette home-screen picker and the
 * settings sidebar show. User-facing launchers first (app-search,
 * window-switcher, command-palette), then the background services
 * (keyboard-remap, hotstrings), then settings-only / hotkey utilities
 * (user-commands, auto-dark-mode, groq-stt) in the Other group.
 */
export async function registerModules(): Promise<void> {
  // Instantiate the non-command-palette modules first so we can harvest
  // their manifest identity (id, name, icon) for the Command Palette's
  // per-module "Open <Module> Settings" deep-link commands. The palette
  // adds itself to that list inside its factory.
  const appSearch = createAppSearchModule()
  const windowSwitcher = createWindowSwitcherModule()
  const userCommands = createUserCommandsModule()
  const flashcards = createFlashcardsModule()
  const keyboardRemap = createKeyboardRemapModule()
  const hotstrings = createHotstringsModule()
  const groqStt = createGroqSttModule()
  const autoDarkMode = createAutoDarkModeModule()

  const otherModules = [
    appSearch,
    windowSwitcher,
    userCommands,
    flashcards,
    keyboardRemap,
    hotstrings,
    autoDarkMode,
    groqStt
  ].map((m) => ({
    id: m.manifest.id,
    name: m.manifest.name,
    icon: m.manifest.icon
  }))

  const commandPalette = createCommandPaletteModule(otherModules)

  moduleRegistry.register(appSearch)
  moduleRegistry.register(windowSwitcher)
  moduleRegistry.register(commandPalette)
  moduleRegistry.register(userCommands)
  moduleRegistry.register(flashcards)
  moduleRegistry.register(keyboardRemap)
  moduleRegistry.register(hotstrings)
  moduleRegistry.register(autoDarkMode)
  moduleRegistry.register(groqStt)
  // Future: files, calculator, clipboard, web search, …
}
