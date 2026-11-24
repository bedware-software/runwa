#!/usr/bin/env node
// Publish a release: tag the pushed tip of main as v<version> and push the tag.
//
//   npm run release              tag and push
//   npm run release -- --dry-run show what would be tagged, change nothing
//
// The tag is all it takes: .github/workflows/build.yml builds Windows, macOS and Linux
// from it and publishes the GitHub release, which is what the installed apps update from.
//
// The version is not chosen here. The pre-commit hook bumps the patch version on every
// commit, so the commit being released already has its own. To release again, commit first.
//
// The tag goes on the commit, not on the working tree: uncommitted changes are not part of
// the release and only get a warning. The commit must already be on origin/main, so what is
// released is exactly what is pushed.

import { execFileSync } from 'node:child_process'

const dryRun = process.argv.includes('--dry-run')

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function tryGit(...args) {
  try {
    return git(...args)
  } catch {
    return null
  }
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exit(1)
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
if (branch !== 'main') fail(`on branch "${branch}", releases are cut from main`)

console.log('Fetching origin...')
git('fetch', '--quiet', '--tags', 'origin', 'main')

const head = git('rev-parse', 'HEAD')
const remote = git('rev-parse', 'origin/main')
if (head !== remote) {
  const ahead = git('rev-list', '--count', 'origin/main..HEAD')
  const behind = git('rev-list', '--count', 'HEAD..origin/main')
  fail(
    `main and origin/main differ (${ahead} commit(s) not pushed, ${behind} not pulled). ` +
      'Push or pull first, then run this again.'
  )
}

// The version of the commit, not of the working tree.
const version = JSON.parse(git('show', 'HEAD:package.json')).version
const tag = `v${version}`

if (tryGit('rev-parse', '--quiet', '--verify', `refs/tags/${tag}`)) {
  fail(`${tag} already exists. Make a commit (it bumps the version), push it, then run this again.`)
}

const repo = git('remote', 'get-url', 'origin')
  .replace(/^git@github\.com:/, '')
  .replace(/^https:\/\/github\.com\//, '')
  .replace(/\.git$/, '')

const previous = tryGit('describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD')
const since = previous ? git('rev-list', '--count', `${previous}..HEAD`) : null

console.log('')
console.log(`  Release  ${tag}`)
console.log(`  Commit   ${head.slice(0, 7)} ${git('log', '-1', '--format=%s').slice(0, 90)}`)
if (previous) console.log(`  Previous ${previous} (${since} commit(s) ago)`)
if (git('status', '--porcelain')) {
  console.log('  Note     uncommitted changes in the working tree are NOT part of this release')
}
console.log('')

if (dryRun) {
  console.log('Dry run: nothing tagged, nothing pushed.')
  process.exit(0)
}

git('tag', '-a', tag, '-m', tag, head)
try {
  git('push', 'origin', `refs/tags/${tag}`)
} catch (error) {
  // Leave no local tag behind that the remote does not have.
  tryGit('tag', '-d', tag)
  fail(`could not push ${tag}: ${String(error.stderr || error.message).trim()}`)
}

console.log(`Pushed ${tag}. The build takes a while, then the release is public.`)
console.log(`  Build    https://github.com/${repo}/actions`)
console.log(`  Release  https://github.com/${repo}/releases/tag/${tag}`)
console.log('  Follow   gh run watch')
