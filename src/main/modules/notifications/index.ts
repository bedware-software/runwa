import { app } from 'electron'
import path from 'path'
import type { ModuleManifest } from '@shared/types'
import {
  DEFAULT_NOTIFICATION_DURATION_MS,
  DEFAULT_NOTIFICATION_LOOK,
  DEFAULT_NOTIFICATION_POSITION,
  NOTIFICATION_DURATIONS_MS,
  NOTIFICATIONS_DURATION_KEY,
  NOTIFICATIONS_ID,
  NOTIFICATIONS_LOOK_KEY,
  NOTIFICATIONS_POSITION_KEY,
  NOTIFICATIONS_SYSTEM_KEY,
  NOTIFICATIONS_TEST_ACTION,
  type NotificationsCliInfo
} from '@shared/notifications'
import type { PaletteModule } from '../types'
import { notifications } from './service'

/**
 * Notifications — the strip at the edge of the screen that every module
 * reports through, and the `runwa-notify` command for scripts.
 *
 * Service-kind module: no palette presence. The work is in service.ts
 * (started from src/main/index.ts) and inbox.ts; this file is the manifest
 * and the Test button. Settings adds NotificationsSection under the generic
 * fields for the "From the console" block.
 */

const MANIFEST: ModuleManifest = {
  id: NOTIFICATIONS_ID,
  name: 'Notifications',
  icon: 'bell',
  kind: 'service',
  description:
    'The strip where Runwa’s modules report what they are doing — the active Ulanzi profile, recording, a reloaded config — and where scripts can show a message.',
  defaultEnabled: true,
  supportsDirectLaunch: false,
  configFields: [
    {
      type: 'radio',
      key: NOTIFICATIONS_LOOK_KEY,
      label: 'Look',
      description:
        'Plate is a coloured plate: yellow, red for an error, green for success. Bar and Tag are dark panels with the tone on the left edge or on a title tag. Line is a quiet dark strip. The Test button below shows the chosen one.',
      defaultValue: DEFAULT_NOTIFICATION_LOOK,
      options: [
        { value: 'plate', label: 'Plate' },
        { value: 'bar', label: 'Bar' },
        { value: 'tag', label: 'Tag' },
        { value: 'line', label: 'Line' }
      ]
    },
    {
      type: 'radio',
      key: NOTIFICATIONS_POSITION_KEY,
      label: 'Position',
      description: 'Shown on the display the pointer is on.',
      defaultValue: DEFAULT_NOTIFICATION_POSITION,
      options: [
        { value: 'bottom-center', label: 'Bottom' },
        { value: 'top-center', label: 'Top' },
        { value: 'bottom-left', label: 'Bottom left' },
        { value: 'bottom-right', label: 'Bottom right' },
        { value: 'top-left', label: 'Top left' },
        { value: 'top-right', label: 'Top right' }
      ]
    },
    {
      type: 'radio',
      key: NOTIFICATIONS_DURATION_KEY,
      label: 'Default duration',
      description:
        'For notifications that don’t set their own: the ones sent from the console, the test one, and errors shown in the strip.',
      defaultValue: String(DEFAULT_NOTIFICATION_DURATION_MS),
      options: NOTIFICATION_DURATIONS_MS.map((ms) => ({
        value: String(ms),
        label: `${ms / 1000} s`
      }))
    },
    {
      type: 'radio',
      key: NOTIFICATIONS_SYSTEM_KEY,
      label: 'Errors and update notices',
      description:
        'Groq Transcription errors and “update ready”. In the strip they are silent while this module is off; the system notification centre shows them either way.',
      defaultValue: 'os',
      options: [
        { value: 'os', label: 'System notification centre' },
        { value: 'runwa', label: 'Runwa strip' }
      ]
    },
    {
      type: 'action',
      key: NOTIFICATIONS_TEST_ACTION,
      label: 'Test',
      description: 'Shows a sample notification with a title and a text.',
      buttonLabel: 'Show a test notification',
      icon: 'bell'
    }
  ]
}

export function notificationsCliInfo(): NotificationsCliInfo {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'cli')
    : path.join(app.getAppPath(), 'resources', 'cli')
  const commandPath = path.join(
    dir,
    process.platform === 'win32' ? 'runwa-notify.cmd' : 'runwa-notify'
  )
  const args = '--title "Build" --text "Finished in 74 s"'
  return {
    commandPath,
    // PowerShell needs the call operator to run a quoted path.
    example:
      process.platform === 'win32'
        ? `& "${commandPath}" ${args}`
        : `"${commandPath}" ${args}`,
    inboxDir: notifications.getInboxDir()
  }
}

export function createNotificationsModule(): PaletteModule {
  return {
    manifest: MANIFEST,

    // Background service only — never surfaced in the palette picker.
    async search() {
      return []
    },

    async execute() {
      return { dismissPalette: false }
    },

    onAction(key) {
      if (key !== NOTIFICATIONS_TEST_ACTION) return
      notifications.showBriefly({
        source: `${NOTIFICATIONS_ID}:test`,
        title: 'Runwa',
        message: 'This is what a notification looks like.'
      })
    }
  }
}
