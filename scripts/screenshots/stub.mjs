// Runs inside the page before the renderer's own code: stands in for the
// preload script. `window.electronAPI` answers from the data it is handed —
// no main process behind it, nothing leaves the page.
//
// Kept self-contained: Playwright serialises this function into the page.
export function installStub(data) {
  // The renderer picks platform-specific rows by navigator.platform; the
  // frames show the Windows build wherever they are taken.
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })

  const { manifests, appInfo, searches, replies } = data
  let settings = data.settings
  const listeners = {}

  const moduleMeta = () =>
    manifests.map((m) => {
      const stored = settings.modules[m.id] ?? {}
      return {
        ...m,
        enabled: stored.enabled ?? m.defaultEnabled,
        directLaunchHotkey: stored.directLaunchHotkey,
        config: { ...(stored.config ?? {}) },
        aliases: { ...(stored.aliases ?? {}) },
        elevated: [...(stored.elevated ?? [])]
      }
    })

  const patchModule = (id, patch) => {
    settings = {
      ...settings,
      modules: { ...settings.modules, [id]: { ...settings.modules[id], ...patch } }
    }
    return settings
  }

  const known = {
    getAppInfo: async () => appInfo,
    modulesList: async () => moduleMeta(),
    modulesSearch: async (req) => {
      const all = searches[req.scopeModuleId] ?? []
      const q = (req.query ?? '').trim().toLowerCase()
      const items = q
        ? all.filter((it) => it.title.toLowerCase().includes(q) || it.alias === q)
        : all
      return { requestId: req.requestId, items, resolvedModuleId: req.scopeModuleId }
    },
    settingsGet: async () => settings,
    settingsSet: async (patch) => (settings = { ...settings, ...patch }),
    settingsSetModule: async (id, patch) => patchModule(id, patch),
    settingsSetModuleConfig: async (id, configPatch) =>
      patchModule(id, { config: { ...settings.modules[id]?.config, ...configPatch } }),
    settingsSetModuleAlias: async () => settings,
    settingsSetModuleElevated: async () => settings,
    keyboardRemapFullscreenBypassItemState: async () => false
  }

  window.electronAPI = new Proxy(known, {
    get(target, name) {
      if (name in target) return target[name]
      if (typeof name !== 'string') return undefined
      // Subscriptions: remember the callback so the script can play main's
      // part (`__shots.emit('onPaletteShow', …)`), hand back an unsubscribe.
      if (name.startsWith('on')) {
        return (cb) => {
          listeners[name] = cb
          return () => {
            if (listeners[name] === cb) delete listeners[name]
          }
        }
      }
      return async () => (name in replies ? replies[name] : undefined)
    }
  })

  window.desktopHint = {
    signalReady: () => {},
    onPayload: (cb) => {
      listeners.onDesktopHint = cb
      return () => {
        delete listeners.onDesktopHint
      }
    }
  }

  window.__shots = {
    emit: (name, payload) => listeners[name]?.(payload),
    has: (name) => name in listeners
  }
}
