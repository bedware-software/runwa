import { app, shell } from 'electron'
import fs from 'fs'
import path from 'path'
import type { KeyboardRemapRulesView } from '@shared/types'
import { startKeyboardRemap, stopKeyboardRemap, validateKeyboardRemap } from './native'
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
  private activeRulesYaml: string | null = null
  private lastError: string | null = null
  private usingPreviousRules = false

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
    this.installRules(rulesYaml, 'start')
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
    this.activeRulesYaml = null
    this.usingPreviousRules = false
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
    const rulesYaml = this.loadOrInitRulesFile()
    return this.rulesView(rulesYaml)
  }

  /**
   * Re-install the hook from disk. Used by the Reload button in settings so
   * edits take effect without restarting runwa. The new YAML is validated
   * before touching the active hook; invalid configs leave the previous
   * working remap installed and return a red error view for Settings.
   */
  reload(): KeyboardRemapRulesView {
    const rulesYaml = this.loadOrInitRulesFile()

    try {
      validateKeyboardRemap(rulesYaml)
    } catch (err) {
      const message = `Rules file is invalid. ${errorMessage(err)}`
      console.warn('[keyboard-remap] reload rejected:', message)
      this.lastError = message
      this.usingPreviousRules = this.handle != null
      return this.rulesView(rulesYaml, {
        error: message,
        usingPrevious: this.usingPreviousRules
      })
    }

    const previousRulesYaml = this.activeRulesYaml
    this.stopActiveHook()

    if (this.installRules(rulesYaml, 'reload')) {
      return this.rulesView(rulesYaml)
    }

    const reloadError = this.lastError ?? 'Reload failed.'
    if (previousRulesYaml != null && this.installRules(previousRulesYaml, 'rollback')) {
      const message = `${reloadError} Previous working rules are still active.`
      this.lastError = message
      this.usingPreviousRules = true
      return this.rulesView(rulesYaml, {
        error: message,
        usingPrevious: true
      })
    }

    return this.rulesView(rulesYaml, {
      error: `${reloadError} Previous working rules could not be restored.`,
      usingPrevious: false
    })
  }

  private installRules(rulesYaml: string, context: 'start' | 'reload' | 'rollback'): boolean {
    try {
      this.handle = startKeyboardRemap(rulesYaml)
      this.activeRulesYaml = rulesYaml
      this.lastError = null
      this.usingPreviousRules = false
      console.log(`[keyboard-remap] ${context}ed (handle ${this.handle})`)
      return true
    } catch (err) {
      const message = errorMessage(err)
      console.warn(`[keyboard-remap] failed to ${context}:`, err)
      this.handle = null
      this.activeRulesYaml = null
      this.lastError = message
      this.usingPreviousRules = false
      return false
    }
  }

  private stopActiveHook(): void {
    if (this.handle == null) return
    try {
      stopKeyboardRemap(this.handle)
    } catch (err) {
      console.warn('[keyboard-remap] failed to stop:', err)
    }
    this.handle = null
  }

  private rulesView(
    rulesYaml: string,
    override?: { error?: string; usingPrevious?: boolean }
  ): KeyboardRemapRulesView {
    const view = buildRulesView(this.rulesFilePath())
    let parseError: string | null = null
    try {
      validateKeyboardRemap(rulesYaml)
    } catch (err) {
      parseError = `Rules file is invalid. ${errorMessage(err)}`
    }

    if (override?.error || parseError || view.error) {
      return {
        ...view,
        error: override?.error ?? parseError ?? view.error,
        usingPrevious: override?.usingPrevious ?? this.handle != null
      }
    }

    if (this.lastError) {
      return {
        ...view,
        error: this.lastError,
        usingPrevious: this.usingPreviousRules
      }
    }

    return {
      ...view,
      usingPrevious: false
    }
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export const keyboardRemapService = new KeyboardRemapService()
