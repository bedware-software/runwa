#!/usr/bin/env node

/**
 * Delete every generated artifact in `native/`: the per-platform
 * `runwa-native.*.node` binaries plus the napi-generated `index.js` /
 * `index.d.ts` loader pair.
 *
 * This has to run before *every* addon build, not just release builds.
 * `napi build --platform` writes a binary named after the host triple
 * (`runwa-native.darwin-arm64.node`) and leaves every other binary in place,
 * while the loader it generates probes `runwa-native.darwin-universal.node`
 * FIRST and only falls back to the thin host binary. So on any machine that
 * has ever produced a universal binary — anyone who has run
 * `npm run dist:mac` — a later `npm run build:native` compiles happily,
 * writes a fresh arm64 binary, and then `require('./native')` goes right on
 * loading the stale universal one. electron-builder's `extraResources`
 * filter is `*.node`, so the stale file is packaged too: Rust changes appear
 * to build and simply don't exist at runtime, with nothing in any log to say
 * so. Removing the old artifacts first makes that failure impossible.
 *
 * Both an importable function and a CLI entry point, so the release pipeline
 * (`prepare-native-release.mjs`) and the fast host-arch loop
 * (`npm run build:native`) share one implementation.
 *
 * Note the deliberate trade: if the build that follows fails, the checkout is
 * left with no addon at all rather than a working-but-stale one. Loud is the
 * point — a silently outdated binary is the bug this exists to prevent.
 */

import { readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const defaultNativeDir = join(scriptDir, '..', 'native')

/** Binaries napi emits, one per platform/arch triple plus the merged
 * `darwin-universal`. Hand-written sources in `native/` never match. */
const GENERATED_BINARY = /^runwa-native\..+\.node$/

/**
 * Remove generated bindings from `nativeDir`. Returns the file names that
 * were deleted. `label` prefixes the log lines so callers can keep their own
 * output convention.
 *
 * `includeLoader` also deletes the generated `index.js` / `index.d.ts` pair.
 * It defaults to OFF, and that default is load-bearing: `napi build` only
 * emits the JS loader when it actually compiles something, so on a cargo
 * cache hit (`Finished in 0.05s`) a deleted loader is never regenerated. The
 * addon then builds "successfully" with no `index.js`, electron-builder
 * packages the `.node` without it, and the installed app dies on launch with
 * `Cannot find module .../native/index.js`. The stale-binary hazard this
 * whole script exists for is about the compiled binaries only, so the fast
 * path leaves the loader alone — it is platform-generic and probes for
 * whichever binary is present.
 *
 * Release builds pass `true`, which is only safe because they compile the
 * crate unconditionally: `prepare-native-release.mjs` runs
 * `cargo clean --package` first, so the proc-macro always re-emits the type
 * defs the loader is generated from. That used to be an assumption rather
 * than a guarantee, and a purged temp directory was enough to break it —
 * see `forceCrateRecompile` there for the full mechanism.
 */
export function removeGeneratedBindings(
  nativeDir = defaultNativeDir,
  label = 'native-clean',
  { includeLoader = false } = {}
) {
  const isLoader = (name) => name === 'index.js' || name === 'index.d.ts'
  const removed = []
  for (const name of readdirSync(nativeDir)) {
    if (!GENERATED_BINARY.test(name) && !(includeLoader && isLoader(name))) {
      continue
    }
    const generatedPath = join(nativeDir, name)
    rmSync(generatedPath)
    removed.push(name)
    console.log(`[${label}] removed stale ${generatedPath}`)
  }
  return removed
}

// Run the cleanup when invoked directly (`node scripts/clean-native-bindings.mjs`),
// stay silent when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  removeGeneratedBindings()
}
