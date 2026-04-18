/**
 * Thin wrapper around Groq's OpenAI-compatible audio transcription endpoint.
 * Deliberately uses the global `fetch` + `FormData` / `Blob` (available in
 * Node 18+, which Electron 34 ships) instead of the official `groq` SDK —
 * one less dep and the endpoint is a single POST.
 *
 * Reference: the groq_whisperer Python project we're porting uses
 * `model=whisper-large-v3`, `response_format=text`, `language=en`, plus a
 * biasing prompt. We expose all of that as params.
 */

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
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    throw new GroqError(0, `network error: ${(err as Error).message}`)
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
