#!/usr/bin/env node
/**
 * Run the Tauri CLI (`npm run tauri:dev`, `npm run tauri:build`, …) with
 * rustup's toolchain first on PATH.
 *
 * The CLI shells out to whatever `cargo` PATH resolves. On a Mac that can be
 * Homebrew's `rust` formula rather than rustup's, and that cargo breaks
 * every time Homebrew upgrades a library it links against without
 * relinking it:
 *
 *   failed to run 'cargo metadata' … dyld: Library not loaded:
 *   /opt/homebrew/opt/llhttp/lib/libllhttp.9.3.dylib
 *
 * The macOS release build of the Electron addon already resolves its
 * toolchain through `rustup which` for the same reason
 * (prepare-native-release.mjs); this does the same for the Tauri shell.
 * Without rustup, PATH is used as it is.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const tauriCli = join(projectDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')

if (!existsSync(tauriCli)) {
  console.error(`Missing ${tauriCli}. Run \`npm install\` first.`)
  process.exit(1)
}

/** Absolute path of `tool` in the active rustup toolchain, or null. */
function rustupWhich(tool) {
  const result = spawnSync('rustup', ['which', tool], {
    cwd: projectDir,
    encoding: 'utf8'
  })
  if (result.error || result.status !== 0) return null
  const toolPath = result.stdout.trim()
  return toolPath && existsSync(toolPath) ? toolPath : null
}

const env = { ...process.env }
const cargo = rustupWhich('cargo')
if (cargo) {
  // Windows spells it `Path`; adding a second `PATH` key would leave the
  // child with two conflicting entries.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  env[pathKey] = [dirname(cargo), env[pathKey]].filter(Boolean).join(delimiter)
  env.CARGO = cargo
  const rustc = rustupWhich('rustc')
  if (rustc) env.RUSTC = rustc
}

const child = spawn(process.execPath, [tauriCli, ...process.argv.slice(2)], {
  cwd: projectDir,
  env,
  stdio: 'inherit'
})
// Ctrl+C reaches the Tauri CLI directly (same process group). Stay alive
// until it has stopped the dev server and the app, then exit with it.
process.on('SIGINT', () => {})
for (const signal of ['SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', (err) => {
  console.error(err)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
