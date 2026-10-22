import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { UlanziProfileSummary, UlanziProfilesView } from '@shared/types'

/**
 * Ulanzi Studio is a Qt app, so its data lives in Qt's AppDataLocation for
 * organisation "Ulanzi" / application "UlanziDeck". Verified on macOS; the
 * Windows path is Qt's equivalent and unverified.
 */
export function ulanziDataDir(): string | null {
  if (process.platform !== 'darwin' && process.platform !== 'win32') return null
  return path.join(app.getPath('appData'), 'Ulanzi', 'UlanziDeck')
}

export function ulanziConfigDir(): string | null {
  const dir = ulanziDataDir()
  return dir ? path.join(dir, 'config') : null
}

/**
 * Read every profile from Ulanzi Studio's `ProfilesV2/<uuid>.ulanziProfile/
 * manifest.json`. Only `Name` and `App` matter here: a manifest without an
 * `App` follows no application, which is what marks a mode profile.
 * Unreadable manifests are skipped — Ulanzi rewrites them while it saves.
 */
export async function listUlanziProfiles(): Promise<UlanziProfilesView> {
  const dataDir = ulanziDataDir()
  if (!dataDir) return { installed: false, profiles: [] }

  const profilesDir = path.join(dataDir, 'ProfilesV2')
  let entries: string[]
  try {
    entries = await fs.readdir(profilesDir)
  } catch {
    const installed = await fs
      .stat(dataDir)
      .then((s) => s.isDirectory())
      .catch(() => false)
    return { installed, profiles: [] }
  }

  const profiles = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.ulanziProfile'))
      .map((entry) => readManifest(path.join(profilesDir, entry, 'manifest.json')))
  )
  const byName = new Map<string, UlanziProfileSummary>()
  for (const profile of profiles) {
    if (profile && !byName.has(profile.name)) byName.set(profile.name, profile)
  }
  return {
    installed: true,
    profiles: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }
}

async function readManifest(file: string): Promise<UlanziProfileSummary | null> {
  try {
    const manifest = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
    if (typeof manifest.Name !== 'string' || !manifest.Name) return null
    const app = typeof manifest.App === 'string' && manifest.App ? manifest.App : null
    return { name: manifest.Name, app }
  } catch {
    return null
  }
}
