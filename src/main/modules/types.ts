import type { ModuleConfigValue, ModuleManifest, PaletteItem } from '@shared/types'

export interface SearchContext {
  /** Current config values for this module, already merged with defaults. */
  config: Record<string, ModuleConfigValue>
}

/**
 * Event fired by the hotkey layer when the module's direct-launch hotkey
 * transitions. 'press' always fires; 'release' only fires when we have a
 * native key-hook available (uiohook-napi) and the module asked for it.
 */
export type DirectLaunchEvent = 'press' | 'release'

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

  /**
   * Optional: take over the module's direct-launch hotkey instead of opening
   * the palette. Modules that do their own thing on a global keystroke (e.g.
   * start/stop a background recording) implement this. The hotkey manager
   * only calls 'release' when a key-up source is available AND
   * `wantsKeyUpEvents()` returned true — otherwise behave as press-only.
   */
  handleDirectLaunch?(event: DirectLaunchEvent): void

  /**
   * Optional: signal that the module wants keyup events for its direct-launch
   * hotkey. Returning true causes the hotkey manager to route through the
   * native key listener (uiohook-napi) when available. Re-evaluated on every
   * settings change, so this can reflect runtime config (e.g. push-to-talk
   * vs. toggle mode).
   */
  wantsKeyUpEvents?(): boolean

  /** Optional cleanup, called on app shutdown. */
  dispose?(): Promise<void>
}
