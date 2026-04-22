import { spawnSync } from 'child_process'

/**
 * Windows-only: terminate all runwa.exe processes OTHER than ours.
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
    const result = spawnSync(
      'taskkill',
      ['/F', '/IM', 'runwa.exe', '/FI', `PID ne ${process.pid}`],
      { windowsHide: true, timeout: 5000 }
    )
    if (result.error) {
      console.warn('[process-utils] taskkill spawn failed:', result.error.message)
      return
    }
    // Exit codes are fine either way — 0 on kills, 128 when nothing matched.
    // We log the stdout for visibility but don't fail if nothing happened.
    const stdout = result.stdout?.toString().trim()
    if (stdout) console.log('[process-utils] taskkill:', stdout)
  } catch (err) {
    console.warn('[process-utils] killSiblingRunwaProcesses threw:', err)
  }
}
