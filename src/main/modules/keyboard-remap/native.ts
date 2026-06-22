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
  validateKeyboardRemap(rulesJson: string): void
  stopKeyboardRemap(handle: number): void
  setInputLanguage(code: string): void
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
      typeof mod.validateKeyboardRemap !== 'function' ||
      typeof mod.stopKeyboardRemap !== 'function'
    ) {
      throw new Error(
        'native addon missing startKeyboardRemap / validateKeyboardRemap / stopKeyboardRemap'
      )
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

export function validateKeyboardRemap(rulesJson: string): void {
  loadAddon().validateKeyboardRemap(rulesJson)
}

export function stopKeyboardRemap(handle: number): void {
  loadAddon().stopKeyboardRemap(handle)
}

/**
 * Activate the system input source whose primary language matches `code`
 * (ISO 639-1, e.g. `en`, `ru`). Same plumbing as the keyboard-remap
 * `change_language` rule action — no-ops if the language isn't installed.
 * Used by the palette window to force English on open when the user has
 * the corresponding setting enabled.
 */
export function setInputLanguage(code: string): void {
  loadAddon().setInputLanguage(code)
}
