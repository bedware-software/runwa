import { clipboard, Notification, nativeImage, app } from 'electron'
import path from 'path'
import type { ModuleConfigValue, ModuleManifest } from '@shared/types'
import type { DirectLaunchEvent, PaletteModule } from '../types'
import { settingsStore } from '../../settings-store'
import { recorderWindow } from './recorder-window'
import { indicatorWindow } from './indicator-window'
import { GroqError, transcribe } from './groq-client'
import { simulatePaste } from './uiohook-bridge'

/**
 * Groq-powered voice-to-text, modeled after the `groq_whisperer` Python
 * project (hold-to-talk captures mic audio, Groq Whisper transcribes it,
 * result lands on the system clipboard). Users bind a direct-launch hotkey
 * in Settings; depending on the `mode` config it behaves as push-to-talk
 * (hold to record, release to transcribe) or toggle (press to start, press
 * again to stop and transcribe).
 */

const MODULE_ID = 'groq-stt'

const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'whisper-large-v3', label: 'Whisper Large v3' },
  { value: 'whisper-large-v3-turbo', label: 'Whisper Large v3 Turbo' }
]

const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Russian' },
  { value: 'de', label: 'German' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' }
]

const MANIFEST: ModuleManifest = {
  id: MODULE_ID,
  name: 'Groq Transcription',
  icon: 'mic',
  // Hotkey-only utility — no palette-searchable surface, so it's a
  // service-kind module (never shown in the home picker).
  kind: 'service',
  description:
    'Hold (or toggle) a hotkey to record your voice; Groq Whisper transcribes it and the result lands on your clipboard.',
  defaultEnabled: false,
  supportsDirectLaunch: true,
  defaultDirectLaunchHotkey: 'Ctrl+Super',
  configFields: [
    {
      key: 'apiKey',
      type: 'text',
      label: 'Groq API key',
      description:
        'Create one at console.groq.com/keys. Stored locally in runwa-settings.json.',
      secret: true,
      placeholder: 'gsk_…',
      defaultValue: ''
    },
    {
      key: 'mode',
      type: 'radio',
      label: 'Hotkey mode',
      description:
        'Push-to-talk: hold the direct-launch hotkey while speaking. Toggle: press once to start, press again to stop. Push-to-talk needs the native key hook (uiohook-napi); falls back to toggle if the library is missing.',
      defaultValue: 'push-to-talk',
      options: [
        { value: 'push-to-talk', label: 'Push-to-talk (hold)' },
        { value: 'toggle', label: 'Toggle (press/press)' }
      ]
    },
    {
      key: 'model',
      type: 'radio',
      label: 'Model',
      defaultValue: 'whisper-large-v3',
      options: MODEL_OPTIONS
    },
    {
      key: 'language',
      type: 'radio',
      label: 'Language',
      description:
        'Hinted to the model. "Auto" lets Whisper detect; pick a specific language for faster and more accurate results.',
      defaultValue: 'auto',
      options: LANGUAGE_OPTIONS
    },
    {
      key: 'prompt',
      type: 'text',
      label: 'Biasing prompt',
      description:
        'Optional short hint about the speaker/topic. Improves recognition of domain-specific vocabulary (names, jargon, library references).',
      defaultValue:
        'Programmer discussing about programming in English and Russian. React, Kubernetis, Control+M and etc.',
      placeholder: 'e.g. "programmer discussing TypeScript and Electron"',
      multiline: true
    }
  ]
}

type TranscriptionState = 'idle' | 'recording' | 'transcribing'

interface SessionState {
  state: TranscriptionState
  /** Promise of the active recording's audio buffer, if any. */
  recordingResult: Promise<{ data: Uint8Array; mimeType: string }> | null
}

function getConfig(): Record<string, ModuleConfigValue> {
  const settings = settingsStore.get()
  const stored = settings.modules[MODULE_ID]?.config ?? {}
  const defaults: Record<string, ModuleConfigValue> = {}
  for (const field of MANIFEST.configFields ?? []) {
    defaults[field.key] = field.defaultValue as ModuleConfigValue
  }
  return { ...defaults, ...stored }
}

