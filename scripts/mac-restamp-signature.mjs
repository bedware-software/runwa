#!/usr/bin/env node

// macOS post-build re-sign step. Two reasons we re-sign every build:
//
// 1) electron-builder ad-hoc signs the output with codesigning identifier
//    "Electron" — literally the string "Electron", not our bundle ID —
//    because that's Electron's default linker-embedded identifier and
//    electron-builder doesn't override it in unsigned/ad-hoc mode. TCC
//    keys permission grants (Screen Recording, Accessibility, etc.) by
//    that identifier, so without re-stamping, grants we ask the user to
//    apply to "runwa" silently collide with every other ad-hoc Electron
//    app on the same machine, AND each rebuild produces a subtly-
//    different signature, invalidating prior grants.
//
// 2) Without a Developer ID, codesign's default "designated requirement"
//    is `cdhash H"<sha256-of-the-binary>"`. The CDHash changes on every
//    rebuild. Squirrel.Mac (Electron's auto-update framework) rejects
//    updates whose code signature doesn't satisfy the running app's DR —
//    so every fresh release fails to install over the previous one with
//    "code failed to satisfy specified code requirement(s)". Embedding
//    a permissive identifier-based DR (`identifier "dev.dmitr.runwa"`)
//    makes any Runwa build satisfy any other Runwa build's DR, which is
//    fine for an ad-hoc-signed app where the developer's the trust
//    anchor anyway. Future builds → auto-update works.
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

// Designated requirement: any binary that signs as `dev.dmitr.runwa`
// satisfies it. Anchors trust to the bundle identifier rather than the
// per-build CDHash so cross-version updates pass Squirrel.Mac's
// signature check. The leading `=` tells codesign this is an inline
// requirement string, not a file path.
const DESIGNATED_REQUIREMENT = `=designated => identifier "${BUNDLE_ID}"`

for (const app of bundles) {
  try {
    execFileSync(
      'codesign',
      [
        '--deep',
        '--force',
        '--sign', '-',
        '--identifier', BUNDLE_ID,
        '--requirements', DESIGNATED_REQUIREMENT,
        app
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    )
    console.log(`[mac-restamp-signature] re-signed ${app} with identifier=${BUNDLE_ID}, DR=identifier-based`)
  } catch (err) {
    console.error(`[mac-restamp-signature] failed to re-sign ${app}:`, err.message)
    process.exitCode = 1
  }
}
