import { app } from 'electron'
import path from 'path'

/**
 * Thin wrapper around the napi-rs addon's keyboard-remap exports. The
 * addon resolution logic mirrors `window-switcher/native.ts` — both files
 * load the same .node binary; `require` caches it, so there's no cost to
 * having the loader duplicated.
 */

interface NativeAddon {
  startKeyboardRemap(rulesJson: string): number
  stopKeyboardRemap(handle: number): void
}

let addon: NativeAddon | null = null
let loadError: Error | null = null

function loadAddon(): NativeAddon {
  if (addon) return addon
  if (loadError) throw loadError

  const nativePath = app.isPackaged
    ? path.join(process.resourcesPath, 'native')
    : path.join(app.getAppPath(), 'native')

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(nativePath) as NativeAddon
    if (
      typeof mod.startKeyboardRemap !== 'function' ||
      typeof mod.stopKeyboardRemap !== 'function'
    ) {
      throw new Error('native addon missing startKeyboardRemap / stopKeyboardRemap')
    }
    addon = mod
    return mod
  } catch (err) {
    loadError = new Error(
      `Failed to load runwa-native from ${nativePath}. ` +
        `Original error: ${err}`
    )
    throw loadError
  }
}

export function startKeyboardRemap(rulesJson: string): number {
  return loadAddon().startKeyboardRemap(rulesJson)
}

export function stopKeyboardRemap(handle: number): void {
  loadAddon().stopKeyboardRemap(handle)
}
