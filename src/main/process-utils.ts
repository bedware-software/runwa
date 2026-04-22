import { spawnSync } from 'child_process'
import { app } from 'electron'
import { appendFileSync } from 'fs'
import path from 'path'

/**
 * The image name Windows sees our process as. `runwa.exe` in packaged
 * installs, `electron.exe` under `npm run dev`. All the process-hygiene
 * utilities below filter by this name so they work in both modes.
 */
function ownImageName(): string {
  return path.basename(process.execPath)
}

/**
 * Path to `%TEMP%\runwa-diag.log` — persistent diagnostic file that
 * survives the main-process exits we're trying to reason about. Useful
 * when investigating what process actually lingers after `app.exit()`
 * / wipe / autoUpdater.quitAndInstall — terminal-only logging dies
 * with the process and leaves nothing to inspect.
 */
function diagLogPath(): string {
  return path.join(app.getPath('temp'), 'runwa-diag.log')
}

/**
 * Append a timestamped block to the diag log. `label` is a short tag
 * the caller uses to locate the moment ("startup", "pre-wipe-exit",
 * …) when reading the file later. `extra` is appended verbatim so
 * callers can drop their own context in without formatting it here.
 */
function appendDiag(label: string, extra: string = ''): void {
  try {
    const timestamp = new Date().toISOString()
    const header = `\n==== ${timestamp} · ${label} · pid=${process.pid} · image=${ownImageName()} ====\n`
    appendFileSync(diagLogPath(), header + extra + '\n', 'utf8')
  } catch {
    /* ignore — diag is best-effort */
  }
}

/**
 * Snapshot all running processes that share our image name, formatted
 * as a CSV text block. Includes PID, memory usage, and session so we
 * can tell helper / renderer / GPU apart after the fact. Returns
 * stdout as a string; empty on failure / non-Windows.
 */
function snapshotSiblings(): string {
  if (process.platform !== 'win32') return ''
  try {
    const result = spawnSync(
      'tasklist',
      ['/FI', `IMAGENAME eq ${ownImageName()}`, '/FO', 'CSV'],
      { windowsHide: true, timeout: 5000 }
    )
    if (result.error) return `tasklist error: ${result.error.message}`
    return result.stdout?.toString() ?? ''
  } catch (err) {
    return `snapshotSiblings threw: ${String(err)}`
  }
}

/**
 * Write a "here's what's running with our image name" entry to the
 * diag log. Cheap (~200 ms tasklist call) and only called at the 2-3
 * moments we're investigating — not a hot path.
 */
export function logProcessSnapshot(label: string): void {
  if (process.platform !== 'win32') return
  appendDiag(label, snapshotSiblings())
}

/**
 * Stub retained so existing import sites compile — an earlier version
 * of this module spawned a deferred `cmd.exe` kill batch here, but
 * that caused visible console-window flashes and didn't actually
 * catch the orphan anyway. Reinstate once the diag log tells us what
 * we're aiming at.
 */
export function scheduleOrphanCleanup(): void {
  /* no-op while the diag log narrows down the culprit */
}

/**
 * Windows-only: force-terminate the current process via `taskkill /F /PID`.
 *
 * Observed in dev (see `%TEMP%\runwa-diag.log`): `app.exit(0)` fires the
 * `quit` event and then hangs — the main process stays alive while
 * Electron's (or electron-vite's) internal shutdown machinery waits on
 * something. `process.exit(0)` goes through Node's atexit hooks and
 * sometimes also doesn't complete in the wipe / autoUpdate timeframe.
 * `taskkill /F` goes straight to `TerminateProcess`, which the kernel
 * honours unconditionally — no hooks, no cleanup, no hang.
 *
 * Caller must NOT expect this function to return. If it does (e.g.
 * because we're on a non-Windows platform or taskkill spawn failed),
 * the caller should fall through to `process.exit(1)` as a last resort.
 */
export function forceKillSelf(): void {
  if (process.platform !== 'win32') return
  try {
    // Just our PID — NOT `/T`. `taskkill /T` would kill our whole
    // process tree, which on Windows includes the wipe-data helper
    // (spawn's `detached: true` on Win doesn't reparent — the helper
    // still shows as our child in the snapshot tree). Without the
    // helper alive, there's no one to wipe + respawn. Chromium helper
    // children orphan briefly after we die, but they self-terminate via
    // IPC-disconnect within a couple hundred ms; the wipe helper's
    // separately-issued cleanup step (see the helper script) mops up
    // any stragglers before the new main is spawned.
    spawnSync('taskkill', ['/F', '/PID', String(process.pid)], {
      windowsHide: true,
      timeout: 5000
    })
  } catch {
    /* fall through to caller's fallback */
  }
}

/**
 * Windows-only: terminate all processes matching our exe image name
 * OTHER than ours.
 *
 * Called right before `autoUpdater.quitAndInstall()` — NSIS's uninstall
 * step fails with "Failed to uninstall old application files" when any
 * runwa.exe (or `ELECTRON_RUN_AS_NODE=1` helpers spawned by wipe-data)
 * is still holding file locks. Since the main process is about to die
 * anyway, we don't care about collateral damage to sibling processes.
 *
 * On non-Windows platforms this is a no-op — macOS / Linux updaters
 * don't run into the equivalent issue (atomic replacement of the app
 * bundle / AppImage).
 */
export function killSiblingRunwaProcesses(): void {
  if (process.platform !== 'win32') return
  try {
    const image = ownImageName()
    const result = spawnSync(
      'taskkill',
      ['/F', '/IM', image, '/FI', `PID ne ${process.pid}`],
      { windowsHide: true, timeout: 5000 }
    )
    if (result.error) {
      console.warn('[process-utils] taskkill spawn failed:', result.error.message)
      return
    }
    const stdout = result.stdout?.toString().trim()
    if (stdout) console.log(`[process-utils] taskkill (${image}):`, stdout)
  } catch (err) {
    console.warn('[process-utils] killSiblingRunwaProcesses threw:', err)
  }
}
