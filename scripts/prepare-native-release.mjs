#!/usr/bin/env node

/**
 * Build and validate the native addon immediately before electron-builder
 * packages it. Generated bindings are gitignored, so release scripts must not
 * assume that a checkout already contains a usable or current binary.
 *
 * macOS packages both x64 and arm64 applications. Build both Rust targets and
 * merge them into one universal N-API binary so either package can load the
 * exact same resource.
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { removeGeneratedBindings } from './clean-native-bindings.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const projectDir = join(scriptDir, '..')
const nativeDir = join(projectDir, 'native')
const napiCli = join(
  projectDir,
  'node_modules',
  '@napi-rs',
  'cli',
  'scripts',
  'index.js'
)

const platformAliases = new Map([
  ['windows', 'win32'],
  ['win', 'win32'],
  ['win32', 'win32'],
  ['mac', 'darwin'],
  ['macos', 'darwin'],
  ['darwin', 'darwin'],
  ['linux', 'linux']
])

const requestedPlatform = platformAliases.get(
  (process.argv[2] ?? process.platform).toLowerCase()
)

if (!requestedPlatform) {
  throw new Error(
    `Unknown release platform ${JSON.stringify(process.argv[2])}; expected win32, darwin, or linux.`
  )
}
if (requestedPlatform !== process.platform) {
  throw new Error(
    `Cannot build ${requestedPlatform} native code on ${process.platform}. ` +
      'Run the matching dist script on that operating system.'
  )
}
if (!existsSync(napiCli)) {
  throw new Error(
    `Missing ${napiCli}. Run \`npm ci\` or \`npm install\` before packaging.`
  )
}

function run(command, args, cwd = projectDir, env = process.env) {
  console.log(`[native-release] ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with status ${result.status ?? 'unknown'}`
    )
  }
}

function runNapi(args, env = process.env) {
  run(process.execPath, [napiCli, ...args], nativeDir, env)
}

function rustupWhich(tool) {
  console.log(`[native-release] rustup which ${tool}`)
  const result = spawnSync('rustup', ['which', tool], {
    cwd: projectDir,
    env: process.env,
    encoding: 'utf8'
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    throw new Error(
      `rustup which ${tool} exited with status ${result.status ?? 'unknown'}`
    )
  }

  const toolPath = result.stdout.trim()
  assertFile(toolPath)
  return toolPath
}

function assertFile(filePath) {
  if (!existsSync(filePath) || statSync(filePath).size === 0) {
    throw new Error(
      `Expected native build output is missing or empty: ${filePath}`
    )
  }
}

function buildCurrentPlatform() {
  if (process.platform === 'win32' && process.arch !== 'x64') {
    throw new Error(
      `electron-builder.yml currently ships Windows x64 only; this host is ${process.arch}.`
    )
  }
  runNapi(['build', '--platform', '--release'])
}

function buildUniversalMacAddon() {
  const x64Target = 'x86_64-apple-darwin'
  const arm64Target = 'aarch64-apple-darwin'
  const x64Binary = join(nativeDir, 'runwa-native.darwin-x64.node')
  const arm64Binary = join(nativeDir, 'runwa-native.darwin-arm64.node')
  const universalBinary = join(
    nativeDir,
    'runwa-native.darwin-universal.node'
  )

  run('rustup', ['target', 'add', x64Target, arm64Target])
  const cargoPath = rustupWhich('cargo')
  const rustcPath = rustupWhich('rustc')
  const rustupToolchainEnv = {
    ...process.env,
    PATH: [dirname(cargoPath), process.env.PATH].filter(Boolean).join(delimiter),
    CARGO: cargoPath,
    RUSTC: rustcPath
  }

  runNapi(
    ['build', '--platform', '--release', '--target', x64Target],
    rustupToolchainEnv
  )
  runNapi(
    ['build', '--platform', '--release', '--target', arm64Target],
    rustupToolchainEnv
  )
  assertFile(x64Binary)
  assertFile(arm64Binary)

  runNapi(['universal', '--dir', '.', '--dist', '.'])
  assertFile(universalBinary)
  // napi 2.x does not propagate lipo's exit status from `napi universal`.
  // Verify both slices explicitly before allowing electron-builder to run.
  run('lipo', [universalBinary, '-verify_arch', 'x86_64', 'arm64'], nativeDir)

  // The universal binary is the release artifact. Removing thin binaries
  // makes it impossible for a package to accidentally select a host-only
  // fallback if the generated loader changes ordering later.
  rmSync(x64Binary)
  rmSync(arm64Binary)
}

function validateGeneratedPackage() {
  const wrapperPath = join(nativeDir, 'index.js')
  const typesPath = join(nativeDir, 'index.d.ts')
  assertFile(wrapperPath)
  assertFile(typesPath)

  const binaries = readdirSync(nativeDir).filter((name) =>
    /^runwa-native\..+\.node$/.test(name)
  )
  if (binaries.length !== 1) {
    throw new Error(
      `Expected exactly one packaged native binary, found: ${JSON.stringify(binaries)}`
    )
  }

  if (
    process.platform === 'darwin' &&
    binaries[0] !== 'runwa-native.darwin-universal.node'
  ) {
    throw new Error(
      `macOS release is not using a universal addon: ${binaries[0]}`
    )
  }

  // Loading the generated package catches stale loader code, an incompatible
  // host slice, and missing exports before electron-builder creates artifacts.
  const require = createRequire(import.meta.url)
  const binding = require(nativeDir)
  const requiredExports = [
    'listWindows',
    'focusWindow',
    'startKeyboardRemap',
    'getSystemTheme',
    'setSystemTheme',
    'setDesktopBackgroundColor'
  ]
  const missingExports = requiredExports.filter(
    (name) => typeof binding[name] !== 'function'
  )
  if (missingExports.length > 0) {
    throw new Error(
      `Native addon is missing release exports: ${missingExports.join(', ')}`
    )
  }

  // Guard against a generated wrapper that happened to resolve a separately
  // installed optional package instead of the binary being packaged.
  const wrapper = readFileSync(wrapperPath, 'utf8')
  if (!wrapper.includes(`require('./${binaries[0]}')`)) {
    throw new Error(
      `Generated native loader does not reference packaged binary ${binaries[0]}.`
    )
  }

  console.log(
    `[native-release] validated ${binaries[0]} and ${requiredExports.length} required exports`
  )
}

removeGeneratedBindings(nativeDir, 'native-release', { includeLoader: true })
if (process.platform === 'darwin') {
  buildUniversalMacAddon()
} else {
  buildCurrentPlatform()
}
validateGeneratedPackage()
