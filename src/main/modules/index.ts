import { moduleRegistry } from './registry'
import { createWindowSwitcherModule } from './window-switcher'
import { createAppSearchModule } from './app-search'
import { createKeyboardRemapModule } from './keyboard-remap'
import { createGroqSttModule } from './groq-stt'
import { createHotstringsModule } from './hotstrings'

/**
 * Hard-coded module registration. Adding a new module is a one-file change:
 *   1. Create src/main/modules/<id>/index.ts exporting a factory
 *   2. Import it here and call moduleRegistry.register(...)
 *
 * Registration order is what both the palette home-screen picker and the
 * settings sidebar show. User-facing launchers first (app-search,
 * window-switcher), then the background services (keyboard-remap,
 * hotstrings), then the hotkey-only utility (groq-stt) at the bottom.
 */
export async function registerModules(): Promise<void> {
  moduleRegistry.register(createAppSearchModule())
  moduleRegistry.register(createWindowSwitcherModule())
  moduleRegistry.register(createKeyboardRemapModule())
  moduleRegistry.register(createHotstringsModule())
  moduleRegistry.register(createGroqSttModule())
  // Future: files, calculator, clipboard, web search, …
}
