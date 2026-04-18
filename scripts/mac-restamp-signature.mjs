#!/usr/bin/env node

// macOS post-build re-sign step. electron-builder ad-hoc signs the output
// with codesigning identifier "Electron" — literally the string "Electron",
// not our bundle ID — because that's Electron's default linker-embedded
// identifier and electron-builder doesn't override it in unsigned/ad-hoc
// mode. TCC keys permission grants (Screen Recording, Accessibility, etc.)
// by that identifier, so:
//
//   1. Grants we ask the user to apply to "runwa" silently collide with
//      every other ad-hoc Electron app on the same machine, which is why
//      Screen Recording never seems to actually apply (titles stay blank
//      in CGWindowList output).
//   2. Each rebuild produces a subtly-different signature, invalidating
//      any grant the user already made.
//
// Re-signing with `--identifier <bundle-id>` stamps a stable identifier on
// the binary. TCC now keys grants to `dev.dmitr.runwa`, and as long as
// that identifier doesn't change, prior grants survive subsequent rebuilds.
// Signature is still ad-hoc (no Developer ID), but the identifier is the
// part TCC cares about.
//
// Runs against every `.app` bundle under `release/`, because
// electron-builder outputs separate per-arch bundles (`mac/`, `mac-arm64/`)
// and we need both signed consistently.

import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const BUNDLE_ID = 'dev.dmitr.runwa'
const __dirname = dirname(fileURLToPath(import.meta.url))
const releaseDir = join(__dirname, '..', 'release')

function findAppBundles(dir) {
  const hits = []
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return hits
  }
  for (const name of entries) {
    const full = join(dir, name)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    if (name.endsWith('.app')) {
      hits.push(full)
    } else {
      hits.push(...findAppBundles(full))
    }
  }
  return hits
}

const bundles = findAppBundles(releaseDir)
if (bundles.length === 0) {
  console.log('[mac-restamp-signature] no .app bundles under release/, skipping')
  process.exit(0)
}

for (const app of bundles) {
  try {
    execFileSync(
      'codesign',
      ['--deep', '--force', '--sign', '-', '--identifier', BUNDLE_ID, app],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    )
    console.log(`[mac-restamp-signature] re-signed ${app} with identifier=${BUNDLE_ID}`)
  } catch (err) {
    console.error(`[mac-restamp-signature] failed to re-sign ${app}:`, err.message)
    process.exitCode = 1
  }
}
