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
  /**
   * OS filter — when set, the settings UI only renders the field on the
   * matching platform. Mirrors the `os:` predicate used in keyboard-remap
   * rules so module authors have one mental model for both schemas.
   * Storage is unaffected — a value persisted on Windows stays in the
   * config when the user opens settings on macOS, it just isn't shown.
   */
  os?: 'windows' | 'macos' | 'linux'
  /**
   * Settings-UI grouping label. Adjacent fields that share the same
   * `group` string render together under a header bearing that label,
   * with a master "toggle all" control that flips every checkbox in the
   * group in one click. Fields with no `group` render as standalone
   * rows. The string is the user-facing label — keep it short
   * (e.g. "Windows Control"). Storage is per-field as usual.
   */
  group?: string
}

export interface ModuleConfigFieldCheckbox extends ModuleConfigFieldBase {
  type: 'checkbox'
  defaultValue: boolean
  /**
   * Render the checkbox as locked: the toggle is disabled and the row
   * shows a "locked" affordance. Used by modules that ship a built-in
   * command the user shouldn't be able to remove (e.g. command-palette's
   * "Open Settings"). The stored value is still respected at runtime —
   * the lock is purely a UI-level guarantee that the field stays on the
   * default, no backend enforcement.
   */
  readOnly?: boolean
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
  /** Optional lucide icon name (kebab-case, e.g. `refresh-cw`,
   * `pencil`). Rendered to the left of the button label so action
   * buttons can match the visual weight of bespoke buttons elsewhere
   * in the settings UI. Omit for label-only actions. */
  icon?: string
}

export type ModuleConfigField =
  | ModuleConfigFieldCheckbox
  | ModuleConfigFieldRadio
  | ModuleConfigFieldText
  | ModuleConfigFieldAction

/**
 * What the module *is*, from the palette's point of view.
 *  - 'search': the module produces a searchable list (Window Switcher, App
 *    Search, Command Palette, future Files/Calculator/Clipboard…). Bound to
 *    a direct-launch hotkey that opens the palette into this module's view.
 *  - 'service': background utility with no palette surface (Keyboard Remap)
 *    or a hotkey-only trigger (Groq Transcription). Settings-sidebar-only —
 *    never opens a palette window.
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
  /**
   * Per-item aliases the module ships with. Seeded into the user's
   * settings on first registration so a freshly-installed runwa already
   * has the bindings live (no setup step). Existing users keep whatever
   * alias they've set — the seeder only writes when the entry is missing.
   * Keys are the module's stable item ids; values are the alias strings.
   */
  defaultAliases?: Record<string, string>
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
   * Optional hover tooltip for the leading icon. Rendered via the
   * native `title` attribute on the icon container — shows on
   * pointer hover, OS-styled. Modules use it to explain status
   * icons that aren't self-evident (e.g. flashcards' deck row
   * icons: book/clock/check/graduation-cap each map to a specific
   * learning state). Undefined = no tooltip.
   */
  iconTooltip?: string
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
  /**
   * Optional grouping label rendered as a sticky-style header before the
   * first item with this group value, and again whenever the group
   * changes between adjacent items in the result list. Items without a
   * group render flush like before. Modules use it to give visual
   * structure to a long command list (Command Palette's "Settings" /
   * "Windows Control" sections, etc.).
   */
  group?: string
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

export interface PalettePosition {
  x: number
  y: number
}

