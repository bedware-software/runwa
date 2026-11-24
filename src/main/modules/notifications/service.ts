import { app, nativeImage, Notification } from 'electron'
import path from 'path'
import type { DesktopHintPayload, Settings } from '@shared/types'
import {
  NOTIFICATIONS_ID,
  readNotificationsConfig,
  type NotificationsConfig
} from '@shared/notifications'
import { desktopHintWindow } from '../../desktop-hint-window'
import { settingsStore } from '../../settings-store'
import { NotificationInbox } from './inbox'

/** What a module passes to `notifications.show`. */
export type NotificationRequest = Omit<DesktopHintPayload, 'position' | 'look'>

/** A message that used to go straight to the OS notification centre. */
export interface SystemNotification {
  source: string
  title: string
  body: string
  /** Critical ones make a sound in the OS centre and read as errors in the strip. */
  urgency?: 'low' | 'normal' | 'critical'
}

/**
 * The one way anything in Runwa puts a note on screen.
 *
 * Modules call `show` / `hide` with a `source` they own; the strip shows one
 * note at a time — the newest — and falls back to the previous one when it
 * expires (see DesktopHintWindow). Turning the Notifications module off
 * silences all of it, ongoing statuses included; they come back when it is
 * turned on again if their owner hasn't taken them down.
 *
 * Started from src/main/index.ts before any module can publish.
 */
class NotificationsService {
  private started = false
  private enabled = true
  private config: NotificationsConfig = readNotificationsConfig(undefined)
  private readonly inbox = new NotificationInbox((request) => {
    this.show({
      ...request,
      durationMs: request.durationMs ?? this.config.defaultDurationMs
    })
  })

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
    this.inbox.stop()
  }

  /** Show or replace the note owned by `request.source`. */
  show(request: NotificationRequest): void {
    // Published even while the module is off: the window keeps it muted, so
    // an ongoing status is there to show once the module is turned on.
    desktopHintWindow.show(request)
  }

  /** Take down the note owned by `source`. */
  hide(source: string): void {
    desktopHintWindow.hide(source)
  }

  /** A one-shot note without a lifetime of its own: uses the module's default. */
  showBriefly(request: NotificationRequest): void {
    this.show({
      ...request,
      durationMs: request.durationMs ?? this.config.defaultDurationMs
    })
  }

  /**
   * Errors and "update ready". Goes to the OS notification centre or to the
   * strip, by the module's setting. The OS path does not depend on the module
   * being on — it is what these messages did before the module existed; the
   * strip path is silent while the module is off, like everything else on it.
   */
  system(note: SystemNotification): void {
    if (this.config.systemNotifications === 'runwa') {
      this.showBriefly({
        source: note.source,
        title: note.title,
        message: note.body,
        ...(note.urgency === 'critical' ? { tone: 'error' as const } : {})
      })
      return
    }
    if (!Notification.isSupported()) {
      console.log(`[notifications] ${note.title}: ${note.body}`)
      return
    }
    try {
      new Notification({
        title: note.title,
        body: note.body,
        silent: note.urgency !== 'critical',
        icon: getNotificationIcon()
      }).show()
    } catch (err) {
      console.warn('[notifications] OS notification failed:', err)
    }
  }

  getInboxDir(): string {
    return this.inbox.dir()
  }

  private reconfigure(settings: Settings): void {
    const moduleSettings = settings.modules[NOTIFICATIONS_ID]
    this.enabled = this.started && (moduleSettings?.enabled ?? true)
    this.config = readNotificationsConfig(moduleSettings?.config)

    desktopHintWindow.setPresentation(this.config.position, this.config.look)
    desktopHintWindow.setMuted(!this.enabled)
    // Requests from the console are only read while the module is on, so
    // nothing queues up to appear all at once later.
    if (this.enabled) this.inbox.start()
    else this.inbox.stop()
  }
}

let notificationIcon: Electron.NativeImage | null = null
function getNotificationIcon(): Electron.NativeImage | undefined {
  if (notificationIcon) return notificationIcon
  try {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(app.getAppPath(), 'resources', 'icon.png')
    notificationIcon = nativeImage.createFromPath(iconPath)
    return notificationIcon
  } catch {
    return undefined
  }
}

export const notifications = new NotificationsService()
