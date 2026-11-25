#!/usr/bin/env node

// electron-builder `afterPack` hook (configured in electron-builder.yml).
//
// Gives a `--dir` mac build (scripts/prod-iter.sh) its app-update.yml.
// electron-builder writes that file on mac only when a dmg or zip target is
// built; without it every electron-updater check dies with ENOENT before it
// reaches GitHub, so a locally installed build never sees a public release.
//
// Must stay an afterPack hook: a file added after signing breaks the
// bundle's seal.

import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * @param {import('app-builder-lib').AfterPackContext} context
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const file = join(context.packager.getResourcesDir(context.appOutDir), 'app-update.yml')
  if (existsSync(file)) return
  const publish = [context.packager.config.publish].flat()[0]
  if (publish?.provider !== 'github') {
    throw new Error('mac-after-pack: expected a github publish config')
  }
  writeFileSync(
    file,
    `owner: ${publish.owner}\nrepo: ${publish.repo}\nprovider: github\n` +
      `updaterCacheDirName: ${context.packager.appInfo.updaterCacheDirName}\n`
  )
}
