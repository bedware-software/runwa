import { moduleRegistry } from './registry'
import { createWindowSwitcherModule } from './window-switcher'
import { createGroqSttModule } from './groq-stt'

/**
 * Hard-coded module registration. Adding a new module is a one-file change:
 *   1. Create src/main/modules/<id>/index.ts exporting a factory
 *   2. Import it here and call moduleRegistry.register(...)
 */
export async function registerModules(): Promise<void> {
  moduleRegistry.register(createWindowSwitcherModule())
  moduleRegistry.register(createGroqSttModule())
  // Future: apps, files, calculator, clipboard, web search, …
}
