import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { UserCommand } from '@shared/types'
import { sendKeystrokeAction } from './keystroke'
import { userCommandsStore } from './store'

const EARLY_FAILURE_WINDOW_MS = 150
const launchesInFlight = new Map<string, Promise<boolean>>()

/**
 * Resolve and run a saved command by id. The palette item only carries the
 * id, never action text, so a renderer-tampered or stale item cannot execute
 * anything that is not currently present in the main-process store.
 *
 * Shell commands only — keystroke commands go through
 * `sendUserCommandKeystroke` after the caller has handed focus back to the
 * app the keys are meant for.
 */
export function executeUserCommand(commandId: string): Promise<boolean> {
  const existing = launchesInFlight.get(commandId)
  if (existing) return existing

  const launch = launchUserCommand(commandId)
  launchesInFlight.set(commandId, launch)
  const clearLaunch = (): void => {
    if (launchesInFlight.get(commandId) === launch) {
      launchesInFlight.delete(commandId)
    }
  }
  // Coalesce rapid Enter/double-click delivery in main, where a compromised
  // or racing renderer cannot bypass the guard.
  void launch.then(clearLaunch, clearLaunch)
  return launch
}

/**
 * Synthesise a keystroke command's chord sequence into the focused window.
 * Takes the command itself rather than an id because the caller has already
 * re-resolved it against the store (and re-checked its app scope) to decide
 * that a keystroke, not a shell launch, is what should happen.
 *
 * The caller must also have restored focus to the target app first — see the
 * user-command branch of the Command Palette's execute().
 */
export function sendUserCommandKeystroke(command: UserCommand): boolean {
  if (command.kind !== 'keystroke') return false
  const ok = sendKeystrokeAction(command.action)
  if (!ok) {
    console.warn(`[user-commands] command ${command.id} could not be sent`)
  }
  return ok
}

async function launchUserCommand(commandId: string): Promise<boolean> {
  const command = userCommandsStore.find(commandId)
  if (!command || command.kind !== 'shell') return false

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
