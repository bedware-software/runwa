import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { userCommandsStore } from './store'

const EARLY_FAILURE_WINDOW_MS = 150

/**
 * Resolve and launch a saved command by id. The palette item only carries the
 * id, never action text, so a renderer-tampered or stale item cannot execute
 * anything that is not currently present in the main-process store.
 */
export async function executeUserCommand(commandId: string): Promise<boolean> {
  const command = userCommandsStore.find(commandId)
  if (!command) return false

  try {
    // A raw action field intentionally means shell syntax in v1. Do not split
    // on spaces: quoting, pipes, environment expansion, and app arguments all
    // need to reach the platform shell intact. Output is ignored because this
    // is a background launcher, not a terminal session.
    const child = spawn(command.action, {
      shell: true,
      cwd: homedir(),
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const settle = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(graceTimer)
        resolve(ok)
      }
      // A shell can spawn successfully even when its command is missing or
      // malformed. Give immediate failures a brief window to report their
      // non-zero exit; long-running scripts still detach without holding the
      // palette open for their lifetime.
      const graceTimer = setTimeout(
        () => settle(true),
        EARLY_FAILURE_WINDOW_MS
      )
      child.once('error', (err) => {
        // Avoid logging the action itself: users may put tokens or other
        // sensitive values in a command line.
        console.warn(`[user-commands] command ${command.id} failed to spawn`, err)
        settle(false)
      })
      child.once('exit', (code, signal) => {
        if (code === 0) {
          settle(true)
          return
        }
        console.warn(
          `[user-commands] command ${command.id} exited unsuccessfully (code=${code ?? 'none'}, signal=${signal ?? 'none'})`
        )
        settle(false)
      })
    })
  } catch (err) {
    console.warn(`[user-commands] command ${command.id} failed to spawn`, err)
    return false
  }
}