export interface Settings {
  theme: Theme
  /**
   * Render `1`–`4` keycap chips on the left edge of the palette result
   * list when ≤ 4 rows match, and intercept the matching digit key to
   * launch that row directly. Off = no chips, no chord — type / arrow
   * / Enter only.
   */
  quickLaunchDigits: boolean
  /**
   * When the palette opens (any search dialog), force the system input
   * language to English so the user can type their query without first
   * switching layouts. macOS calls `TISSelectInputSource`; Windows posts
   * `WM_INPUTLANGCHANGEREQUEST` to the palette window. The English
   * keyboard layout must already be installed as a system input source —
   * the toggle only activates, never adds. We never restore on close;
   * the user keeps whatever language was last active.
   */
  paletteSwitchToEnglish: boolean
  /**
   * Launch runwa automatically when the user logs into their OS session.
   * Cross-platform (Electron's `app.setLoginItemSettings` handles both
   * Windows HKCU\...\Run and macOS LoginItems). Only meaningful in
   * packaged installs; settings UI greys out the toggle in dev.
   */
  startAtLogin: boolean
  /**
   * Windows-only: mark the installed executable with the `RUNASADMIN`
   * AppCompat flag in `HKCU\...\AppCompatFlags\Layers`, so every launch
   * triggers a UAC elevation prompt. Needed when the user wants runwa's
   * global hotkeys / keyboard remap / window-switcher APIs to work in
   * apps that themselves run elevated (UAC-split session rules).
   */
  runAsAdmin: boolean
  /** User-resized dimensions of the palette window. Absent = use hard-coded default. */
  paletteSize?: PaletteSize
  /** Last user-dragged top-left position of the palette window. */
  palettePosition?: PalettePosition
  modules: Record<ModuleId, ModuleSettings>
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  quickLaunchDigits: true,
  paletteSwitchToEnglish: true,
  startAtLogin: false,
  runAsAdmin: false,
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
 * Minimal environment snapshot surfaced to the renderer once at hydrate.
 * Drives toggles that only make sense for packaged installs (Start at
 * login, Run as administrator) and platform-specific UI rows.
 */
export interface AppInfo {
  isPackaged: boolean
  platform: NodeJS.Platform
  version: string
  /**
   * Canonical user-facing app name. Source of truth = `app.getName()`,
   * which returns `productName` from electron-builder.yml in packaged
   * builds and the package.json `name` in dev. The dev build calls
   * `app.setName('Runwa Dev')` early in main, so the same accessor
   * returns the right label across both. Renderer uses it in the
   * settings header and About panel — keeps every label in sync from
   * one place.
   */
  name: string
  /**
   * Absolute path to the userData directory — where settings, caches,
   * and per-module state live (`electron-store` and ad-hoc writes both
   * land under here). Surfaced on the About panel so users can
   * pinpoint the active install's data folder, especially relevant for
   * dev vs stable side-by-side runs.
   */
  userDataPath: string
}

/**
 * Tabs the settings window can be deep-linked to. 'module:<id>' selects a
 * specific module's panel. The tray menu uses this to jump straight to the
 * About tab when the user clicks "About" or "Check for updates".
 */
export type SettingsTabId = 'general' | 'about' | `module:${string}`

/* ─── Flashcards module types (shared with renderer) ────────────────── */

export interface FlashcardOption {
  text: string
}

export interface FlashcardCard {
  /** Stable card id — sha1 of the question text. */
  id: string
  question: string
  options: FlashcardOption[]
  /** Index into `options` of the correct answer, or -1 for malformed
   * cards (kept in the list so warnings can mention them; the quiz UI
   * filters them out before showing). */
  correctIndex: number
  explanation?: string
  /** Topic the card belongs to (from `## heading` in topic-mode files).
   * Undefined when the deck has no topics. Rendered as a small chip
   * above the question in the quiz UI. */
  topic?: string
}

export interface FlashcardDeck {
  id: string
  name: string
  cards: FlashcardCard[]
  warnings: string[]
}

/** SRS state echoed back to the renderer after recording an answer
 * — surfaced on the quiz summary card to show "next review in N days". */
export interface FlashcardCardState {
  ef: number
  interval: number
  reps: number
  lastReview: string
  nextReview: string
}

export type FlashcardAnswerOutcome = 'correct' | 'incorrect' | 'skipped'

export interface FlashcardAnswerRequest {
  deckId: string
  cardId: string
  outcome: FlashcardAnswerOutcome
}

/** Sent main → renderer when a deck is selected in the palette.
 * Contains the full deck and the pre-shuffled review order so the
 * renderer doesn't need to know SRS internals. */
/** Deck-level learning snapshot. "Mature" = SRS interval ≥ 21 days
 * (Anki convention) — used as the "have I actually learned this"
 * signal in both the palette subtitle and the post-session summary. */
export interface FlashcardsDeckMastery {
  mature: number
  total: number
}

export interface FlashcardsStartQuizPayload {
  deck: FlashcardDeck
  /** Card ids to quiz, in display order. In review mode this is just
   * the due cards; in cram mode it's every well-formed card. */
  quizCardIds: string[]
  cram: boolean
  /** Mastery snapshot taken right before the session starts. The
   * summary screen compares this against the post-session mastery
   * to show "was X → now Y mature". */
  initialMastery: FlashcardsDeckMastery
}

/** Snapshot of the LLM prompt file shown in the settings panel. */
export interface FlashcardsLlmPromptView {
  /** Absolute path — surfaced under the read-only preview so the user
   * knows where the file lives if they want to grep / version it. */
  filePath: string
  content: string
}

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
  // Environment snapshot — read once at hydrate. Used by the General
  // settings panel to gate "Start at login" / "Run as administrator"
  // rows based on packaged-state and platform.
  getAppInfo: () => Promise<AppInfo>

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