function configString(cfg: Record<string, ModuleConfigValue>, key: string): string {
  const v = cfg[key]
  return typeof v === 'string' ? v : ''
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

function notify(title: string, body: string, urgency: 'low' | 'normal' | 'critical' = 'low'): void {
  if (!Notification.isSupported()) {
    console.log(`[groq-stt] ${title}: ${body}`)
    return
  }
  try {
    const n = new Notification({
      title,
      body,
      silent: urgency !== 'critical',
      icon: getNotificationIcon()
    })
    n.show()
  } catch (err) {
    console.warn('[groq-stt] notification failed:', err)
  }
}

export function createGroqSttModule(): PaletteModule {
  const state: SessionState = {
    state: 'idle',
    recordingResult: null
  }

  const beginRecording = (): void => {
    if (state.state !== 'idle') return
    const cfg = getConfig()
    const apiKey = configString(cfg, 'apiKey').trim()
    if (!apiKey) {
      notify(
        'Groq Transcription',
        'Set your Groq API key in Settings → Groq Transcription before using this hotkey.',
        'critical'
      )
      return
    }

    // Synchronously mark recording + capture the promise so a near-instant
    // release/toggle event sees a real in-flight result instead of null.
    state.state = 'recording'
    indicatorWindow.setState('recording')
    state.recordingResult = recorderWindow.start()
    // Swallow unhandled-rejection noise for the fire-and-forget case where
    // the user never releases the key (app quits mid-recording, etc.).
    // The real error handling lives in endRecording after it awaits.
    state.recordingResult.catch(() => {
      /* handled in endRecording */
    })
  }

  const endRecording = async (): Promise<void> => {
    if (state.state !== 'recording' || !state.recordingResult) return
    state.state = 'transcribing'
    indicatorWindow.setState('transcribing')
    recorderWindow.stop()
    let audio: { data: Uint8Array; mimeType: string }
    try {
      audio = await state.recordingResult
    } catch (err) {
      state.state = 'idle'
      state.recordingResult = null
      indicatorWindow.setState('hidden')
      notify('Groq Transcription', `Recording failed: ${(err as Error).message}`, 'critical')
      return
    }
    state.recordingResult = null

    const cfg = getConfig()
    const apiKey = configString(cfg, 'apiKey').trim()
    const model = configString(cfg, 'model') || 'whisper-large-v3'
    const language = configString(cfg, 'language')
    const prompt = configString(cfg, 'prompt')

    try {
      const { text } = await transcribe({
        apiKey,
        audio: audio.data,
        filename: pickFilename(audio.mimeType),
        mimeType: audio.mimeType,
        model,
        language,
        prompt
      })
      if (text) {
        clipboard.writeText(text)
        // Auto-paste: briefly yield so the indicator's hide + focus
        // handoff settles, then synthesize Ctrl+V (or Cmd+V) into
        // whatever window currently has keyboard focus. If uiohook
        // isn't loaded, simulatePaste() returns false and the user
        // still has the text on their clipboard for a manual paste.
        state.state = 'idle'
        indicatorWindow.setState('hidden')
        setTimeout(() => {
          simulatePaste()
        }, 40)
        return
      }
      // Empty response: silent — the indicator disappearing with
      // nothing getting pasted is enough of a signal. No notification.
    } catch (err) {
      if (err instanceof GroqError) {
        notify('Groq Transcription', `API error (${err.status}): ${err.message}`, 'critical')
      } else {
        notify('Groq Transcription', `Transcription failed: ${(err as Error).message}`, 'critical')
      }
    } finally {
      state.state = 'idle'
      indicatorWindow.setState('hidden')
    }
  }

  const handleDirectLaunch = (event: DirectLaunchEvent): void => {
    // Uniform press semantics: press-while-idle starts recording,
    // press-while-recording stops it. Works for the two live paths:
    //
    //   - Toggle mode: we register via Electron's globalShortcut (press
    //     only). Each press flips the state.
    //   - Push-to-talk *fallback*: uiohook-napi failed to load, so we
    //     also only get presses — same press-to-toggle behavior
    //     ensures the module doesn't get stuck in "recording" with no
    //     way to stop.
    //
    // Release events are meaningful only in real push-to-talk (uiohook
    // hooked up): they close out the session the press opened.
    if (event === 'press') {
      if (state.state === 'recording') {
        void endRecording()
      } else if (state.state === 'idle') {
        void beginRecording()
      }
      // Presses during the 'transcribing' window are ignored so a
      // stray double-tap doesn't try to start a new session mid-request.
      return
    }

    // event === 'release' — only fires when uiohook is available.
    // Close the session only if we're still holding one open; ignore
    // any release that arrives after a press-toggle has already ended it.
    if (state.state === 'recording') {
      void endRecording()
    }
  }

  const wantsKeyUpEvents = (): boolean => {
    const cfg = getConfig()
    const mode = configString(cfg, 'mode') || 'push-to-talk'
    return mode === 'push-to-talk'
  }

  return {
    manifest: MANIFEST,

    // This module is hotkey-only by design: a mouse click can't give us
    // the keyup needed for push-to-talk, and the palette item would
    // pollute every empty-query search (sitting next to open windows,
    // apps, etc.). Discovery lives in Settings → Groq Transcription.
    async search() {
      return []
    },

    async execute() {
      return { dismissPalette: false }
    },

    handleDirectLaunch,
    wantsKeyUpEvents,

    async dispose() {
      if (state.state === 'recording') {
        recorderWindow.stop()
      }
      state.state = 'idle'
      state.recordingResult = null
    }
  }
}

function pickFilename(mimeType: string): string {
  if (mimeType.includes('webm')) return 'audio.webm'
  if (mimeType.includes('ogg')) return 'audio.ogg'
  if (mimeType.includes('mp4')) return 'audio.mp4'
  if (mimeType.includes('wav')) return 'audio.wav'
  return 'audio.webm'
}

