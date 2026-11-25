// Reads the real module manifests (names, descriptions, config fields, default
// hotkeys) out of src/main/modules without starting Electron.
//
// The module files are bundled with esbuild and every runtime dependency that
// only exists inside the app — electron, the native addon, uiohook, the stores
// on disk — is swapped for an inert stand-in. Only the factories are called;
// nothing is started, hooked or written.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const ENTRY = `
import { createWindowSwitcherModule } from './src/main/modules/window-switcher'
import { createAppSearchModule } from './src/main/modules/app-search'
import { createCommandPaletteModule } from './src/main/modules/command-palette'
import { createKeyboardRemapModule } from './src/main/modules/keyboard-remap'
import { createGroqSttModule } from './src/main/modules/groq-stt'
import { createHotstringsModule } from './src/main/modules/hotstrings'
import { createFlashcardsModule } from './src/main/modules/flashcards'
import { createUserCommandsModule } from './src/main/modules/user-commands'
import { createAutoDarkModeModule } from './src/main/modules/auto-dark-mode'
import { createUlanziModule } from './src/main/modules/ulanzi'
import { createNotificationsModule } from './src/main/modules/notifications'

// Same order as registerModules() in src/main/modules/index.ts.
export function manifests() {
  const others = [
    createAppSearchModule(),
    createWindowSwitcherModule(),
    createUserCommandsModule(),
    createFlashcardsModule(),
    createKeyboardRemapModule(),
    createHotstringsModule(),
    createAutoDarkModeModule(),
    createUlanziModule(),
    createGroqSttModule(),
    createNotificationsModule()
  ]
  const palette = createCommandPaletteModule(
    others.map((m) => ({ id: m.manifest.id, name: m.manifest.name, icon: m.manifest.icon }))
  )
  const [appSearch, windowSwitcher, ...rest] = others
  return [appSearch, windowSwitcher, palette, ...rest].map((m) => m.manifest)
}
`

// Anything asked of it answers with itself: callable, constructible, endless.
const INERT = `
const inert = new Proxy(function () {}, {
  get: (_t, key) =>
    key === 'then' ? undefined
    : key === Symbol.toPrimitive ? () => ''
    : key === Symbol.iterator ? function* () {}
    : key === '__esModule' ? true
    : key === 'app' && globalThis.__RUNWA_SHOTS_APP__ ? globalThis.__RUNWA_SHOTS_APP__
    : inert,
  // esbuild's import wrapper copies own keys onto an object whose prototype is
  // the module's: answering as its own prototype keeps named imports working.
  getPrototypeOf: () => inert,
  apply: () => inert,
  construct: () => inert
})
module.exports = inert
`

const STUBBED = /^(electron|electron-store|electron-updater|uiohook-napi)$/

const inertPlugin = {
  name: 'inert',
  setup(b) {
    b.onResolve({ filter: STUBBED }, (args) => ({ path: args.path, namespace: 'inert' }))
    // The native addon and its generated loader.
    b.onResolve({ filter: /(\.node$|[\\/]native([\\/]index)?(\.js)?$)/ }, (args) => ({
      path: args.path,
      namespace: 'inert'
    }))
    b.onLoad({ filter: /.*/, namespace: 'inert' }, () => ({ contents: INERT, loader: 'js' }))
  }
}

export async function readManifests(outDir) {
  mkdirSync(outDir, { recursive: true })
  const outfile = resolve(outDir, 'manifests.cjs')
  await build({
    stdin: { contents: ENTRY, resolveDir: root, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'silent',
    alias: { '@shared': resolve(root, 'src/shared') },
    plugins: [inertPlugin]
  })
  // Electron-only global some modules read while loading.
  process.resourcesPath ??= resolve(root, 'resources')
  // Some factories prepare their folder under userData as they are created
  // (Flashcards makes its decks folder). They get an empty throwaway folder,
  // never the real %APPDATA%\Runwa.
  const sandbox = resolve(outDir, 'userdata')
  mkdirSync(sandbox, { recursive: true })
  globalThis.__RUNWA_SHOTS_APP__ = new Proxy(
    {
      isPackaged: false,
      getPath: () => sandbox,
      getAppPath: () => root,
      getName: () => 'Runwa',
      getVersion: () => '0.0.0'
    },
    { get: (target, key) => (key in target ? target[key] : () => undefined) }
  )
  const mod = await import(pathToFileURL(outfile).href)
  // Through JSON: drops anything that isn't plain data.
  return JSON.parse(JSON.stringify((mod.default ?? mod).manifests()))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(root, 'release', 'screenshots-preview', '.work')
  const list = await readManifests(out)
  writeFileSync(resolve(out, 'manifests.json'), JSON.stringify(list, null, 2))
  for (const m of list) console.log(`${m.id}: ${m.name} (${m.configFields?.length ?? 0} fields)`)
}
