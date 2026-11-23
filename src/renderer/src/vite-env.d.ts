/// <reference types="vite/client" />

declare module 'lucide-react/dist/esm/icons/*.js' {
  import type { LucideIcon } from 'lucide-react'

  const icon: LucideIcon
  export default icon
}

/** Version of the installed @bedware/ui package, injected at build time
 * by `define` in electron.vite.config.ts. */
declare const __BEDWARE_UI_VERSION__: string
