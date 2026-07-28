import { powerMonitor } from 'electron'
import type { Settings } from '@shared/types'
import {
  AUTO_DARK_MODE_ID,
  AUTO_DARK_MODE_MODE_KEY,
  readAutoDarkModeConfig,
  type AutoDarkModeConfig
} from '@shared/auto-dark-mode'
import { desktopHintWindow } from '../../desktop-hint-window'
import { settingsStore } from '../../settings-store'
import {
  getSystemTheme,
  setSystemTheme,
  type SystemTheme
} from './system-theme'
import {
  nextThemeBoundary,
  scheduledThemeAt,
  type ScheduledTheme
} from './schedule'

const DESKTOP_HINT_SOURCE = AUTO_DARK_MODE_ID
const HINT_DURATION_MS = 2200
const CLOCK_CHECK_INTERVAL_MS = 5 * 60 * 1000
const WAKE_RECONCILE_DELAY_MS = 750

type ReconcileAnnouncement = 'none' | 'mode' | 'theme'

/**
 * Lifecycle owner for the two-state Auto Dark Mode machine.
 *
 * Scheduled mode applies the segment containing "now" and arms one timer for
 * the next local boundary. Manual mode owns no timer. Toggle Theme always
 * switches to Manual before touching the OS, which prevents a scheduled
 * reconciliation from immediately undoing the user's explicit choice.
 */
class AutoDarkModeService {
  private started = false
  private enabled = false
  private config: AutoDarkModeConfig | null = null
  private configError: string | null = null
  private revision = 0
  private boundaryTimer: NodeJS.Timeout | null = null
  private clockCheckTimer: NodeJS.Timeout | null = null
  private wakeTimer: NodeJS.Timeout | null = null
  private activeThemeAbort: AbortController | null = null
  private lastScheduleSegment: ScheduledTheme | null = null
  private hasConfiguredOnce = false
  private suppressNextModeHint = false
  private pendingReconcile: Promise<SystemTheme | null> = Promise.resolve(null)
  private operationQueue: Promise<void> = Promise.resolve()

  private readonly onSettingsChange = (settings: Settings): void => {
    this.reconfigure(settings)
  }

