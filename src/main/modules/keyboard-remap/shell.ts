import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

/**
 * Run a keyboard-remap `shell:` rule's command in the background. Same
 * launch shape as user-commands: the text is shell syntax (quoting, pipes
 * and `~` reach the platform shell intact), output is ignored, and the
 * child is detached so it outlives runwa.
 *
 * The command text is kept out of the log — people put tokens in command
 * lines.
 */
export function runRemapShellCommand(command: string): void {
  try {
    const child = spawn(command, {
      shell: true,
      cwd: homedir(),
      env: process.env,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.once('error', (err) => {
      console.warn('[keyboard-remap] shell rule failed to spawn', err)
    })
    child.once('exit', (code, signal) => {
      if (code === 0) return
      console.warn(
        `[keyboard-remap] shell rule exited unsuccessfully (code=${code ?? 'none'}, signal=${signal ?? 'none'})`
      )
    })
    child.unref()
  } catch (err) {
    console.warn('[keyboard-remap] shell rule failed to spawn', err)
  }
}
