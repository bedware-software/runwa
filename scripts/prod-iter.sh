#!/bin/zsh
# Build Runwa, reinstall it over the local prod install and relaunch it (macOS).
# Windows counterpart: scripts/prod-iter.ps1.
#
#   scripts/prod-iter.sh [commit message]
#
# The order is deliberate. Commit first: the husky pre-commit hook bumps the patch version,
# and that number is the only way to tell the new build from the old one. Build while Runwa
# keeps running (the build only writes to out/ and release/). Stop it only for the few
# seconds the install takes. Push last, once the new build is running.
#
# No tests and no typecheck: this is the fast dogfooding loop, verification is its own pass.

set -euo pipefail

cd "${0:A:h:h}"

step() { print "\n\e[1m==> $*\e[0m" }
die()  { print -u2 "\e[31mprod-iter: $*\e[0m"; exit 1 }
pkg_version() { node -p "require('./package.json').version" }
bundle_version() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$1/Contents/Info.plist" }
runwa_running() { pgrep -x Runwa >/dev/null }

# pgrep -x Runwa matches only the app's main process: helpers are "Runwa Helper ...",
# and an `npm run dev` instance runs as "Electron".

app=/Applications/Runwa.app
log=~/Library/Logs/Runwa/main.log

case $(uname -m) in
  arm64)  arch=arm64; built=release/mac-arm64/Runwa.app ;;
  x86_64) arch=x64;   built=release/mac/Runwa.app ;;
  *)      die "unsupported architecture $(uname -m)" ;;
esac

step "1/7 Commit"
old_version=$(pkg_version)
if [[ -z $(git status --porcelain) ]]; then
  installed=$([[ -d $app ]] && bundle_version $app || print none)
  # A clean tree still has something to ship when the last commit (and its version bump)
  # never made it into /Applications.
  if [[ $installed == $old_version ]]; then
    print "Working tree is clean and $app is already $old_version."
    [[ -t 0 ]] && read -q "?Rebuild and reinstall $old_version anyway? [y/N] " || { print; exit 0 }
    print
  else
    print "Working tree is clean, shipping $old_version over the installed $installed."
  fi
  version=$old_version
else
  git add -A
  if (( $# )); then
    git commit -m "$*"
  else
    git commit -m "Prod iter checkpoint" -m "$(git diff --cached --name-status)"
  fi
  version=$(pkg_version)
  [[ $version != $old_version ]] ||
    die "the pre-commit hook did not bump the version (still $version). Is husky installed? Run npm install."
  print "$old_version -> $version"
fi

step "2/7 Build $version for $arch (Runwa keeps running)"
# Only this Mac's .app: without --<arch> --dir electron-builder also packs a dmg and a zip for
# both architectures. The Rust addon is built universal either way, and dist:mac rebuilds it
# from scratch, so there is no separate build:native step.
npm run dist:mac -- --$arch --dir

step "3/7 Check build output"
[[ -d $built ]] || die "$built not found, did the build fail?"
built_version=$(bundle_version $built)
[[ $built_version == $version ]] || die "$built is $built_version, expected $version"
# The Accessibility / Input Monitoring grants survive the swap only because
# scripts/mac-after-sign.mjs pins the designated requirement to the bundle id. A
# cdhash-bound one would quietly cost every grant, so refuse it while the old app still runs.
codesign -d -r- $built 2>/dev/null | grep -q '^designated => identifier "dev.dmitr.runwa"' ||
  die "$built lacks the identifier-based designated requirement, did scripts/mac-after-sign.mjs run?"
print "$built is $built_version"

step "4/7 Stop Runwa"
if runwa_running; then
  # SIGTERM is a graceful app.quit() (see the signal handlers in src/main/index.ts), and
  # Runwa force-kills itself if that takes over 2s. The -9 is for a truly wedged process.
  pkill -x Runwa
  for i in {1..50}; do runwa_running || break; sleep 0.1; done
  if runwa_running; then
    print "Still running after 5s, force-killing"
    pkill -9 -x Runwa
    sleep 0.5
    ! runwa_running || die "Runwa survived pkill -9"
  fi
else
  print "Runwa is not running"
fi

step "5/7 Install to $app"
# Replace the whole bundle: files the new version dropped would otherwise linger inside it and
# break the code-signature seal. ditto keeps the framework symlinks and xattrs intact. The old
# bundle is parked, not deleted, until the copy lands, so a failed copy can't leave the
# machine without a Runwa.
parked=$(mktemp -d)/Runwa.app
[[ -d $app ]] && mv $app $parked
if ! ditto $built $app; then
  rm -rf $app
  [[ -d $parked ]] && mv $parked $app && open $app
  die "ditto failed, the previous Runwa is back in place"
fi
rm -rf ${parked:h}

step "6/7 Relaunch"
installed=$(bundle_version $app)
[[ $installed == $version ]] || die "the installed app reports $installed, expected $version"
open $app
for i in {1..50}; do runwa_running && break; sleep 0.1; done
runwa_running || die "Runwa did not start, check $log"

step "7/7 Push"
# Last on purpose: the new build is already running, so a failed push (offline, remote moved
# on) costs nothing but a retry. -u origin HEAD also covers a branch with no upstream yet.
git push -u origin HEAD || die "$version is installed, but the push failed"

print "\n\e[32mShipped $version to $app\e[0m (log: $log)"
