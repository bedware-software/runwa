import type {
  ModuleConfigValue,
  ModuleId,
  ModuleMeta,
  ModuleSettings,
  PaletteItem,
  SearchRequest,
  SearchResult,
  ExecuteResult,
  Settings
} from '@shared/types'
import type { PaletteModule } from './types'
import { settingsStore } from '../settings-store'

const MAX_RESULTS = 100

/**
 * Synthetic actionKind used by the module-picker items the registry injects
 * on the home screen. The registry owns execute for these — no module sees
 * them. Kept here (not in shared/) because it's a registry-internal protocol.
 */
const SCOPE_ACTION_KIND = 'registry:scope-to-module'

/** Build a fresh config object from a module's declared default values. */
function defaultConfigFromManifest(
  m: PaletteModule
): Record<string, ModuleConfigValue> {
  const out: Record<string, ModuleConfigValue> = {}
  for (const f of m.manifest.configFields ?? []) {
    out[f.key] = f.defaultValue
  }
  return out
}

/**
 * Central coordinator for all modules. Owns:
 *  - module registry (hard-coded at startup)
 *  - enabled/hotkey cache (store = truth, registry caches for the session)
 *  - in-flight search controllers (for cancellation)
 *  - home-screen module picker + scoped search routing
 */
class ModuleRegistry {
  private modules = new Map<ModuleId, PaletteModule>()
  private moduleSettingsCache = new Map<ModuleId, ModuleSettings>()
  private activeControllers = new Map<number, AbortController>()

  init(): void {
    this.hydrate(settingsStore.get())
    settingsStore.on('change', (s: Settings) => this.hydrate(s))
  }

  private hydrate(settings: Settings): void {
    this.moduleSettingsCache.clear()
    for (const [id, m] of Object.entries(settings.modules)) {
      this.moduleSettingsCache.set(id, m)
    }
  }

  register(module: PaletteModule): void {
    const id = module.manifest.id
    if (this.modules.has(id)) {
      console.warn(`[registry] duplicate module registration: ${id}`)
      return
    }
    this.modules.set(id, module)
    // Seed the direct-launch hotkey from the manifest default on fresh
    // installs. `ensureModuleDefaults` only writes when the entry is
    // missing (first registration of this module id), so existing users
    // keep their bindings — in particular, anyone who deliberately cleared
    // a hotkey stays cleared instead of having it resurrected on restart.
    const directLaunchSeed =
      module.manifest.supportsDirectLaunch &&
      module.manifest.defaultDirectLaunchHotkey
        ? { directLaunchHotkey: module.manifest.defaultDirectLaunchHotkey }
        : {}
    settingsStore.ensureModuleDefaults(id, {
      enabled: module.manifest.defaultEnabled,
      config: defaultConfigFromManifest(module),
      ...directLaunchSeed
    })
  }

  /** Build the effective config for a module by merging defaults with stored values. */
  private buildConfig(m: PaletteModule): Record<string, ModuleConfigValue> {
    const defaults = defaultConfigFromManifest(m)
    const stored = this.moduleSettingsCache.get(m.manifest.id)?.config ?? {}
    return { ...defaults, ...stored }
  }

  /** Look up a module by id for direct invocation (hotkey manager, IPC). */
  getModule(id: ModuleId): PaletteModule | undefined {
    return this.modules.get(id)
  }

  getManifests(): ModuleMeta[] {
    const results: ModuleMeta[] = []
    for (const m of this.modules.values()) {
      const s =
        this.moduleSettingsCache.get(m.manifest.id) ??
        ({ enabled: m.manifest.defaultEnabled } as ModuleSettings)
      results.push({
        ...m.manifest,
        enabled: s.enabled,
        directLaunchHotkey: s.directLaunchHotkey,
        config: this.buildConfig(m),
        aliases: { ...(s.aliases ?? {}) }
      })
    }
    return results
  }

  /** Fresh snapshot of a module's aliases map for SearchContext. */
  private buildAliases(m: PaletteModule): Record<string, string> {
    return { ...(this.moduleSettingsCache.get(m.manifest.id)?.aliases ?? {}) }
  }

