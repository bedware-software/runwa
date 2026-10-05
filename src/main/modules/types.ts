import type { ModuleConfigValue, ModuleManifest, PaletteItem } from '@shared/types'
import type { FocusedApp } from '../focus-context'

/**
 * Rows the registry keeps after sorting a module's results. Modules may
 * return more — everything past this is dropped before it reaches the
 * renderer — but work a module does *per returned row* (app search warms an
 * icon for each) is worth capping here rather than spending on rows nobody
 * will see.
 */
export const MAX_RESULTS = 100

export interface SearchContext {
  /** Current config values for this module, already merged with defaults. */
  config: Record<string, ModuleConfigValue>
  /**
   * User-assigned aliases for this module's items, keyed by the module's
   * stable entry id. Empty object when no aliases are set. Modules decide
   * how to interpret them (app-search boosts / auto-launches on exact
   * match).
   */
  aliases: Record<string, string>
  /**
   * Item ids the user marked "run as administrator", keyed the same way as
   * `aliases`. Empty array when none are. Only app-search acts on it —
   * everything else runs in-process and has no launch to elevate.
   */
  elevated: string[]
  /**
   * The app that was focused when the palette opened, or null when it
   * couldn't be identified (nothing was focused, native lookup failed).
   * Modules use it to surface context-specific entries — User Commands
   * hides its app-scoped commands unless their app is the one behind the
   * palette.
   */
  focusedApp: FocusedApp | null
  /** `SearchRequest.includeGlobal` — only User Commands reads it. */
  includeGlobal: boolean
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

  /**
   * Handle a click on a `type: 'action'` config field. `key` is the field
   * key from the module's manifest. Errors are logged and swallowed by the
   * registry — the UI is fire-and-forget.
   */
  onAction?(key: string): Promise<void> | void

  /**
   * Optional: do the expensive first-search work ahead of time. The registry
   * calls this once in the background at startup for every enabled module,
   * so the first palette open after a reboot answers from warm caches
   * instead of paying for them while the user waits. Must be safe to run
   * concurrently with `search()` — a search that lands mid-prewarm should
   * join the work in flight, not repeat it. Errors are logged and swallowed.
   */
  prewarm?(config: Record<string, ModuleConfigValue>): Promise<void>

  /** Optional cleanup, called on app shutdown. */
  dispose?(): Promise<void>
}
