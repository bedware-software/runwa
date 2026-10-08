// Print the git commit a packaged Runwa was built from, or nothing when the build carries
// no stamp (built before prod-iter stamped commits, or by something other than prod-iter).
//
//   node scripts/build-commit.mjs <path to app.asar>
//
// prod-iter stamps the commit into the packaged package.json through electron-builder's
// extraMetadata. The version alone can't tell two builds apart when they share it, e.g. a
// build made before a rebase that pulled in another machine's commit with the same bump.

import fs from 'node:fs'
import asar from '@electron/asar'

const archive = process.argv[2]
if (!archive) {
  console.error('usage: node scripts/build-commit.mjs <path to app.asar>')
  process.exit(2)
}
if (!fs.existsSync(archive)) process.exit(0)

const pkg = JSON.parse(asar.extractFile(archive, 'package.json').toString('utf8'))
if (typeof pkg.gitCommit === 'string') process.stdout.write(pkg.gitCommit)
