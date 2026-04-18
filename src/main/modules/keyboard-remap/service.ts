import { app, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import type { KeyboardRemapRulesView } from '@shared/types'
import { startKeyboardRemap, stopKeyboardRemap } from './native'
import { RULES_TEMPLATE } from './rules-template'
import { buildRulesView } from './rules-view'
import {
  isAccessibilityTrusted,
  requestAccessibilityPermission
} from '../window-switcher/native'

/**
 * Lifecycle owner for the native keyboard-remap hook.
 *
 * Reads rules from `<userData>/keyboard-rules.yaml`. If the file doesn't
 * exist, a template is written so the user has something to edit.
 *
 * On macOS the hook needs Accessibility permission. If it's missing we
 * don't start — the window-switcher module already fires the system prompt
 * at launch, so by the time the user restarts runwa the permission should
 * be available. Until then the service logs a warning and stays dormant.
 */
class KeyboardRemapService {
  private handle: number | null = null
  private started = false

  rulesFilePath(): string {
    return path.join(app.getPath('userData'), 'keyboard-rules.yaml')
  }

  start(): void {
    if (this.started) return
    this.started = true

    if (process.platform === 'darwin' && !isAccessibilityTrusted()) {
      // Fire the prompt so it at least appears once; the user must grant
      // and relaunch for the hook to activate.
      try {
        requestAccessibilityPermission()
      } catch {
        // ignore
      }
      console.warn(
        '[keyboard-remap] skipping start — Accessibility not granted. ' +
          'Grant runwa in System Settings → Privacy & Security → Accessibility, then restart.'
      )
      return
    }

    const rulesYaml = this.loadOrInitRulesFile()
    try {
      this.handle = startKeyboardRemap(rulesYaml)
      console.log(`[keyboard-remap] started (handle ${this.handle})`)
    } catch (err) {
      console.warn('[keyboard-remap] failed to start:', err)
      this.handle = null
    }
  }

  stop(): void {
    if (this.handle != null) {
      try {
        stopKeyboardRemap(this.handle)
      } catch (err) {
        console.warn('[keyboard-remap] failed to stop:', err)
      }
      this.handle = null
    }
    this.started = false
  }

  async openRulesInEditor(): Promise<void> {
    const p = this.rulesFilePath()
    // Make sure the file exists before asking the OS to open it.
    this.loadOrInitRulesFile()
    const err = await shell.openPath(p)
    if (err) console.warn('[keyboard-remap] openPath returned error:', err)
  }

  /**
   * Read-only snapshot of the current rules file for the settings panel.
   * Doesn't touch the running hook — use `reload()` to re-install.
   */
  getRulesView(): KeyboardRemapRulesView {
    // Ensure the file exists so the user sees the seeded template rules on
    // first open, not a "file not found" placeholder.
    this.loadOrInitRulesFile()
    return buildRulesView(this.rulesFilePath())
  }

  /**
   * Re-install the hook from disk. Used by the Reload button in settings so
   * edits take effect without restarting runwa. Errors during start are
   * swallowed (logged) the same way they are at boot.
   */
  reload(): KeyboardRemapRulesView {
    this.stop()
    this.start()
    return buildRulesView(this.rulesFilePath())
  }

  /** Read the rules file, writing the template on first access. */
  private loadOrInitRulesFile(): string {
    const p = this.rulesFilePath()
    try {
      return fs.readFileSync(p, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[keyboard-remap] rules file unreadable, using template:', err)
        return RULES_TEMPLATE
      }
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, RULES_TEMPLATE, 'utf8')
        console.log(`[keyboard-remap] seeded rules file at ${p}`)
      } catch (writeErr) {
        console.warn('[keyboard-remap] failed to seed rules file:', writeErr)
      }
      return RULES_TEMPLATE
    }
  }
}

export const keyboardRemapService = new KeyboardRemapService()