  /**
   * Build the module-picker items shown on the unscoped home screen. One
   * entry per enabled search-kind module; executing an entry scopes the
   * palette into that module (handled in `execute()`). If a query is
   * present, filter by substring on the module's display name.
   */
  private buildPickerItems(query: string): PaletteItem[] {
    const trimmed = query.trim().toLowerCase()
    const items: PaletteItem[] = []
    let i = 0
    for (const m of this.modules.values()) {
      // Only search-kind modules are user-facing launchers — services stay
      // settings-only.
      if (m.manifest.kind !== 'search') continue
      const enabled =
        this.moduleSettingsCache.get(m.manifest.id)?.enabled ??
        m.manifest.defaultEnabled
      if (!enabled) continue
      if (trimmed && !m.manifest.name.toLowerCase().includes(trimmed)) continue
      items.push({
        id: `picker:${m.manifest.id}`,
        moduleId: m.manifest.id,
        title: m.manifest.name,
        subtitle: m.manifest.description,
        iconHint: m.manifest.icon,
        actionKind: SCOPE_ACTION_KIND,
        action: { moduleId: m.manifest.id },
        // Small monotonic scores preserve registration order so the picker
        // renders in the same sequence the user sees in the settings sidebar.
        score: i++ / 10000
      })
    }
    return items
  }

  async search(req: SearchRequest): Promise<SearchResult> {
    const { requestId, query, scopeModuleId } = req

    // Belt-and-suspenders: auto-abort older in-flight requests.
    for (const [id, ctrl] of this.activeControllers.entries()) {
      if (id < requestId) {
        ctrl.abort()
        this.activeControllers.delete(id)
      }
    }

    // Unscoped path: return the module picker. No per-module searches run
    // on the home screen. Scoping is explicit: either a direct-launch
    // hotkey or clicking a picker entry.
    if (!scopeModuleId) {
      return {
        requestId,
        items: this.buildPickerItems(query)
      }
    }

    const scopedModule = this.modules.get(scopeModuleId)
    if (!scopedModule) {
      return { requestId, items: [], resolvedModuleId: scopeModuleId }
    }

    const controller = new AbortController()
    this.activeControllers.set(requestId, controller)

    try {
      let items: PaletteItem[] = []
      try {
        const raw = await scopedModule.search(query, controller.signal, {
          config: this.buildConfig(scopedModule),
          aliases: this.buildAliases(scopedModule)
        })
        items = raw.map<PaletteItem>((it) => ({
          ...it,
          moduleId: scopedModule.manifest.id
        }))
      } catch (err) {
        if ((err as Error)?.name !== 'AbortError') {
          console.warn(
            `[registry] module ${scopedModule.manifest.id} search failed:`,
            err
          )
        }
      }

      items.sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
      const capped = items.slice(0, MAX_RESULTS)

      return {
        requestId,
        items: capped,
        resolvedModuleId: scopeModuleId
      }
    } finally {
      this.activeControllers.delete(requestId)
    }
  }

  cancelSearch(requestId: number): void {
    const ctrl = this.activeControllers.get(requestId)
    if (ctrl) {
      ctrl.abort()
      this.activeControllers.delete(requestId)
    }
  }

  async execute(item: PaletteItem): Promise<ExecuteResult> {
    // Registry-synthesized picker entry — scope into the module instead of
    // running a module execute. Keep the palette open so the user sees the
    // module's own results immediately.
    if (item.actionKind === SCOPE_ACTION_KIND) {
      const action = item.action as { moduleId?: unknown }
      const targetId =
        typeof action?.moduleId === 'string' ? action.moduleId : undefined
      if (!targetId || !this.modules.has(targetId)) {
        return { dismissPalette: false, error: `unknown picker target: ${String(targetId)}` }
      }
      return { dismissPalette: false, scopeToModuleId: targetId }
    }

    const m = this.modules.get(item.moduleId)
    if (!m) {
      return { dismissPalette: false, error: `unknown module: ${item.moduleId}` }
    }
    try {
      const res = await m.execute(item)
      return { dismissPalette: res.dismissPalette }
    } catch (err) {
      console.warn(`[registry] execute failed for ${item.moduleId}:`, err)
      return { dismissPalette: false, error: String(err) }
    }
  }

  async action(moduleId: ModuleId, key: string): Promise<void> {
    const m = this.modules.get(moduleId)
    if (!m || !m.onAction) return
    try {
      await m.onAction(key)
    } catch (err) {
      console.warn(`[registry] action ${moduleId}.${key} failed:`, err)
    }
  }

  async dispose(): Promise<void> {
    for (const ctrl of this.activeControllers.values()) ctrl.abort()
    this.activeControllers.clear()
    for (const m of this.modules.values()) {
      try {
        await m.dispose?.()
      } catch {
        // ignore
      }
    }
  }
}

export const moduleRegistry = new ModuleRegistry()
