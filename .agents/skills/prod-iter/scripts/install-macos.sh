#!/bin/zsh

set -euo pipefail

if [[ $# -ne 2 ]]; then
  print -u2 "usage: $0 <built-app> <expected-version>"
  exit 2
fi

built_app="$1"
expected_version="$2"
installed_app="/Applications/Runwa.app"

if [[ ! -d "$built_app" ]]; then
  print -u2 "built app not found: $built_app"
  exit 1
fi

built_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$built_app/Contents/Info.plist")
if [[ "$built_version" != "$expected_version" ]]; then
  print -u2 "artifact version mismatch: expected=$expected_version built=$built_version"
  exit 1
fi

backup_root=$(mktemp -d /tmp/runwa-prod-iter.XXXXXX)
backup_app="$backup_root/Runwa.app"
failed_app="$backup_root/Runwa.failed.app"

restore_previous() {
  local status=$?
  trap - ERR

  print -u2 "installation failed; restoring the previous Runwa bundle"
  if [[ -d "$backup_app" ]]; then
    if [[ -d "$installed_app" ]]; then
      mv "$installed_app" "$failed_app"
    fi
    mv "$backup_app" "$installed_app"
    open -a "$installed_app" || true
  fi
  print -u2 "failed installation retained at: $failed_app"
  exit "$status"
}

trap restore_previous ERR

pkill -f '/Applications/Runwa.app' || true
for _ in {1..50}; do
  if ! pgrep -f '/Applications/Runwa.app/Contents/MacOS/Runwa' >/dev/null; then
    break
  fi
  sleep 0.1
done
if pgrep -f '/Applications/Runwa.app/Contents/MacOS/Runwa' >/dev/null; then
  print -u2 "Runwa did not stop"
  false
fi

if [[ -d "$installed_app" ]]; then
  mv "$installed_app" "$backup_app"
fi

ditto "$built_app" "$installed_app"

installed_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "$installed_app/Contents/Info.plist")
if [[ "$installed_version" != "$expected_version" ]]; then
  print -u2 "installed version mismatch: expected=$expected_version installed=$installed_version"
  false
fi

open -a "$installed_app"
for _ in {1..50}; do
  if pgrep -f '/Applications/Runwa.app/Contents/MacOS/Runwa' >/dev/null; then
    break
  fi
  sleep 0.1
done
if ! pgrep -f '/Applications/Runwa.app/Contents/MacOS/Runwa' >/dev/null; then
  print -u2 "installed Runwa did not start"
  false
fi

trap - ERR

if [[ -d "$backup_app" ]]; then
  previous_version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$backup_app/Contents/Info.plist" 2>/dev/null || print unknown)
  if trash_dir=$(/usr/bin/osascript -e 'POSIX path of (path to trash folder)'); then
    archived_app="${trash_dir}Runwa-${previous_version}-before-${expected_version}-$(date +%Y%m%d-%H%M%S)-$$.app"
    if mv "$backup_app" "$archived_app"; then
      print "previous=$archived_app"
    else
      print "previous=$backup_app"
    fi
  else
    print "previous=$backup_app"
  fi
fi

rmdir "$backup_root" 2>/dev/null || true
print "installed=$installed_version"
pgrep -fl '/Applications/Runwa.app/Contents/MacOS/Runwa'
