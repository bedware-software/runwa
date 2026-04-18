import ReactDOM from 'react-dom/client'
import './lib/electron'
import './globals.css'
import { PaletteApp } from './components/palette/PaletteApp'
import { SettingsApp } from './components/settings/SettingsApp'
import { RecorderApp } from './components/recorder/RecorderApp'

// Hash-based routing so one HTML file / one bundle serves every window.
const view = (window.location.hash || '#palette').replace(/^#/, '')
const Root =
  view === 'settings' ? SettingsApp : view === 'recorder' ? RecorderApp : PaletteApp

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
