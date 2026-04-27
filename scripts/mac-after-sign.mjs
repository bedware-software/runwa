#!/usr/bin/env node

// electron-builder `afterSign` hook (configured in electron-builder.yml).
//
// Runs AFTER electron-builder finishes its own ad-hoc sign of the .app
// bundle but BEFORE it packages the bundle into .dmg / .zip artifacts.
// That ordering matters: re-signing on disk after .dmg/.zip have been
// built doesn't help — the artifacts uploaded to GitHub freeze the
// pre-restamp signature, so users downloading the release still get
// the broken cdhash-bound DR.
//
// What we do here is the same thing the standalone
// `mac-restamp-signature.mjs` does (and for the same reasons — see
// that script for the full context):
//
//   1. Stamp a stable identifier on the binary (`dev.dmitr.runwa`) so
//      TCC permission grants survive subsequent rebuilds and don't
//      collide with other ad-hoc Electron apps.
//   2. Embed an identifier-based designated requirement so Squirrel.Mac
//      auto-update can validate cross-version updates without a
//      Developer ID. Without this, codesign defaults the DR to a
//      cdhash binding which changes every build, and the auto-update
//      rejects every release with "code failed to satisfy specified
//      code requirement(s)".

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const BUNDLE_ID = 'dev.dmitr.runwa'
const DESIGNATED_REQUIREMENT = `=designated => identifier "${BUNDLE_ID}"`

/**
 * @param {import('app-builder-lib').AfterPackContext} context
 */
export default async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const productFilename = context.packager.appInfo.productFilename
  const appPath = join(context.appOutDir, `${productFilename}.app`)

  try {
    execFileSync(
      'codesign',
      [
        '--deep',
        '--force',
        '--sign', '-',
        '--identifier', BUNDLE_ID,
        '--requirements', DESIGNATED_REQUIREMENT,
        appPath
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    )
    console.log(
      `[mac-after-sign] re-signed ${appPath} with identifier=${BUNDLE_ID}, DR=identifier-based`
    )
  } catch (err) {
    console.error(`[mac-after-sign] failed to re-sign ${appPath}:`, err.message)
    throw err
  }
}