  // Flashcards — record the user's answer for a single card and get
  // the freshly-computed SRS state back (used by the quiz summary).
  flashcardsAnswer: (req: FlashcardAnswerRequest) => Promise<FlashcardCardState>

  /** Fetch the current LLM prompt file content + path for the
   * settings preview. Re-reads from disk on every call so external
   * edits show up the next time the user opens / reloads the
   * section. */
  flashcardsGetLlmPrompt: () => Promise<FlashcardsLlmPromptView>

  /** Post-session deck mastery snapshot — used by the quiz summary
   * to compare against `initialMastery` from the start payload and
   * show "was N → now M mature". */
  flashcardsGetDeckMastery: (deckId: string) => Promise<FlashcardsDeckMastery>

  /** Wipe SRS state for a single deck. Doesn't touch the .md file —
   * only the per-card history under `runwa-flashcards.json`. After
   * this, every card in the deck reverts to "new". */
  flashcardsResetDeck: (deckId: string) => Promise<void>

  // Auto-update: getter + push-update subscription.
  checkForUpdates: () => Promise<void>
  getUpdateStatus: () => Promise<UpdateStatus>
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void
  /**
   * Force-install a downloaded update immediately. Pre-kills orphan
   * runwa.exe processes that would otherwise make NSIS's uninstall
   * step fail ("Failed to uninstall old application files"), then
   * relaunches into the new version. No-op when no update is pending.
   */
  installUpdate: () => Promise<void>

  // macOS permission status for the General panel. Null on other OSes.
  permissionsGet: () => Promise<PermissionStatus>
  permissionsRequest: (name: PermissionName) => Promise<PermissionStatus>
  permissionsOpenSystemSettings: (name: PermissionName) => Promise<void>

  // Danger zone — wipe the entire userData directory and relaunch.
  wipeAllData: () => Promise<void>

  // Events (main → renderer). Return an unsubscribe function.
  onPaletteShow: (cb: (payload: PaletteShowPayload) => void) => () => void

  /**
   * Fired by the flashcards module's `execute()` when a deck row is
   * selected in the palette — the renderer switches into quiz mode in
   * the same window (no separate BrowserWindow is opened).
   */
  onFlashcardsStartQuiz: (cb: (payload: FlashcardsStartQuizPayload) => void) => () => void
  onSettingsChanged: (cb: (settings: Settings) => void) => () => void
  /**
   * Main asks the settings renderer to switch to a specific tab. Fired when
   * the tray opens settings with a target pane (e.g. "About", "Check for
   * updates") so the user lands where they expect.
   */
  onOpenSettingsTab: (cb: (tab: SettingsTabId) => void) => () => void
}
