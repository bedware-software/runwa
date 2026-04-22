import { app, BrowserWindow, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '@shared/types'

/**
 * GitHub Releases-backed auto-update.
 *
 * Flow:
 *   - On startup (and every `CHECK_INTERVAL_MS`), check the configured
 *     publish target for a newer release.
 *   - If found, `autoDownload = true` pulls the artifact in the
 *     background.
 *   - Once downloaded, a system notification invites the user to relaunch
 *     — `autoInstallOnAppQuit` makes the next normal quit apply the
 *     update with no extra interaction needed.
 *   - Failures are logged but swallowed; runwa is usable even when the
 *     update channel is unreachable.
 *
 * State is mirrored into `currentStatus` and broadcast to every open
 * renderer via `app:update-status` IPC so the Settings panel's "Check
 * for updates" row can reflect progress live.
 *
 * Dev / unpackaged runs are a no-op so `npm run dev` doesn't hit the
 * real GitHub API; there's nothing to update when the sources ARE the
 * running instance.
 */

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours

let started = false
let currentStatus: UpdateStatus = { state: 'idle' }

function setStatus(next: UpdateStatus): void {
  currentStatus = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('app:update-status', next)
    }
  }
}

export function getUpdateStatus(): UpdateStatus {
  return currentStatus
}

export function initAutoUpdater(): void {
  if (started) return
  started = true

  if (!app.isPackaged) {
    console.log('[auto-update] skipping — unpackaged dev run')
    // Surface the "disabled" state so the Settings UI's "Check for
    // updates" button shows a clear explanation instead of sitting
    // inert at the idle placeholder.
    setStatus({ state: 'disabled', reason: 'dev-build' })
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    console.log('[auto-update] checking')
    setStatus({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[auto-update] available: ${info.version}`)
    setStatus({ state: 'available', version: info.version })
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[auto-update] up to date')
    setStatus({ state: 'up-to-date', currentVersion: app.getVersion() })
  })

  autoUpdater.on('download-progress', (p) => {
    // `p.percent` is a float 0-100; clamp to 0-100 and round so the UI
    // doesn't flicker between 12.7 / 12.72 / 12.74 on every tick.
    const percent = Math.max(0, Math.min(100, Math.round(p.percent)))
    // Keep whatever version we were already tracking.
    const version =
      currentStatus.state === 'available' || currentStatus.state === 'downloading'
        ? currentStatus.version
        : ''
    setStatus({ state: 'downloading', version, percent })
  })

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[auto-update] downloaded: ${info.version}`)
    setStatus({ state: 'downloaded', version: info.version })
    if (Notification.isSupported()) {
      new Notification({
        title: 'runwa update ready',
        body: `Version ${info.version} will install the next time you quit runwa.`
      }).show()
    }
  })

  autoUpdater.on('error', (err) => {
    console.warn('[auto-update] error:', err.message)
    setStatus({ state: 'error', message: err.message })
  })

  void checkNow()
  setInterval(() => {
    void checkNow()
  }, CHECK_INTERVAL_MS)
}

/**
 * Fire an out-of-band check (used by the tray menu and the Settings
 * panel's "Check for updates" button). Safe to call at any time; an
 * in-flight check is effectively a no-op — electron-updater deduplicates
 * overlapping requests internally.
 */
export async function checkForUpdatesNow(): Promise<void> {
  if (!app.isPackaged) {
    // Re-broadcast the disabled status so the renderer reacts visibly to
    // the click (a no-op IPC would leave the UI frozen on its current
    // state). Users poking the button in dev builds at least get the
    // hint that this is expected.
    setStatus({ state: 'disabled', reason: 'dev-build' })
    return
  }
  await checkNow()
}

async function checkNow(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[auto-update] checkForUpdates threw:', message)
    setStatus({ state: 'error', message })
  }
}
