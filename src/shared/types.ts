/**
 * Shared types: main ↔ preload ↔ renderer.
 *
 * FIREWALL: nothing in this file imports main-internal types (PaletteModule,
 * registry internals, electron APIs). The renderer and the preload-exposed
 * electronAPI only see this file. Keeping main's guts out of here is what
 * lets us refactor the module shape without touching the renderer.
 */

export type ModuleId = string // kebab-case, e.g. 'window-switcher'

/**
 * Generic per-module config field descriptor. Each module declares a list of
 * these on its manifest; the settings UI renders them automatically and
 * persists the values into ModuleSettings.config. Values are typed per-field
 * but stored as an opaque Record<string, unknown> on disk.
 */
export type ModuleConfigValue = boolean | string | number

export interface ModuleConfigFieldBase {
  key: string
  label: string
  description?: string
}

export interface ModuleConfigFieldCheckbox extends ModuleConfigFieldBase {
  type: 'checkbox'
  defaultValue: boolean
}

export interface ModuleConfigFieldRadio extends ModuleConfigFieldBase {
  type: 'radio'
  defaultValue: string
  options: Array<{ value: string; label: string }>
}

export interface ModuleConfigFieldText extends ModuleConfigFieldBase {
  type: 'text'
  defaultValue: string
  /** Render as a password input (masked) — for API keys, tokens, etc. */
  secret?: boolean
  /** Placeholder shown when the value is empty. */
  placeholder?: string
  /** Render as an auto-growing textarea with soft-wrapped lines. */
  multiline?: boolean
}

/**
 * A clickable action — no stored value, fires an IPC call to the module's
 * `onAction(key)` handler. Useful for side-effect operations like "open
 * config file in external editor".
 */
export interface ModuleConfigFieldAction extends ModuleConfigFieldBase {
  type: 'action'
  /** Button label shown to the user. */
  buttonLabel: string
}

export type ModuleConfigField =
  | ModuleConfigFieldCheckbox
  | ModuleConfigFieldRadio
  | ModuleConfigFieldText
  | ModuleConfigFieldAction

/**
 * What the module *is*, from the palette's point of view.
 *  - 'search': the module produces a searchable list (Window Switcher, App
 *    Search, future Files/Calculator/Clipboard…). Appears in the home-screen
 *    picker and can be scoped into.
 *  - 'service': background utility with no palette surface (Keyboard Remap)
 *    or a hotkey-only trigger (Groq Transcription). Settings-sidebar-only —
 *    never shown in the home picker.
 */
export type ModuleKind = 'search' | 'service'

export interface ModuleManifest {
  id: ModuleId
  name: string
  icon: string // lucide icon name
  kind: ModuleKind
  description: string
  defaultEnabled: boolean
  supportsDirectLaunch: boolean
  /**
   * Default direct-launch hotkey. Seeded into the stored settings the
   * first time this module is registered (fresh install only — existing
   * users keep their current binding, including explicitly-cleared
   * ones). Also surfaced in the settings UI as the reset-to-default
   * target. Only meaningful when `supportsDirectLaunch` is true.
   */
  defaultDirectLaunchHotkey?: string
  /** Declarative config schema — the settings UI renders fields from this. */
  configFields?: ModuleConfigField[]
}

export interface ModuleMeta extends ModuleManifest {
  enabled: boolean
  directLaunchHotkey?: string // Electron Accelerator string, e.g. 'Ctrl+Alt+W'
  /** Current values for configFields, merged with defaults. */
  config: Record<string, ModuleConfigValue>
  /** User-assigned aliases keyed by module-specific stable ids. */
  aliases: Record<string, string>
}

