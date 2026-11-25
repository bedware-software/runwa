// Takes pictures of Runwa's windows without starting Runwa.
//
//   npm run screenshots        (builds the renderer first)
//
// The built renderer (out/renderer) is opened in headless Chromium through
// Playwright. In place of the preload script the page gets a stand-in API
// (scripts/screenshots/stub.mjs) that answers with invented sample data
// (fixtures.mjs) and the real module manifests read from the source
// (manifests.mjs). No Electron, no main process, no hooks, no administrator
// rights, and no window on the screen — the browser is headless.
//
// Output: release/screenshots-preview/*.png (the folder is git-ignored).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { readManifests } from './screenshots/manifests.mjs'
import { fixtures, settingsFrom } from './screenshots/fixtures.mjs'
import { installStub } from './screenshots/stub.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const rendererDir = join(root, 'out', 'renderer')
const outDir = join(root, 'release', 'screenshots-preview')
const workDir = join(outDir, '.work')

// Window sizes as the main process creates them: palette-window.ts
// (DEFAULT_WIDTH / DEFAULT_HEIGHT), settings-window.ts, desktop-hint-window.ts.
const PALETTE = { width: 720, height: 520 }
const SETTINGS = { width: 960, height: 640 }
const HINT = { width: 360, height: 280 }
const SCALE = 2

if (!existsSync(join(rendererDir, 'index.html'))) {
  console.error('out/renderer is missing — run `npm run build` first (npm run screenshots does).')
  process.exit(1)
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json'
}

// The page lives at an address that does not exist: every request is answered
// from out/renderer by the script itself, so nothing goes over the network —
// no port is opened, and software that filters local traffic cannot touch it.
const origin = 'http://runwa.invalid'

