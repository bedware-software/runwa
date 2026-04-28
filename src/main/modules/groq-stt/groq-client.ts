/**
 * Thin wrapper around Groq's OpenAI-compatible audio transcription endpoint.
 * Deliberately avoids the official `groq` SDK — one less dep and the endpoint
 * is a single multipart POST.
 *
 * We prefer Electron's `net.fetch` (Chromium network stack) because it handles
 * system proxies/PAC/auth better than Node's undici fetch in desktop app
 * environments. Fall back to Node fetch for resilience.
 *
 * Reference: the groq_whisperer Python project we're porting uses
 * `model=whisper-large-v3`, `response_format=text`, `language=en`, plus a
 * biasing prompt. We expose all of that as params.
 */
import { net } from 'electron'

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'

export interface TranscribeParams {
  apiKey: string
  audio: Uint8Array
  /** Filename + mime hint so the server's content-type sniffer is happy. */
  filename: string
  mimeType: string
  model: string
  /** 'auto' means we omit the param so Whisper auto-detects. */
  language?: string
  /** Optional biasing prompt — short, typically describing the speaker/topic. */
  prompt?: string
  signal?: AbortSignal
}

export interface TranscribeResult {
  text: string
}

export class GroqError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'GroqError'
    this.status = status
  }
}

export async function transcribe(params: TranscribeParams): Promise<TranscribeResult> {
  const {
    apiKey,
    audio,
    filename,
    mimeType,
    model,
    language,
    prompt,
    signal
  } = params

  if (!apiKey || apiKey.trim() === '') {
    throw new GroqError(0, 'Groq API key is empty — set it in runwa Settings → Groq Transcription.')
  }

  const form = new FormData()
  // Blob copy is fine: typical utterance is ~100 KB of webm/opus.
  // Cast to BlobPart covers the Uint8Array<ArrayBufferLike> / BufferSource
  // mismatch between Node's global Blob types and the lib.dom.d.ts shape
  // that electron-vite pulls in for the main tsconfig.
  const blob = new Blob([audio as unknown as BlobPart], { type: mimeType })
  form.append('file', blob, filename)
  form.append('model', model)
  form.append('response_format', 'text')
  if (language && language !== 'auto') {
    form.append('language', language)
  }
  if (prompt && prompt.trim() !== '') {
    form.append('prompt', prompt.trim())
  }

  let response: Response
  try {
    response = await requestTranscription({
      apiKey,
      form,
      signal
    })
  } catch (err) {
    if (isAbortError(err)) throw err
    throw new GroqError(0, `network error: ${describeNetworkError(err)}`)
  }

  const bodyText = await response.text()
  if (!response.ok) {
    // Groq returns JSON errors like `{"error":{"message":"...","type":"...","code":"..."}}`
    // but a 5xx can come back as plain text — handle both.
    let message = bodyText
    try {
      const parsed = JSON.parse(bodyText) as {
        error?: { message?: string }
      }
      if (parsed?.error?.message) message = parsed.error.message
    } catch {
      /* keep raw body */
    }
    throw new GroqError(response.status, message || `HTTP ${response.status}`)
  }

  // response_format=text → body is the raw transcription with trailing newline.
  return { text: bodyText.trim() }
}

interface RequestTranscriptionParams {
  apiKey: string
  form: FormData
  signal?: AbortSignal
}

async function requestTranscription(params: RequestTranscriptionParams): Promise<Response> {
  const { apiKey, form, signal } = params
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal
  }

  try {
    return await net.fetch(ENDPOINT, init)
  } catch (err) {
    if (isAbortError(err)) throw err
    const netError = describeNetworkError(err)
    console.warn(`[groq-stt] net.fetch failed, falling back to global fetch: ${netError}`)

    try {
      return await fetch(ENDPOINT, init)
    } catch (fallbackErr) {
      if (isAbortError(fallbackErr)) throw fallbackErr
      const fallbackError = describeNetworkError(fallbackErr)
      throw new Error(`net.fetch=${netError}; fetch=${fallbackError}`)
    }
  }
}

function isAbortError(err: unknown): boolean {
  return !!(err && typeof err === 'object' && 'name' in err && err.name === 'AbortError')
}

function describeNetworkError(err: unknown): string {
  const segments: string[] = []
  const queue: unknown[] = [err]
  const seen = new Set<unknown>()
  let safety = 0

  while (queue.length > 0 && safety < 12) {
    safety += 1
    const current = queue.shift()
    if (current == null || seen.has(current)) continue
    seen.add(current)
    segments.push(formatSingleError(current))

    if (typeof current === 'object') {
      const rec = current as Record<string, unknown>
      if (rec.cause) queue.push(rec.cause)
      if (Array.isArray(rec.errors)) queue.push(...rec.errors)
    }
  }

  const unique = segments.filter((item, idx) => item && segments.indexOf(item) === idx)
  return unique.join(' <- ')
}

function formatSingleError(err: unknown): string {
  if (typeof err === 'string') return err
  if (!err || typeof err !== 'object') return String(err)

  const rec = err as Record<string, unknown>
  const message = pickString(rec, 'message') || String(err)
  const code = pickString(rec, 'code')
  const errno = pickString(rec, 'errno')
  const syscall = pickString(rec, 'syscall')
  const address = pickString(rec, 'address')
  const port = pickString(rec, 'port')

  const metaParts = [code, errno, syscall, address, port].filter(Boolean)
  if (metaParts.length === 0) return message
  return `${message} (${metaParts.join(', ')})`
}

function pickString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}
