import type { ModuleConfigValue, ModuleManifest, PaletteItem } from '@shared/types'

export interface SearchContext {
  /** Current config values for this module, already merged with defaults. */
  config: Record<string, ModuleConfigValue>
}

/**
 * PaletteModule interface.
 *
 * FIREWALL: This file is imported ONLY by code under src/main/modules/**.
 * Renderer and src/shared/** must never import it. Keeping main-internal
 * module types out of the IPC boundary is the ejection seat for future
 * module-system refactors — we can rewrite this interface without touching
 * the renderer.
 */
export interface PaletteModule {
  manifest: ModuleManifest

  /**
   * Return matches for a query. Items are returned WITHOUT `moduleId` — the
   * registry stamps it before merging, so modules can't lie about ownership.
   * Must honor the AbortSignal for long-running searches.
   */
  search(
    query: string,
    signal: AbortSignal,
    context: SearchContext
  ): Promise<Array<Omit<PaletteItem, 'moduleId'>>>

  /**
   * Execute a selected item. The item was serialized across IPC so the module
   * MUST re-validate `actionKind` and `action` before doing anything with them.
   */
  execute(item: PaletteItem): Promise<{ dismissPalette: boolean }>

  /** Optional cleanup, called on app shutdown. */
  dispose?(): Promise<void>
}