function rendererFile(url) {
  const path = decodeURIComponent(new URL(url).pathname)
  const file = normalize(join(rendererDir, path === '/' ? 'index.html' : path))
  if (!file.startsWith(rendererDir) || !existsSync(file) || !statSync(file).isFile()) return null
  return file
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const browser = await chromium.launch({ headless: true })
const taken = []

/**
 * One frame: a fresh page of the given size with the stand-in API installed,
 * `drive` brings it to the state to capture.
 */
async function frame(name, { size, hash, theme = 'dark', settings = {}, transparent = false }, drive) {
  const context = await browser.newContext({
    viewport: size,
    deviceScaleFactor: SCALE,
    colorScheme: theme,
    // Entrance animations would be caught half-way.
    reducedMotion: 'reduce'
  })
  const page = await context.newPage()
  const problems = []
  page.on('pageerror', (err) => problems.push(String(err)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(msg.text())
  })
  // Nothing but the local renderer: any other request is refused.
  await page.route('**/*', (route) => {
    const url = route.request().url()
    if (url.startsWith('data:')) return route.continue()
    const file = url.startsWith(`${origin}/`) ? rendererFile(url) : null
    if (file) {
      return route.fulfill({
        body: readFileSync(file),
        contentType: MIME[extname(file)] ?? 'application/octet-stream'
      })
    }
    // Nothing else is ever fetched; a request for anything else is a finding.
    if (!url.endsWith('/favicon.ico')) problems.push(`refused request: ${url.slice(0, 120)}`)
    return route.abort()
  })
  await page.addInitScript(installStub, {
    manifests,
    settings: settingsFrom(manifests, { theme, ...settings }),
    ...fixtures({ version })
  })
  await page.goto(`${origin}/index.html#${hash}`)
  const clip = (await drive(page)) ?? undefined
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(350)
  const file = join(outDir, `${name}.png`)
  await page.screenshot({ path: file, clip, omitBackground: transparent })
  await context.close()
  taken.push({ name, problems })
  console.log(`  ${name}.png${problems.length ? `  (${problems.length} page error(s))` : ''}`)
  for (const p of problems) console.log(`      ${p}`)
}

/** Play main's part: show the palette on a module, then type like a user. */
const palette = (moduleId, query = '') => async (page) => {
  await page.waitForFunction(() => window.__shots.has('onPaletteShow'))
  await page.evaluate((id) => window.__shots.emit('onPaletteShow', { initialModuleId: id }), moduleId)
  if (query) await page.keyboard.type(query, { delay: 30 })
  await page.waitForTimeout(400)
}

const settingsPage = (keys = []) => async (page) => {
  await page.waitForSelector('[data-vim-form]')
  await page.waitForTimeout(300)
  for (const key of keys) await page.keyboard.press(key)
}

/** A notification in the strip's window, cropped to the toast plus its margin. */
const toast = (payload) => async (page) => {
  await page.waitForFunction(() => window.__shots.has('onDesktopHint'))
  await page.evaluate(
    (p) => window.__shots.emit('onDesktopHint', { position: 'bottom-center', ...p }),
    payload
  )
  const box = await (await page.waitForSelector('.bw-toast')).boundingBox()
  const margin = 24
  return {
    x: Math.max(0, box.x - margin),
    y: Math.max(0, box.y - margin),
    width: Math.min(HINT.width, box.width + margin * 2),
    height: Math.min(HINT.height, box.height + margin * 2)
  }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(workDir, { recursive: true })
const manifests = await readManifests(workDir)

console.log(`Runwa ${version} → ${outDir}`)

// Palette
await frame('palette-app-search', { size: PALETTE, hash: 'palette' }, palette('app-search', 'co'))
await frame('palette-window-switcher', { size: PALETTE, hash: 'palette' }, palette('window-switcher'))
await frame('palette-command-palette', { size: PALETTE, hash: 'palette' }, palette('command-palette'))
await frame(
  'palette-app-search-light',
  { size: PALETTE, hash: 'palette', theme: 'light' },
  palette('app-search', 'co')
)

// Settings
const off = { disabled: ['groq-stt'] }
await frame('settings-general', { size: SETTINGS, hash: 'settings', settings: off }, settingsPage())
await frame(
  'settings-general-light',
  { size: SETTINGS, hash: 'settings', theme: 'light', settings: off },
  settingsPage()
)
// One frame per page, in sidebar order (Groq Transcription is the switched-off one below).
for (const id of [
  'app-search', 'window-switcher', 'command-palette', 'keyboard-remap', 'hotstrings',
  'user-commands', 'flashcards', 'auto-dark-mode', 'ulanzi', 'notifications'
]) {
  await frame(
    `settings-${id}`,
    { size: SETTINGS, hash: `settings?tab=module:${id}`, settings: off },
    settingsPage()
  )
}
await frame(
  'settings-module-off',
  { size: SETTINGS, hash: 'settings?tab=module:groq-stt', settings: off },
  settingsPage()
)
// The light theme: white as it comes, and its other backgrounds.
const light = { size: SETTINGS, theme: 'light' }
await frame(
  'settings-notifications-light',
  { ...light, hash: 'settings?tab=module:notifications', settings: off },
  settingsPage()
)
await frame(
  'settings-window-switcher-light',
  { ...light, hash: 'settings?tab=module:window-switcher', settings: off },
  settingsPage()
)
await frame(
  'settings-module-off-light',
  { ...light, hash: 'settings?tab=module:groq-stt', settings: off },
  settingsPage()
)
for (const lightBackground of ['paper', 'soft', 'steel', 'stone']) {
  await frame(
    `settings-general-light-${lightBackground}`,
    { ...light, hash: 'settings', settings: { ...off, lightBackground } },
    settingsPage()
  )
}
await frame(
  'palette-command-palette-light',
  { size: PALETTE, hash: 'palette', theme: 'light' },
  palette('command-palette')
)
await frame(
  'palette-window-switcher-light',
  { size: PALETTE, hash: 'palette', theme: 'light' },
  palette('window-switcher')
)
await frame('settings-about', { size: SETTINGS, hash: 'settings?tab=about', settings: off }, settingsPage())
await frame(
  'settings-vim-keys',
  { size: SETTINGS, hash: 'settings?tab=module:notifications', settings: off },
  settingsPage(['?'])
)

// Notifications: the four looks, then tones and states in the default look.
const hint = { size: HINT, hash: 'desktop-hint', transparent: true }
const sample = { source: 'cli:build', title: 'Build', message: 'Finished in 74 s' }
for (const look of ['plate', 'bar', 'tag', 'line']) {
  await frame(`toast-${look}`, hint, toast({ ...sample, look }))
}
await frame(
  'toast-plate-error',
  hint,
  toast({ source: 'cli:build', title: 'Build', message: 'Failed: 3 tests did not pass', tone: 'error', look: 'plate' })
)
await frame('toast-plate-success', hint, toast({ ...sample, tone: 'success', look: 'plate' }))
await frame(
  'toast-plate-recording',
  hint,
  toast({ source: 'groq-stt', message: 'Listening…', icon: 'microphone', look: 'plate' })
)
for (const look of ['plate', 'bar', 'tag', 'line']) {
  await frame(`toast-${look}-light`, { ...hint, theme: 'light' }, toast({ ...sample, look }))
}
await frame(
  'toast-plate-error-light',
  { ...hint, theme: 'light' },
  toast({ source: 'cli:build', title: 'Build', message: 'Failed: 3 tests did not pass', tone: 'error', look: 'plate' })
)

await browser.close()
rmSync(workDir, { recursive: true, force: true })

const failed = taken.filter((t) => t.problems.length)
console.log(`${taken.length} frames, ${failed.length} with page errors`)
process.exit(failed.length ? 1 : 0)
