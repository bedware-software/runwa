import { spawn } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

/**
 * A launchable installed app. One of `filePath` or `uwpAppId` is set:
 *  - filePath: classic shortcut / exe / .app bundle — launch via shell.openPath
 *  - uwpAppId: AUMID for UWP/Store apps — launch via `explorer.exe shell:AppsFolder\<AUMID>`
 */
export interface AppEntry {
  id: string
  name: string
  filePath?: string
  uwpAppId?: string
  source: 'start-menu' | 'uwp' | 'desktop' | 'applications' | 'custom'
}

export interface EnumerateOptions {
  includeStartMenu: boolean
  includeUwp: boolean
  includeDesktop: boolean
  customPaths: string[]
}

// File extensions that count as a "launchable app" on Windows.
// Mirrors PowerToys' Apps extension (.appref-ms handled like .lnk: via shell.openPath).
const WIN_EXTS = new Set(['.lnk', '.url', '.exe', '.appref-ms'])

// macOS: .app bundles are directories; one level of nesting under /Applications
// is idiomatic (e.g. /Applications/Utilities/Terminal.app). Walk two levels
// deep — deeper than that is almost never used.
const MAC_MAX_DEPTH = 2

// Windows Start Menu / Desktop folders are typically shallow but can nest a
// folder or two (e.g. .../Start Menu/Programs/Accessories/Paint.lnk). Three
// levels covers all realistic layouts without blowing up on weird setups.
const WIN_MAX_DEPTH = 3

async function walkForApps(
  root: string,
  matches: (entry: string) => boolean,
  maxDepth: number,
  collect: (p: string) => void
): Promise<void> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (depth + 1 < maxDepth) stack.push({ dir: full, depth: depth + 1 })
        if (matches(e.name)) collect(full)
      } else if (e.isFile() && matches(e.name)) {
        collect(full)
      }
    }
  }
}

function displayNameFromFile(filePath: string, ext: string): string {
  const base = path.basename(filePath)
  return base.slice(0, base.length - ext.length)
}

// ─── Windows ───────────────────────────────────────────────────────────────

