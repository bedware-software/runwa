import { moduleRegistry } from './registry'
import { createWindowSwitcherModule } from './window-switcher'

/**
 * Hard-coded module registration. Adding a new module is a one-file change:
 *   1. Create src/main/modules/<id>/index.ts exporting a factory
 *   2. Import it here and call moduleRegistry.register(...)
 *
 * Iteration 1 ships just window-switcher.
 */
export async function registerModules(): Promise<void> {
  moduleRegistry.register(createWindowSwitcherModule())
  // Future: apps, files, calculator, clipboard, web search, …
}
