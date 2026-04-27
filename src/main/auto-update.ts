import { app, BrowserWindow, Notification } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { get as httpsGet } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateStatus } from '@shared/types'
import { forceKillSelf, killSiblingRunwaProcesses } from './process-utils'

/**
 * GitHub Releases-backed auto-update.
 *
 * Flow (Windows / Linux):
 *   - On startup (and every `CHECK_INTERVAL_MS`), check the configured
 *     publish target for a newer release.
 *   - If found, electron-updater pulls the artifact in the background.
 *   - Once downloaded, a system notification invites the user to relaunch;
 *     `autoInstallOnAppQuit` makes the next normal quit apply the update.
 *
 * Flow (macOS):
 *   - Same check path, but electron-updater's download is disabled. Its
 *     mac install path hands off to Squirrel.Mac's ShipIt, which runs a
 *     "designated requirement" check on the staged bundle and rejects
 *     anything ad-hoc-signed (every release ships with a fresh cdhash, so
 *     no two builds satisfy each other's DR — the symptom is "code failed
 *     to satisfy specified code requirement(s)" mid-update). Instead we
 *     download the per-arch zip ourselves, extract to userData, and on
 *     user-confirmed install spawn a detached bash that waits for our
 *     PID, swaps the .app bundle, and relaunches.
 *
 * Failures are logged but swallowed; runwa is usable even when the update
 * channel is unreachable.
 *
 * Dev / unpackaged runs are a no-op.
 */

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 hours
const isMac = process.platform === 'darwin'

let started = false
let currentStatus: UpdateStatus = { state: 'idle' }

// macOS-only: holds the extracted .app bundle path between manual download
// completion and `installUpdateNow`. Reset implicitly when a newer version
// download starts (we wipe the per-version cache dir before extracting).
let pendingMacUpdate: { version: string; appBundle: string } | null = null

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
    setStatus({ state: 'disabled', reason: 'dev-build' })
    return
  }

  if (isMac) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
  } else {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
  }

  autoUpdater.on('checking-for-update', () => {
    console.log('[auto-update] checking')
    setStatus({ state: 'checking' })
  })

  autoUpdater.on('update-available', (info) => {
    console.log(`[auto-update] available: ${info.version}`)
    setStatus({ state: 'available', version: info.version })
    if (isMac) {
      // Skip if we've already staged this version — avoids re-downloading
      // ~120 MB every interval tick when the user hasn't installed yet.
      if (pendingMacUpdate?.version === info.version) return
      void downloadMacUpdate(info)
    }
  })

  autoUpdater.on('update-not-available', () => {
    console.log('[auto-update] up to date')
    setStatus({ state: 'up-to-date', currentVersion: app.getVersion() })
  })

  // Windows / Linux only — macOS progress is published from
  // `downloadMacUpdate` directly.
  autoUpdater.on('download-progress', (p) => {
    const percent = Math.max(0, Math.min(100, Math.round(p.percent)))
    const version =
      currentStatus.state === 'available' || currentStatus.state === 'downloading'
        ? currentStatus.version
        : ''
    setStatus({ state: 'downloading', version, percent })
  })

  // Windows / Linux only — macOS uses `notifyDownloaded` from
  // `downloadMacUpdate`.
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[auto-update] downloaded: ${info.version}`)
    notifyDownloaded(info.version)
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

function notifyDownloaded(version: string): void {
  setStatus({ state: 'downloaded', version })
  if (Notification.isSupported()) {
    new Notification({
      title: 'runwa update ready',
      body: `Version ${version} will install the next time you quit runwa.`
    }).show()
  }
}

/**
 * Fire an out-of-band check (used by the tray menu and the Settings
 * panel's "Check for updates" button). Safe to call at any time; an
 * in-flight check is effectively a no-op — electron-updater deduplicates
 * overlapping requests internally.
 */
export async function checkForUpdatesNow(): Promise<void> {
  if (!app.isPackaged) {
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

/**
 * Trigger the downloaded update immediately. On Windows we kill any
 * sibling runwa.exe processes first (wipe-data helpers, stuck older GUI
 * instances — all of which hold file locks that make NSIS's uninstall
 * step abort with "Failed to uninstall old application files") then hand
 * off to electron-updater's `quitAndInstall`. On macOS we spawn the
 * bypass swap script and quit normally — see file header for why.
 */
export function installUpdateNow(): void {
  if (!app.isPackaged) return
  if (currentStatus.state !== 'downloaded') {
    console.warn(
      '[auto-update] installUpdateNow called without a downloaded update',
      currentStatus
    )
    return
  }

  if (isMac) {
    if (!pendingMacUpdate) {
      console.warn('[auto-update] mac install requested but no pending bundle')
      return
    }
    spawnMacSwap(pendingMacUpdate.appBundle)
    // Give the detached swap a beat to fork before we tear down — the
    // script is waiting on `kill -0 <pid>` so a quick quit is fine and
    // expected.
    setTimeout(() => app.quit(), 200)
    return
  }

  killSiblingRunwaProcesses()
  autoUpdater.quitAndInstall(true, true)
  // Belt-and-suspenders: the diag log showed `app.exit(0)` / the
  // quit-via-quitAndInstall path occasionally leaves our main process
  // alive in dev — stuck waiting on something Electron can't finish.
  // Give quitAndInstall a short grace period to spawn the installer
  // and exit cleanly; after that, force-kill ourselves via taskkill so
  // NSIS finds no runwa processes left to block its uninstall step.
  setTimeout(() => forceKillSelf(), 3000)
}

// ---------- macOS Squirrel-bypass update path ----------

async function downloadMacUpdate(info: UpdateInfo): Promise<void> {
  try {
    const isArm = process.arch === 'arm64'
    const file = info.files.find((f) =>
      isArm
        ? f.url.endsWith('-arm64-mac.zip')
        : f.url.endsWith('-mac.zip') && !f.url.endsWith('-arm64-mac.zip')
    )
    if (!file) {
      throw new Error(`no ${isArm ? 'arm64' : 'x64'} mac.zip in update manifest`)
    }
    const url = resolveAssetUrl(info.version, file.url)

    const versionDir = join(
      app.getPath('userData'),
      'pending-mac-updates',
      `v${info.version}`
    )
    await rm(versionDir, { recursive: true, force: true })
    await mkdir(versionDir, { recursive: true })

    const zipPath = join(versionDir, `Runwa-${info.version}.zip`)
    setStatus({ state: 'downloading', version: info.version, percent: 0 })
    await downloadToFile(url, zipPath, file.size ?? 0, (percent) => {
      setStatus({ state: 'downloading', version: info.version, percent })
    })

    const extractDir = join(versionDir, 'extracted')
    await mkdir(extractDir, { recursive: true })
    execFileSync('/usr/bin/unzip', ['-q', '-o', zipPath, '-d', extractDir], {
      stdio: ['ignore', 'inherit', 'inherit']
    })

    const appBundle = join(extractDir, 'Runwa.app')
    // Strip Gatekeeper quarantine on the freshly extracted bundle so we
    // don't re-prompt "downloaded from the internet" every release. The
    // user already approved this ad-hoc identity at first install — same
    // identifier-based DR (see `mac-after-sign.mjs`) means it's still
    // the same app to TCC and Launch Services.
    try {
      execFileSync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appBundle], {
        stdio: ['ignore', 'ignore', 'ignore']
      })
    } catch {
      // No-op when the attribute isn't present.
    }

    pendingMacUpdate = { version: info.version, appBundle }
    notifyDownloaded(info.version)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[auto-update] mac download failed:', message)
    setStatus({ state: 'error', message })
  }
}

function resolveAssetUrl(version: string, fileUrl: string): string {
  if (/^https?:\/\//.test(fileUrl)) return fileUrl
  // Mirrors the `publish:` block in electron-builder.yml — relative URLs
  // in latest-mac.yml resolve against the GitHub release's download URL.
  return `https://github.com/bedware-software/runwa/releases/download/v${version}/${fileUrl}`
}

