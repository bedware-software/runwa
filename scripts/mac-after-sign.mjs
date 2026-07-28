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
//   3. Preserve electron-builder's entitlements and hardened-runtime flags.
//      Re-signing without --preserve-metadata silently drops both, including
//      the Apple Events entitlement used by Auto Dark Mode.

import { execFileSync, spawnSync } from 'node:child_process'
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
    // electron-builder has already signed every nested helper/framework.
    // Re-sign only the outer bundle so their identifiers and entitlements
    // remain intact; `codesign --deep` is deprecated for signing.
    execFileSync(
      'codesign',
      [
        '--force',
        '--sign', '-',
        '--identifier', BUNDLE_ID,
        '--requirements', DESIGNATED_REQUIREMENT,
        '--preserve-metadata=entitlements,flags,runtime',
        appPath
      ],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    )
    execFileSync(
      'codesign',
      ['--verify', '--deep', '--strict', '--verbose=2', appPath],
      { stdio: ['ignore', 'inherit', 'inherit'] }
    )

    const entitlements = execFileSync(
      'codesign',
      ['--display', '--entitlements', ':-', appPath],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    )
    for (const entitlement of [
      'com.apple.security.cs.allow-jit',
      'com.apple.security.device.audio-input',
      'com.apple.security.automation.apple-events'
    ]) {
      if (!entitlements.includes(`<key>${entitlement}</key>`)) {
        throw new Error(`re-signed app is missing entitlement ${entitlement}`)
      }
    }

    const signature = spawnSync(
      'codesign',
      ['--display', '--verbose=4', appPath],
      { encoding: 'utf8' }
    )
    if (signature.error) throw signature.error
    if (signature.status !== 0) {
      throw new Error(
        `codesign metadata check exited with status ${signature.status}`
      )
    }
    const signatureDetails = `${signature.stdout}\n${signature.stderr}`
    if (!/flags=.*\bruntime\b/i.test(signatureDetails)) {
      throw new Error('re-signed app is missing the hardened-runtime flag')
    }

    console.log(
      `[mac-after-sign] re-signed and verified ${appPath} with identifier=${BUNDLE_ID}, DR=identifier-based`
    )
  } catch (err) {
    console.error(`[mac-after-sign] failed to re-sign ${appPath}:`, err.message)
    throw err
  }
}
