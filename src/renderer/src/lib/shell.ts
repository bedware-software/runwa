/**
 * Which desktop shell hosts this renderer. The React app runs unchanged on
 * Electron (preload-provided `window.electronAPI`) and on Tauri (the bridge
 * in `tauri-bridge.ts`); this is the one place that tells them apart.
 */
export function isTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
