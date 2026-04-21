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

export interface ModuleManifest {
  id: ModuleId
  name: string
  icon: string // lucide icon name
  prefix?: string // e.g. 'win' — scopes the query to this module when typed as the first word
  description: string
  defaultEnabled: boolean
  supportsDirectLaunch: boolean
  /**
   * Recommended direct-launch hotkey. Surfaced in the settings UI as the
   * reset-to-default target; NOT auto-registered on first launch (so we
   * don't spring surprise global shortcuts on users). Only meaningful
   * when `supportsDirectLaunch` is true.
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
}

export interface PaletteItem {
  /** Stable within a single search result set. */
  id: string
  moduleId: ModuleId
  title: string
  subtitle?: string
  /** Lucide icon name or data URL. Iteration 1 uses lucide names only. */
  iconHint?: string
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
  /** Set if the registry auto-detected a prefix match or scopeModuleId was used. */
  resolvedModuleId?: ModuleId
  /** Query with the matched prefix stripped, if applicable. */
  strippedQuery?: string
}

export interface ExecuteResult {
  dismissPalette: boolean
  error?: string
}

export type Theme = 'light' | 'dark' | 'system'

export interface ModuleSettings {
  enabled: boolean
  directLaunchHotkey?: string
  /** Opaque bag of config values keyed by ModuleConfigField.key. */
  config?: Record<string, ModuleConfigValue>
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
  /** One-line summary of the hold behaviour. */
  onHoldSummary: string
  /** Per-combo rules from `on_hold:`, when using the explicit-list form. */
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

  // Palette window control
  paletteHide: () => Promise<void>
  openSettings: () => Promise<void>

  // Signal that the renderer has fresh results — main waits before showing.
  paletteReady: () => void

  // Palette drag-to-move (fire-and-forget for 60Hz pointermove streams)
  paletteStartMove: () => void
  paletteMoveBy: (dx: number, dy: number) => void
  paletteEndMove: () => void

  // Keyboard remap — module-specific surface for the settings panel.
  keyboardRemapGetRules: () => Promise<KeyboardRemapRulesView>
  keyboardRemapReload: () => Promise<KeyboardRemapRulesView>

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