function downloadToFile(
  url: string,
  destPath: string,
  expectedSize: number,
  onProgress: (percent: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = createWriteStream(destPath)
    let received = 0
    let lastPercent = -1

    const onResponse = (res: IncomingMessage): void => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && res.headers.location) {
        // GitHub's release-download URL 302s to a one-shot S3 URL.
        res.resume()
        httpsGet(res.headers.location, onResponse).on('error', reject)
        return
      }
      if (status !== 200) {
        res.resume()
        reject(new Error(`download failed: HTTP ${status}`))
        return
      }
      const total =
        expectedSize > 0
          ? expectedSize
          : Number(res.headers['content-length'] ?? 0)
      res.on('data', (chunk: Buffer) => {
        received += chunk.length
        if (total > 0) {
          const percent = Math.max(
            0,
            Math.min(100, Math.round((received / total) * 100))
          )
          if (percent !== lastPercent) {
            lastPercent = percent
            onProgress(percent)
          }
        }
      })
      res.pipe(out)
      out.on('finish', () => {
        out.close()
        if (lastPercent !== 100) onProgress(100)
        resolve()
      })
      out.on('error', reject)
    }

    httpsGet(url, onResponse).on('error', reject)
  })
}

function spawnMacSwap(newAppBundle: string): void {
  // process.execPath in a packaged Electron mac app is
  // <bundle>/Contents/MacOS/<exec>. Strip the trailing two segments to
  // get the .app bundle root we need to replace.
  const currentBundle = process.execPath.replace(
    /\/Contents\/MacOS\/[^/]+$/,
    ''
  )

  const stamp = Date.now()
  const scriptPath = join(tmpdir(), `runwa-swap-${stamp}.sh`)
  const logPath = join(tmpdir(), `runwa-swap-${stamp}.log`)

  // Atomic-ish rotation: rename current → .old, rename new → current,
  // then async-rm the old copy. A reboot during that window leaves
  // either both copies or just the new one — never zero.
  const script = `#!/bin/bash
set -e
exec >> "${logPath}" 2>&1
echo "[$(date)] runwa-swap pid=$1 src=$2 dst=$3"
PID=$1
SRC=$2
DST=$3
for _ in $(seq 1 200); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1
done
sleep 0.3
OLD="\${DST}.old.$$"
mv "$DST" "$OLD"
mv "$SRC" "$DST"
rm -rf "$OLD" &
open "$DST"
echo "[$(date)] runwa-swap done"
`
  writeFileSync(scriptPath, script, { mode: 0o755 })

  const child = spawn(
    '/bin/bash',
    [scriptPath, String(process.pid), newAppBundle, currentBundle],
    {
      detached: true,
      stdio: 'ignore'
    }
  )
  child.unref()
}