export interface PaletteItem {
  /** Stable within a single search result set. */
  id: string
  moduleId: ModuleId
  title: string
  subtitle?: string
  /** Lucide icon name or data URL. Iteration 1 uses lucide names only. */
  iconHint?: string
  /**
   * Absolute filesystem path the context menu's "Show in file explorer"
   * action targets. When set, the palette surfaces a Ctrl+K context menu
   * for this item; when undefined, the hotkey is a no-op for this row.
   * App-search populates it with the .lnk / .exe / .app path; UWP entries
   * leave it undefined (no stable filesystem target for the user to open).
   */
  revealPath?: string
  /**
   * If true, the palette immediately executes this item as soon as the
   * search result lands — no highlight-and-Enter step. Used by app-search's
   * "launch immediately on alias" mode: typing the full alias launches
   * the app without further input. Modules should only set this for
   * explicit, user-opted-in triggers; a stray `autoExecute: true` on an
   * unexpected row would feel like the palette's running itself.
   */
  autoExecute?: boolean
  /**
   * User-assigned alias for this item (app-search only today). Rendered
   * as a trailing chip in the palette row and can short-circuit search
   * when matching the typed query — see app-search's `aliasMode` config.
   */
  alias?: string
  /** Per-module action discriminator. Re-validated by the owning module on execute. */
  actionKind: string
  /** Opaque payload, owned by the module. Renderer never interprets this. */
  action: unknown
  /** Lower = better match. Optional — modules that don't compute may omit. */
  score?: number
}

export interface SearchRequest {
  requestId: number
  query: string
  /** Force-scope to a single module (direct-launch hotkey, etc.). */
  scopeModuleId?: ModuleId
}

export interface SearchResult {
  requestId: number
  items: PaletteItem[]
  /** Set when the search was scoped to a specific module. */
  resolvedModuleId?: ModuleId
}

export interface ExecuteResult {
  dismissPalette: boolean
  error?: string
  /**
   * If set, the renderer should NOT dismiss the palette and instead enter
   * scoped mode for this module (clear query, re-run search). Used by the
   * synthetic module-picker entries the registry returns on the home screen
   * — selecting "App Search" sets scopeToModuleId='app-search', dropping
   * the user into app-search's own view.
   */
  scopeToModuleId?: ModuleId
}

export type Theme = 'light' | 'dark' | 'system'

export interface ModuleSettings {
  enabled: boolean
  directLaunchHotkey?: string
  /** Opaque bag of config values keyed by ModuleConfigField.key. */
  config?: Record<string, ModuleConfigValue>
  /**
   * Per-item aliases keyed by the module's stable entry id (e.g. app-search
   * uses `start-menu:<path>` / `uwp:<AUMID>` / etc.). Modules that don't
   * surface aliases simply leave this empty.
   */
  aliases?: Record<string, string>
}

export interface PaletteSize {
  width: number
  height: number
}

export interface Settings {
  /** Global activation hotkey as an Electron Accelerator string. */
  activationHotkey: string
  /**
   * Hotkey that opens the settings window. Window-local — only fires while a
   * runwa window has focus, so it's safe to use chords like Ctrl+, that IDEs
   * already own.
   */
  openSettingsHotkey: string
  theme: Theme
  /** User-resized dimensions of the palette window. Absent = use hard-coded default. */
  paletteSize?: PaletteSize
  modules: Record<ModuleId, ModuleSettings>
}

export const DEFAULT_SETTINGS: Settings = {
  activationHotkey: 'Ctrl+Alt+S',
  openSettingsHotkey: 'Ctrl+,',
  theme: 'system',
  modules: {}
}

/**
 * Payload sent from main to renderer when the palette is shown. The renderer
 * uses it to pre-select a module (direct-launch hotkey) or clear state.
 */
export interface PaletteShowPayload {
  initialModuleId?: ModuleId
}

/**
 * Display-ready snapshot of `<userData>/keyboard-rules.yaml` for the settings
 * panel. Generated by the main process on demand — the renderer only reads it.
 * Authoritative parsing lives in Rust (`native/src/remap/rules.rs`); this
 * structure is a lossy summary for showing what's currently active.
 */
export interface KeyboardRemapRulesView {
  /** Absolute path to the YAML file (shown in the read-only path input). */
  filePath: string
  /** Populated when the file is missing or YAML-invalid. */
  error?: string
  triggers: KeyboardRemapTriggerView[]
}

export interface KeyboardRemapTriggerView {
  /** Display name of the physical trigger ("CapsLock", "Space"). */
  name: string
  /** Formatted `on_tap` output (e.g. "Escape", "Ctrl+C"), or undefined. */
  onTap?: string
  /** Shape of the `on_hold:` block — determines how the renderer draws it. */
  onHoldKind: 'transparent' | 'explicit' | 'passthrough'
  /** For `transparent` only: the modifier name that is chip-rendered
   *  alongside the "(transparent layer)" caption (e.g. "Ctrl", "Shift"). */
  onHoldModifier?: string
  /** For `explicit` only: per-combo rules, including any `_default` row
   *  so the UI mirrors the YAML list 1:1 (no hidden fallback). */
  combos?: KeyboardRemapComboView[]
}

