import ReactDOM from 'react-dom/client'
import './lib/electron'
import './globals.css'
import { PaletteApp } from './components/palette/PaletteApp'
import { SettingsApp } from './components/settings/SettingsApp'
import { RecorderApp } from './components/recorder/RecorderApp'
import { IndicatorApp } from './components/indicator/IndicatorApp'

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
      : view === 'indicator'
        ? IndicatorApp
        : PaletteApp

// Tag the root so globals.css can strip the default body background /
// height for transparent surfaces like the recording-indicator pill.
document.documentElement.setAttribute('data-view', view)

// Apply stored theme ASAP — reduces flash of wrong theme on first paint.
window.electronAPI
  .settingsGet()
  .then((s) => {
    document.documentElement.setAttribute('data-theme', s.theme)
  })
  .catch(() => {
    // fall back to the `data-theme="system"` default already on <html>
  })

const container = document.getElementById('root')
if (!container) throw new Error('#root element missing')
ReactDOM.createRoot(container).render(<Root />)
