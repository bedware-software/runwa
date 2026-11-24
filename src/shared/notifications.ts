import type { ModuleConfigValue } from './types'

/**
 * Notifications module — the one surface every module publishes its
 * on-screen notes through (the strip at the edge of the screen), plus the
 * `runwa-notify` command that lets a script show one.
 */
export const NOTIFICATIONS_ID = 'notifications'

export const NOTIFICATIONS_LOOK_KEY = 'look'
export const NOTIFICATIONS_POSITION_KEY = 'position'
export const NOTIFICATIONS_DURATION_KEY = 'defaultDuration'
export const NOTIFICATIONS_SYSTEM_KEY = 'systemNotifications'
export const NOTIFICATIONS_TEST_ACTION = 'test'

export const NOTIFICATION_POSITIONS = [
  'bottom-center',
  'top-center',
  'bottom-left',
  'bottom-right',
  'top-left',
  'top-right'
] as const
export type NotificationPosition = (typeof NOTIFICATION_POSITIONS)[number]
export const DEFAULT_NOTIFICATION_POSITION: NotificationPosition = 'bottom-center'

/** The design system's four Toast looks; the owner's default is the plate. */
export const NOTIFICATION_LOOKS = ['plate', 'bar', 'tag', 'line'] as const
export type NotificationLook = (typeof NOTIFICATION_LOOKS)[number]
export const DEFAULT_NOTIFICATION_LOOK: NotificationLook = 'plate'

/** Stored as strings because module config radios hold strings. */
export const NOTIFICATION_DURATIONS_MS = [2000, 3000, 4000, 6000, 10000] as const
export const DEFAULT_NOTIFICATION_DURATION_MS = 4000

/** Where errors and "update ready" go: the OS notification centre or the strip. */
export type SystemNotificationsTarget = 'os' | 'runwa'

export const NOTIFICATION_TONES = ['neutral', 'error', 'success'] as const
export type NotificationTone = (typeof NOTIFICATION_TONES)[number]

/** Limits for anything that arrives from outside the app (`runwa-notify`). */
export const NOTIFICATION_TITLE_MAX = 80
export const NOTIFICATION_TEXT_MAX = 300
export const NOTIFICATION_MIN_DURATION_MS = 1000
export const NOTIFICATION_MAX_DURATION_MS = 30000

export interface NotificationsConfig {
  look: NotificationLook
  position: NotificationPosition
  defaultDurationMs: number
  systemNotifications: SystemNotificationsTarget
}

export function readNotificationsConfig(
  stored: Record<string, ModuleConfigValue> | undefined
): NotificationsConfig {
  const look = stored?.[NOTIFICATIONS_LOOK_KEY]
  const position = stored?.[NOTIFICATIONS_POSITION_KEY]
  const duration = Number(stored?.[NOTIFICATIONS_DURATION_KEY])
  return {
    look: (NOTIFICATION_LOOKS as readonly unknown[]).includes(look)
      ? (look as NotificationLook)
      : DEFAULT_NOTIFICATION_LOOK,
    position: (NOTIFICATION_POSITIONS as readonly unknown[]).includes(position)
      ? (position as NotificationPosition)
      : DEFAULT_NOTIFICATION_POSITION,
    defaultDurationMs: (NOTIFICATION_DURATIONS_MS as readonly number[]).includes(duration)
      ? duration
      : DEFAULT_NOTIFICATION_DURATION_MS,
    systemNotifications:
      stored?.[NOTIFICATIONS_SYSTEM_KEY] === 'runwa' ? 'runwa' : 'os'
  }
}

/** What Settings shows in the "From the console" block. */
export interface NotificationsCliInfo {
  /** Full path of the `runwa-notify` command for this OS. */
  commandPath: string
  /** A ready-to-paste example line for the user's shell. */
  example: string
  /** Folder the command drops its request into. */
  inboxDir: string
}