export interface KeyboardRemapComboView {
  /** E.g. "Space+W". */
  trigger: string
  /** E.g. "Ctrl+Alt+S" or "Alt+F4". */
  result: string
  description?: string
  /** OS filter from the rule, if any. */
  os?: string
}

/**
 * macOS TCC-gated permissions the settings UI surfaces. Null on platforms
 * without a matching concept — the renderer uses that as "hide the section".
 */
export type PermissionName = 'accessibility' | 'screenRecording'

export interface PermissionFlags {
  accessibility: boolean
  screenRecording: boolean
}

export type PermissionStatus = PermissionFlags | null

/**
 * GitHub Releases-backed auto-update state machine, as observed from
 * the renderer. The main process is the source of truth — the
 * Settings panel subscribes via `onUpdateStatus` and shows a matching
 * label / button state.
 */
export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'up-to-date'; currentVersion: string }
  | { state: 'available'; version: string }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string }
  /**
   * Auto-update isn't wired up for the running process — currently only
   * set on unpackaged dev runs (`npm run dev`), where the running code
   * IS the source so there's nothing to update. Lets the UI surface an
   * explicit "disabled for this build" hint instead of silently sitting
   * on `idle`.
   */
  | { state: 'disabled'; reason: 'dev-build' }

/**
 * Narrow surface between renderer and main. The preload script exposes an
 * implementation of this on window.electronAPI.
 */
export interface ElectronAPI {
  // Modules
  modulesList: () => Promise<ModuleMeta[]>
  modulesSearch: (req: SearchRequest) => Promise<SearchResult>
  modulesCancelSearch: (requestId: number) => Promise<void>
  modulesExecute: (item: PaletteItem) => Promise<ExecuteResult>
  modulesAction: (moduleId: ModuleId, actionKey: string) => Promise<void>

  // Settings
  settingsGet: () => Promise<Settings>
  settingsSet: (patch: Partial<Settings>) => Promise<Settings>
  settingsSetModule: (moduleId: ModuleId, patch: Partial<ModuleSettings>) => Promise<Settings>
  settingsSetModuleConfig: (
    moduleId: ModuleId,
    configPatch: Record<string, ModuleConfigValue>
  ) => Promise<Settings>
  /**
   * Set or clear an alias on a module's item. Empty/null alias removes
   * the entry; non-empty overwrites. Trimmed / lowercased server-side.
   */
  settingsSetModuleAlias: (
    moduleId: ModuleId,
    itemId: string,
    alias: string | null
  ) => Promise<Settings>

  // Palette window control
  paletteHide: () => Promise<void>
  openSettings: () => Promise<void>

  // Context-menu action: reveal an absolute path in Explorer / Finder.
  revealInFolder: (absolutePath: string) => Promise<void>

  // Signal that the renderer has fresh results — main waits before showing.
  paletteReady: () => void

  // Palette drag-to-move (fire-and-forget for 60Hz pointermove streams)
  paletteStartMove: () => void
  paletteMoveBy: (dx: number, dy: number) => void
  paletteEndMove: () => void

  // Keyboard remap — module-specific surface for the settings panel.
  keyboardRemapGetRules: () => Promise<KeyboardRemapRulesView>
  keyboardRemapReload: () => Promise<KeyboardRemapRulesView>

  // Auto-update: getter + push-update subscription.
  checkForUpdates: () => Promise<void>
  getUpdateStatus: () => Promise<UpdateStatus>
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void

  // macOS permission status for the General panel. Null on other OSes.
  permissionsGet: () => Promise<PermissionStatus>
  permissionsRequest: (name: PermissionName) => Promise<PermissionStatus>
  permissionsOpenSystemSettings: (name: PermissionName) => Promise<void>

  // Danger zone — wipe the entire userData directory and relaunch.
  wipeAllData: () => Promise<void>

  // Events (main → renderer). Return an unsubscribe function.
  onPaletteShow: (cb: (payload: PaletteShowPayload) => void) => () => void
  onSettingsChanged: (cb: (settings: Settings) => void) => () => void
}
