import ReactDOM from 'react-dom/client'
import './lib/electron'
import './globals.css'
import { isTauriShell } from './lib/shell'
import { PaletteApp } from './components/palette/PaletteApp'
import { SettingsApp } from './components/settings/SettingsApp'
import { RecorderApp } from './components/recorder/RecorderApp'
import { DesktopHintApp } from './components/desktop-hint/DesktopHintApp'

// Tauri has no preload script: install the `window.electronAPI` bridge
// before anything calls it. Loaded on demand, so the Electron bundle doesn't
// carry @tauri-apps/api.
if (isTauriShell()) {
  const { installTauriBridge } = await import('./lib/tauri-bridge')
  installTauriBridge()
}

// Hash-based routing so one HTML file / one bundle serves every window.
// Settings can carry a `?tab=<id>` suffix for deep-linking (e.g. tray →
// About tab); strip it before matching against the known view ids.
const rawHash = (window.location.hash || '#palette').replace(/^#/, '')
const view = rawHash.split('?')[0]
const Root =
  view === 'settings'
    ? SettingsApp
    : view === 'recorder'
      ? RecorderApp
      : view === 'desktop-hint'
        ? DesktopHintApp
        : PaletteApp

// Tag the root so globals.css can strip the default body background /
// height for transparent surfaces like the Desktop Hint.
document.documentElement.setAttribute('data-view', view)

if (view === 'desktop-hint') {
  // Desktop Hint is OS-level feedback, so it follows the desktop appearance
  // even when the user has pinned Runwa's own windows to Light or Dark.
  document.documentElement.setAttribute('data-theme', 'system')
} else {
  // Apply stored theme ASAP — reduces flash of wrong theme on first paint.
  window.electronAPI
    .settingsGet()
    .then((s) => {
      document.documentElement.setAttribute('data-theme', s.theme)
    })
    .catch(() => {
      // fall back to the `data-theme="system"` default already on <html>
    })
}

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing')
ReactDOM.createRoot(container).render(<Root />)
