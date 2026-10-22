import type { Settings } from '@shared/types'
import {
  ULANZI_BRIEF_HINT_MS,
  ULANZI_ID,
  readUlanziProfileRules,
  resolveUlanziDisplay,
  ulanziProfileRule,
  type UlanziProfileRules,
  type UlanziResolvedDisplay
} from '@shared/ulanzi'
import { desktopHintWindow } from '../../desktop-hint-window'
import { settingsStore } from '../../settings-store'
import { UlanziProfileWatcher } from './profile-watcher'
import { listUlanziProfiles, ulanziConfigDir } from './profiles'

const DESKTOP_HINT_SOURCE = ULANZI_ID

/**
 * Shows the active Ulanzi profile in the shared Desktop Hint.
 *
 * The Vibe Key has no screen, so the knob's current mode (a profile the
 * user toggles from the device, like "Newbro Tabs") is otherwise invisible.
 * Each switch is announced once; a sticky profile stays on screen as an
 * ongoing status until another profile becomes active. When watching
 * starts, a sticky profile that is already active is shown too — it is
 * state the user can't see otherwise — but nothing brief is replayed.
 */
class UlanziService {
  private started = false
  private enabled = false
  private rules: UlanziProfileRules = {}
  /** Serialized `rules`, to tell an edit of ours from another module's. */
  private rulesKey = ''
  private watcher: UlanziProfileWatcher | null = null
  /** Last profile the watcher reported. */
  private currentProfile: string | null = null
  /** Latest update wins when manifest reads overlap. */
  private updateToken = 0

  private readonly onSettingsChange = (settings: Settings): void => {
    this.reconfigure(settings)
  }

  start(): void {
    if (this.started) return
    this.started = true
    settingsStore.on('change', this.onSettingsChange)
    this.reconfigure(settingsStore.get())
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    settingsStore.off('change', this.onSettingsChange)
    this.enabled = false
    this.stopWatching()
  }

  private reconfigure(settings: Settings): void {
    const moduleSettings = settings.modules[ULANZI_ID]
    const enabled = this.started && (moduleSettings?.enabled ?? false)
    const rules = readUlanziProfileRules(moduleSettings?.config)
    const rulesKey = JSON.stringify(rules)
    const rulesChanged = rulesKey !== this.rulesKey
    this.rules = rules
    this.rulesKey = rulesKey

    if (enabled !== this.enabled) {
      this.enabled = enabled
      if (enabled) this.startWatching()
      else this.stopWatching()
      return
    }
    // An edit in the table applies to the active profile right away: making
    // it sticky shows it, making it brief or hidden takes it down.
    if (enabled && rulesChanged && this.currentProfile) {
      void this.update(this.currentProfile, false)
    }
  }

  private startWatching(): void {
    const configDir = ulanziConfigDir()
    if (!configDir) {
      console.info(`[ulanzi] unsupported on ${process.platform}`)
      return
    }
    this.watcher = new UlanziProfileWatcher(configDir, (profile, initial) => {
      this.currentProfile = profile
      if (!initial) console.log(`[ulanzi] profile → ${profile}`)
      void this.update(profile, !initial)
    })
    this.watcher.start()
  }

  private stopWatching(): void {
    this.watcher?.stop()
    this.watcher = null
    this.currentProfile = null
    this.updateToken += 1
    this.clearHint()
  }

  /**
   * Bring the hint in line with `profile`. `switched` is true when the user
   * just switched to it; false re-applies existing state (watching started,
   * a setting changed), which shows a sticky profile but never replays a
   * brief one.
   */
  private async update(profile: string, switched: boolean): Promise<void> {
    const token = ++this.updateToken
    const rule = ulanziProfileRule(this.rules, profile)

    // `auto` needs to know whether the profile follows an app, which only
    // Ulanzi's manifests say. They're re-read each time so a binding edited
    // in Ulanzi Studio is picked up without a restart.
    let display: UlanziResolvedDisplay
    if (rule.display === 'auto') {
      const view = await listUlanziProfiles().catch(() => null)
      if (token !== this.updateToken || !this.enabled) return
      display = resolveUlanziDisplay(
        rule,
        view?.profiles.find((p) => p.name === profile)
      )
    } else {
      display = rule.display
    }

    const message = rule.label.trim() || profile
    if (display === 'sticky') {
      desktopHintWindow.show({ source: DESKTOP_HINT_SOURCE, message })
    } else if (display === 'brief' && switched) {
      desktopHintWindow.show({
        source: DESKTOP_HINT_SOURCE,
        message,
        durationMs: ULANZI_BRIEF_HINT_MS
      })
    } else {
      this.clearHint()
    }
  }

  private clearHint(): void {
    desktopHintWindow.hide(DESKTOP_HINT_SOURCE)
  }
}

export const ulanziService = new UlanziService()