  private readonly onWake = (): void => {
    if (!this.enabled || this.config?.mode !== 'scheduled') return
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.restartScheduledReconciliation('theme')
    }, WAKE_RECONCILE_DELAY_MS)
    this.wakeTimer.unref()
  }

  start(): void {
    if (this.started) return
    this.started = true
    settingsStore.on('change', this.onSettingsChange)
    powerMonitor.on('resume', this.onWake)
    powerMonitor.on('unlock-screen', this.onWake)
    this.reconfigure(settingsStore.get())
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    settingsStore.off('change', this.onSettingsChange)
    powerMonitor.off('resume', this.onWake)
    powerMonitor.off('unlock-screen', this.onWake)
    this.revision += 1
    this.cancelActiveThemeOperation()
    this.clearTimers()
    this.enabled = false
    this.config = null
    this.configError = null
    this.lastScheduleSegment = null
    desktopHintWindow.hide(DESKTOP_HINT_SOURCE)
  }

  /**
   * Command Palette action: opt into Scheduled mode, reconcile immediately,
   * then confirm with the shared Desktop Hint.
   */
  async enableScheduledMode(): Promise<SystemTheme> {
    this.assertAvailable()
    const wasAlreadyScheduled =
      this.enabled &&
      this.config?.mode === 'scheduled' &&
      this.configError === null
    this.suppressNextModeHint = true
    settingsStore.patchModuleConfig(AUTO_DARK_MODE_ID, {
      [AUTO_DARK_MODE_MODE_KEY]: 'scheduled'
    })

    try {
      // A patch emits even if Scheduled was already selected. Reconcile on
      // every explicit command so it doubles as "resume the schedule now".
      if (wasAlreadyScheduled && this.config?.mode === 'scheduled') {
        this.restartScheduledReconciliation('none')
      }
      const applied = await this.waitForLatestReconcile()
      if (!applied) {
        throw new Error(this.configError ?? 'The schedule could not be applied.')
      }
      this.showHint('Themes on schedule')
      return applied
    } catch (error) {
      console.warn('[auto-dark-mode] failed to enable schedule:', error)
      if (this.enabled && this.config?.mode === 'scheduled') {
        this.showHint('Schedule unavailable', 3000)
      }
      throw error
    }
  }

  /**
   * Command Palette action: enter Manual mode first, then flip the actual
   * system appearance. Theme operations are serialized with scheduler work so
   * a stale boundary cannot race and win after this explicit toggle.
   */
  async toggleTheme(): Promise<SystemTheme> {
    this.assertAvailable()
    this.suppressNextModeHint = true
    settingsStore.patchModuleConfig(AUTO_DARK_MODE_ID, {
      [AUTO_DARK_MODE_MODE_KEY]: 'manual'
    })
    const revision = this.revision

    try {
      const next = await this.enqueueThemeOperation(async () => {
        if (!this.isCurrentManualRevision(revision)) {
          throw new ThemeOperationCancelledError()
        }

        const controller = this.beginThemeOperation()
        try {
          const current = await getSystemTheme({ signal: controller.signal })
          if (!this.isCurrentManualRevision(revision)) {
            throw new ThemeOperationCancelledError()
          }

          const target: SystemTheme = current === 'dark' ? 'light' : 'dark'
          await setSystemTheme(target, { signal: controller.signal })
          if (!this.isCurrentManualRevision(revision)) {
            throw new ThemeOperationCancelledError()
          }

          const verified = await getSystemTheme({ signal: controller.signal })
          if (verified !== target) {
            throw new Error(
              `System reported ${verified} after switching to ${target}.`
            )
          }
          return target
        } finally {
          this.finishThemeOperation(controller)
        }
      })
      this.showHint(next === 'dark' ? 'Dark theme' : 'Light theme')
      return next
    } catch (error) {
      if (
        error instanceof ThemeOperationCancelledError ||
        !this.isCurrentManualRevision(revision)
      ) {
        console.info('[auto-dark-mode] manual toggle was cancelled')
        throw error
      }
      console.warn('[auto-dark-mode] manual toggle failed:', error)
      this.showHint('Theme switch failed', 3000)
      throw error
    }
  }

  private assertAvailable(): void {
    if (!this.started) {
      throw new Error('Auto Dark Mode is still starting.')
    }
    const moduleEnabled =
      settingsStore.get().modules[AUTO_DARK_MODE_ID]?.enabled ?? true
    if (!moduleEnabled) {
      throw new Error('Auto Dark Mode is disabled.')
    }
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      throw new Error(`Auto Dark Mode is unsupported on ${process.platform}.`)
    }
  }

  private reconfigure(settings: Settings): void {
    const moduleSettings = settings.modules[AUTO_DARK_MODE_ID]
    const nextEnabled = moduleSettings?.enabled ?? true
    const result = readAutoDarkModeConfig(moduleSettings?.config)
    const previousEnabled = this.enabled
    const previousMode = this.config?.mode
    const wasConfigured = this.hasConfiguredOnce
    const suppressModeHint = this.suppressNextModeHint
    this.suppressNextModeHint = false
    const nextError = result.error ?? null

    // SettingsStore emits for every module. Preserve the active boundary and
    // avoid invoking AppleScript / rebroadcasting Windows appearance when an
    // unrelated setting changed.
    if (
      wasConfigured &&
      this.enabled === nextEnabled &&
      this.config?.mode === result.config.mode &&
      this.config.lightTime === result.config.lightTime &&
      this.config.darkTime === result.config.darkTime &&
      this.configError === nextError
    ) {
      return
    }

    this.revision += 1
    const revision = this.revision
    this.cancelActiveThemeOperation()
    this.clearTimers()
    this.enabled = nextEnabled
    this.config = result.config
    this.configError = nextError
    this.lastScheduleSegment = null
    this.hasConfiguredOnce = true

    if (!this.started || !nextEnabled) {
      this.pendingReconcile = Promise.resolve(null)
      desktopHintWindow.hide(DESKTOP_HINT_SOURCE)
      return
    }

    const modeChanged =
      wasConfigured &&
      (!previousEnabled || previousMode !== result.config.mode)

    if (result.config.mode === 'manual') {
      this.pendingReconcile = Promise.resolve(null)
      if (modeChanged && !suppressModeHint) this.showHint('Manual mode')
      return
    }

    if (result.error) {
      console.warn(`[auto-dark-mode] schedule paused: ${result.error}`)
      this.pendingReconcile = Promise.resolve(null)
      if (modeChanged && !suppressModeHint) {
        this.showHint('Check schedule times', 3000)
      }
      return
    }

    this.startClockChecks(revision)
    const announcement: ReconcileAnnouncement =
      modeChanged && !suppressModeHint ? 'mode' : 'none'
    this.pendingReconcile = this.reconcileScheduled(revision, announcement)
  }

  private restartScheduledReconciliation(
    announcement: ReconcileAnnouncement
  ): void {
    if (
      !this.started ||
      !this.enabled ||
      this.config?.mode !== 'scheduled' ||
      this.configError
    ) {
      return
    }

    this.revision += 1
    const revision = this.revision
    this.cancelActiveThemeOperation()
    this.clearBoundaryTimer()
    if (this.clockCheckTimer) {
      clearInterval(this.clockCheckTimer)
      this.clockCheckTimer = null
    }
    this.lastScheduleSegment = null
    this.startClockChecks(revision)
    this.pendingReconcile = this.reconcileScheduled(revision, announcement)
  }

  private reconcileScheduled(
    revision: number,
    announcement: ReconcileAnnouncement
  ): Promise<SystemTheme | null> {
    const config = this.config
    if (!config || config.mode !== 'scheduled' || this.configError) {
      return Promise.resolve(null)
    }

    return this.enqueueThemeOperation(async () => {
      if (!this.isCurrentScheduledRevision(revision)) return null

      const desired = scheduledThemeAt(
        new Date(),
        config.lightTime,
        config.darkTime
      )
      const controller = this.beginThemeOperation()

      try {
        const current = await getSystemTheme({ signal: controller.signal })
        if (!this.isCurrentScheduledRevision(revision)) return null

        const changed = current !== desired
        // Apply even when the app-facing value already matches. Windows has
        // separate app and shell preferences; writing both here heals a mixed
        // state on the first scheduled reconciliation.
        await setSystemTheme(desired, { signal: controller.signal })
        if (!this.isCurrentScheduledRevision(revision)) return null

        const verified = await getSystemTheme({ signal: controller.signal })
        if (verified !== desired) {
          throw new Error(
            `System reported ${verified} after switching to ${desired}.`
          )
        }
        if (!this.isCurrentScheduledRevision(revision)) return null

        this.lastScheduleSegment = desired
        this.armNextBoundary(revision)

        if (announcement === 'mode') {
          this.showHint('Themes on schedule')
        } else if (announcement === 'theme' && changed) {
          this.showHint(desired === 'dark' ? 'Dark theme' : 'Light theme')
        }
        return desired
      } catch (error) {
        console.warn('[auto-dark-mode] scheduled reconciliation failed:', error)
        if (
          announcement !== 'none' &&
          this.isCurrentScheduledRevision(revision)
        ) {
          this.showHint('Theme switch failed', 3000)
        }
        return null
      } finally {
        this.finishThemeOperation(controller)
      }
    })
  }

  private armNextBoundary(revision: number): void {
    if (!this.isCurrentScheduledRevision(revision) || !this.config) return
    this.clearBoundaryTimer()

    const boundary = nextThemeBoundary(
      new Date(),
      this.config.lightTime,
      this.config.darkTime
    )
    const delay = Math.max(250, boundary.at.getTime() - Date.now() + 250)
    this.boundaryTimer = setTimeout(() => {
      this.boundaryTimer = null
      if (!this.isCurrentScheduledRevision(revision)) return
      this.pendingReconcile = this.reconcileScheduled(revision, 'theme')
    }, delay)
    this.boundaryTimer.unref()
  }

  /**
   * Recompute the wall-clock boundary periodically without continuously
   * enforcing the OS theme. If the schedule segment is unchanged, an external
   * manual OS change is left alone. If the clock/time zone jumped across a
   * boundary, reconcile once and continue from the new segment.
   */
  private startClockChecks(revision: number): void {
    this.clockCheckTimer = setInterval(() => {
      if (!this.isCurrentScheduledRevision(revision) || !this.config) return
      const currentSegment = scheduledThemeAt(
        new Date(),
        this.config.lightTime,
        this.config.darkTime
      )
      if (currentSegment !== this.lastScheduleSegment) {
        this.pendingReconcile = this.reconcileScheduled(revision, 'theme')
      } else {
        this.armNextBoundary(revision)
      }
    }, CLOCK_CHECK_INTERVAL_MS)
    this.clockCheckTimer.unref()
  }

  private isCurrentScheduledRevision(revision: number): boolean {
    return (
      this.started &&
      this.enabled &&
      this.revision === revision &&
      this.config?.mode === 'scheduled' &&
      this.configError === null
    )
  }

  private enqueueThemeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation)
    this.operationQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /**
   * Await the reconciliation generation that is current when it completes.
   * If a config change supersedes an in-flight generation, follow the new
   * promise instead of falsely reporting that the explicit Schedule command
   * failed while its replacement succeeds.
   */
  private async waitForLatestReconcile(): Promise<SystemTheme | null> {
    for (;;) {
      const pending = this.pendingReconcile
      const applied = await pending
      if (pending === this.pendingReconcile) return applied
    }
  }

  private isCurrentManualRevision(revision: number): boolean {
    return (
      this.started &&
      this.enabled &&
      this.revision === revision &&
      this.config?.mode === 'manual'
    )
  }

  private beginThemeOperation(): AbortController {
    const controller = new AbortController()
    this.activeThemeAbort = controller
    return controller
  }

  private finishThemeOperation(controller: AbortController): void {
    if (this.activeThemeAbort === controller) {
      this.activeThemeAbort = null
    }
  }

  private cancelActiveThemeOperation(): void {
    const controller = this.activeThemeAbort
    this.activeThemeAbort = null
    controller?.abort()
  }

  private showHint(message: string, durationMs = HINT_DURATION_MS): void {
    if (!this.started) return
    desktopHintWindow.show({
      source: DESKTOP_HINT_SOURCE,
      message,
      durationMs
    })
  }

  private clearBoundaryTimer(): void {
    if (!this.boundaryTimer) return
    clearTimeout(this.boundaryTimer)
    this.boundaryTimer = null
  }

  private clearTimers(): void {
    this.clearBoundaryTimer()
    if (this.clockCheckTimer) {
      clearInterval(this.clockCheckTimer)
      this.clockCheckTimer = null
    }
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer)
      this.wakeTimer = null
    }
  }
}

class ThemeOperationCancelledError extends Error {
  constructor() {
    super('The theme operation was superseded by a settings change.')
    this.name = 'ThemeOperationCancelledError'
  }
}

export const autoDarkModeService = new AutoDarkModeService()
