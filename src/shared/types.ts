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
}

export type ModuleConfigField =
  | ModuleConfigFieldCheckbox
  | ModuleConfigFieldRadio
  | ModuleConfigFieldText

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
 * Narrow surface between renderer and main. The preload script exposes an
 * implementation of this on window.electronAPI.
 */
export interface ElectronAPI {
  // Modules
  modulesList: () => Promise<ModuleMeta[]>
  modulesSearch: (req: SearchRequest) => Promise<SearchResult>
  modulesCancelSearch: (requestId: number) => Promise<void>
  modulesExecute: (item: PaletteItem) => Promise<ExecuteResult>

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

  // Events (main → renderer). Return an unsubscribe function.
  onPaletteShow: (cb: (payload: PaletteShowPayload) => void) => () => void
  onSettingsChanged: (cb: (settings: Settings) => void) => () => void
}