async function enumerateWindowsStartMenu(): Promise<AppEntry[]> {
  const roots: string[] = []
  if (process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  }
  if (process.env.PROGRAMDATA) {
    roots.push(path.join(process.env.PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  }
  return walkWindowsDirs(roots, 'start-menu')
}

async function enumerateWindowsDesktop(): Promise<AppEntry[]> {
  const roots: string[] = []
  if (process.env.USERPROFILE) {
    roots.push(path.join(process.env.USERPROFILE, 'Desktop'))
  }
  if (process.env.PUBLIC) {
    roots.push(path.join(process.env.PUBLIC, 'Desktop'))
  }
  return walkWindowsDirs(roots, 'desktop')
}

async function walkWindowsDirs(
  roots: string[],
  source: AppEntry['source']
): Promise<AppEntry[]> {
  const out: AppEntry[] = []
  for (const root of roots) {
    await walkForApps(
      root,
      (name) => WIN_EXTS.has(path.extname(name).toLowerCase()),
      WIN_MAX_DEPTH,
      (filePath) => {
        const ext = path.extname(filePath).toLowerCase()
        const name = displayNameFromFile(filePath, ext)
        if (name.length === 0) return
        out.push({
          id: `${source}:${filePath}`,
          name,
          filePath,
          source
        })
      }
    )
  }
  return out
}

/**
 * Enumerate Store/UWP apps via `Get-StartApps`. The cmdlet returns every app
 * that appears in the user's Start Menu, including Win32 shortcuts — we
 * filter to AUMIDs (contain `!`) so classic apps come from the Start Menu
 * walk (which gives us usable .lnk paths for icon extraction) and this path
 * contributes only the UWP/AppX entries that wouldn't otherwise be found.
 */
async function enumerateWindowsUwp(): Promise<AppEntry[]> {
  const json = await runPowerShell(
    'Get-StartApps | ConvertTo-Json -Compress'
  )
  if (!json) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const rows: Array<{ Name?: string; AppID?: string }> = Array.isArray(parsed)
    ? (parsed as Array<{ Name?: string; AppID?: string }>)
    : [parsed as { Name?: string; AppID?: string }]
  const out: AppEntry[] = []
  for (const row of rows) {
    if (!row?.Name || !row?.AppID) continue
    // UWP/AppX AUMIDs contain `!`, e.g.
    // `Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`. Win32 entries in
    // Get-StartApps are paths or class names — skip them here, they come
    // from the Start Menu walk with usable icon paths.
    if (!row.AppID.includes('!')) continue
    out.push({
      id: `uwp:${row.AppID}`,
      name: row.Name,
      uwpAppId: row.AppID,
      source: 'uwp'
    })
  }
  return out
}

function runPowerShell(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        command
      ],
      { windowsHide: true }
    )
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (c) => (stdout += c.toString()))
    proc.stderr.on('data', (c) => (stderr += c.toString()))
    proc.on('error', () => resolve(null))
    proc.on('close', (code) => {
      if (code !== 0) {
        console.warn(`[app-search] powershell exited ${code}: ${stderr.trim()}`)
        resolve(null)
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

// ─── macOS ─────────────────────────────────────────────────────────────────

async function enumerateMacApplications(): Promise<AppEntry[]> {
  const roots = ['/Applications', path.join(os.homedir(), 'Applications')]
  const out: AppEntry[] = []
  for (const root of roots) {
    await walkForApps(
      root,
      (name) => name.toLowerCase().endsWith('.app'),
      MAC_MAX_DEPTH,
      (bundlePath) => {
        const name = displayNameFromFile(bundlePath, '.app')
        if (name.length === 0) return
        out.push({
          id: `app:${bundlePath}`,
          name,
          filePath: bundlePath,
          source: 'applications'
        })
      }
    )
  }
  return out
}

// ─── Custom paths (both platforms) ─────────────────────────────────────────

async function enumerateCustomPaths(paths: string[]): Promise<AppEntry[]> {
  const out: AppEntry[] = []
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  for (const root of paths) {
    await walkForApps(
      root,
      (name) => {
        if (isWin) return WIN_EXTS.has(path.extname(name).toLowerCase())
        if (isMac) return name.toLowerCase().endsWith('.app')
        return false
      },
      WIN_MAX_DEPTH,
      (filePath) => {
        const ext = path.extname(filePath).toLowerCase()
        const name = isMac
          ? displayNameFromFile(filePath, '.app')
          : displayNameFromFile(filePath, ext)
        if (name.length === 0) return
        out.push({
          id: `custom:${filePath}`,
          name,
          filePath,
          source: 'custom'
        })
      }
    )
  }
  return out
}

// ─── Public entry point + cache ────────────────────────────────────────────

const CACHE_TTL_MS = 60_000

interface CacheEntry {
  t: number
  apps: AppEntry[]
}

let cache: { key: string; entry: CacheEntry } | null = null

function cacheKey(opts: EnumerateOptions): string {
  return [
    opts.includeStartMenu ? '1' : '0',
    opts.includeUwp ? '1' : '0',
    opts.includeDesktop ? '1' : '0',
    opts.customPaths.join('|')
  ].join('\x00')
}

export async function enumerateApps(opts: EnumerateOptions): Promise<AppEntry[]> {
  const key = cacheKey(opts)
  const now = Date.now()
  if (cache && cache.key === key && now - cache.entry.t < CACHE_TTL_MS) {
    return cache.entry.apps
  }

  const collected: AppEntry[] = []
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'

  if (isWin) {
    const parallel: Array<Promise<AppEntry[]>> = []
    if (opts.includeStartMenu) parallel.push(enumerateWindowsStartMenu())
    if (opts.includeUwp) parallel.push(enumerateWindowsUwp())
    if (opts.includeDesktop) parallel.push(enumerateWindowsDesktop())
    const results = await Promise.all(parallel)
    for (const r of results) collected.push(...r)
  } else if (isMac) {
    // On macOS there's no distinction between Start Menu / UWP / Desktop —
    // apps live in /Applications. The includeStartMenu toggle is treated as
    // "include system apps" so users can disable it via the same switch;
    // includeUwp / includeDesktop are no-ops on this platform.
    if (opts.includeStartMenu) {
      collected.push(...(await enumerateMacApplications()))
    }
  }

  if (opts.customPaths.length > 0) {
    collected.push(...(await enumerateCustomPaths(opts.customPaths)))
  }

  const deduped = dedupeByName(collected)
  deduped.sort((a, b) => a.name.localeCompare(b.name))

  cache = { key, entry: { t: now, apps: deduped } }
  return deduped
}

/**
 * Dedupe by case-insensitive name, preferring entries with a real filePath
 * (icon-resolvable) over UWP-only entries when names collide. E.g. if the
 * Start Menu walk finds "Paint.lnk" and Get-StartApps also returns a UWP
 * "Paint", keep the .lnk.
 */
function dedupeByName(apps: AppEntry[]): AppEntry[] {
  const seen = new Map<string, AppEntry>()
  for (const a of apps) {
    const key = a.name.toLowerCase()
    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, a)
    } else if (!existing.filePath && a.filePath) {
      seen.set(key, a)
    }
  }
  return [...seen.values()]
}

export function invalidateAppCache(): void {
  cache = null
}
