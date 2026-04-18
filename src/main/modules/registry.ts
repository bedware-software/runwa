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
 *  - prefix-based query routing
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
    settingsStore.ensureModuleDefaults(id, {
      enabled: module.manifest.defaultEnabled,
      config: defaultConfigFromManifest(module)
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
        config: this.buildConfig(m)
      })
    }
    return results
  }

  private parsePrefix(query: string): {
    scopeModuleId?: ModuleId
    strippedQuery: string
  } {
    const trimmed = query.trimStart()
    const spaceIdx = trimmed.indexOf(' ')
    if (spaceIdx <= 0) return { strippedQuery: query }
    const maybePrefix = trimmed.slice(0, spaceIdx)
    const rest = trimmed.slice(spaceIdx + 1)
    for (const m of this.modules.values()) {
      if (m.manifest.prefix && m.manifest.prefix === maybePrefix) {
        const enabled =
          this.moduleSettingsCache.get(m.manifest.id)?.enabled ??
          m.manifest.defaultEnabled
        if (enabled) {
          return { scopeModuleId: m.manifest.id, strippedQuery: rest }
        }
      }
    }
    return { strippedQuery: query }
  }

  async search(req: SearchRequest): Promise<SearchResult> {
    const { requestId, query, scopeModuleId: forcedScope } = req

    // Belt-and-suspenders: auto-abort older in-flight requests.
    for (const [id, ctrl] of this.activeControllers.entries()) {
      if (id < requestId) {
        ctrl.abort()
        this.activeControllers.delete(id)
      }
    }

    let scopeModuleId: ModuleId | undefined = forcedScope
    let effectiveQuery = query
    if (!scopeModuleId) {
      const parsed = this.parsePrefix(query)
      scopeModuleId = parsed.scopeModuleId
      effectiveQuery = parsed.strippedQuery
    } else {
      // Direct-launch hotkey already scoped us to a module; still strip
      // a matching prefix at the start of the query if present.
      const parsed = this.parsePrefix(query)
      if (parsed.scopeModuleId === scopeModuleId) {
        effectiveQuery = parsed.strippedQuery
      }
    }

    const modules: PaletteModule[] = scopeModuleId
      ? this.modules.has(scopeModuleId)
        ? [this.modules.get(scopeModuleId)!]
        : []
      : [...this.modules.values()].filter((m) => {
          const s = this.moduleSettingsCache.get(m.manifest.id)
          return s?.enabled ?? m.manifest.defaultEnabled
        })

    const controller = new AbortController()
    this.activeControllers.set(requestId, controller)

    try {
      const perModule = await Promise.all(
        modules.map(async (m) => {
          try {
            const items = await m.search(effectiveQuery, controller.signal, {
              config: this.buildConfig(m)
            })
            return items.map<PaletteItem>((it) => ({
              ...it,
              moduleId: m.manifest.id
            }))
          } catch (err) {
            if ((err as Error)?.name !== 'AbortError') {
              console.warn(
                `[registry] module ${m.manifest.id} search failed:`,
                err
              )
            }
            return [] as PaletteItem[]
          }
        })
      )

      const merged = perModule.flat()
      merged.sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
      const capped = merged.slice(0, MAX_RESULTS)

      return {
        requestId,
        items: capped,
        resolvedModuleId: scopeModuleId,
        strippedQuery: scopeModuleId ? effectiveQuery : undefined
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
