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
import { focusContext } from '../focus-context'

const MAX_RESULTS = 100

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
 *  - scoped search routing — every palette session names its module via the
 *    direct-launch hotkey or programmatic show(moduleId).
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
    // Seed the direct-launch hotkey + default aliases from the manifest on
    // fresh installs. `ensureModuleDefaults` only writes when the entry is
    // missing (first registration of this module id), so existing users
    // keep their bindings — in particular, anyone who deliberately cleared
    // a hotkey stays cleared instead of having it resurrected on restart.
    const directLaunchSeed =
      module.manifest.supportsDirectLaunch &&
      module.manifest.defaultDirectLaunchHotkey
        ? { directLaunchHotkey: module.manifest.defaultDirectLaunchHotkey }
        : {}
    const aliasesSeed = module.manifest.defaultAliases
      ? { aliases: { ...module.manifest.defaultAliases } }
      : {}
    settingsStore.ensureModuleDefaults(id, {
      enabled: module.manifest.defaultEnabled,
      config: defaultConfigFromManifest(module),
      ...directLaunchSeed,
      ...aliasesSeed
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
        aliases: { ...(s.aliases ?? {}) },
        elevated: [...(s.elevated ?? [])]
      })
    }
    return results
  }

  /** Fresh snapshot of a module's aliases map for SearchContext. */
  private buildAliases(m: PaletteModule): Record<string, string> {
    return { ...(this.moduleSettingsCache.get(m.manifest.id)?.aliases ?? {}) }
  }

  /** Fresh snapshot of a module's "launch elevated" ids for SearchContext. */
  private buildElevated(m: PaletteModule): string[] {
    return [...(this.moduleSettingsCache.get(m.manifest.id)?.elevated ?? [])]
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

    // Every palette session is scoped — there is no aggregate home screen.
    // A search arriving without a target module (shouldn't happen via the
    // hotkey path) returns empty rather than synthesising a picker.
    if (!scopeModuleId) {
      return { requestId, items: [] }
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
          aliases: this.buildAliases(scopedModule),
          elevated: this.buildElevated(scopedModule),
          focusedApp: focusContext.get()
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
