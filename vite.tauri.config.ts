import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'path'

/**
 * Renderer build for the Tauri shell (`npm run tauri:dev` / `tauri:build`).
 *
 * The same React app, entry and aliases as the `renderer` block of
 * electron.vite.config.ts — only the output folder and dev-server port
 * differ, so both shells can run side by side during the migration.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  clearScreen: false,
  server: {
    port: 5174,
    strictPort: true
  },
  build: {
    outDir: resolve(__dirname, 'out/tauri-renderer'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/index.html')
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react(), tailwindcss()]
})
