import { spawn } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

/**
 * A launchable installed app. One of `filePath` or `uwpAppId` is set:
 *  - filePath: classic shortcut / exe / .app bundle — launch via shell.openPath
 *  - uwpAppId: AUMID for UWP/Store apps — launch via `explorer.exe shell:AppsFolder\<AUMID>`
 *
 * `iconPath`, when set, overrides the icon source. Used for UWP entries
 * where the launch handle (AUMID) isn't a filesystem path `app.getFileIcon`
 * can read — we resolve the package's `Square44x44Logo.*.png` at enumerate
 * time and feed that directly to the icon cache.
 */
export interface AppEntry {
  id: string
  name: string
  filePath?: string
  uwpAppId?: string
  iconPath?: string
  source: 'start-menu' | 'uwp' | 'desktop' | 'applications' | 'custom'
}

export interface EnumerateOptions {
  includeStartMenu: boolean
  includeUwp: boolean
  includeDesktop: boolean
  /**
   * macOS-only: include `.app` bundles whose name starts with a dot
   * (e.g. `.Karabiner-VirtualHIDDevice-Manager.app`). These are system
   * helpers that Finder and Spotlight hide by default; the same toggle
   * also applies to custom paths so the rule is consistent across
   * sources.
   */
  includeHidden: boolean
  customPaths: string[]
}

// File extensions that count as a "launchable app" on Windows.
// Mirrors PowerToys' Apps extension (.appref-ms handled like .lnk: via shell.openPath).
const WIN_EXTS = new Set(['.lnk', '.url', '.exe', '.appref-ms'])

// macOS: .app bundles are directories; users nest them arbitrarily deep in
// suite folders (Adobe CC, Microsoft Office, Setapp, /Applications/Utilities,
// /System/Applications/Utilities, etc.). Walk deep — the short-circuit on
// matched bundles below prevents us from descending into any .app's internals.
const MAC_MAX_DEPTH = 8

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
        if (matches(e.name)) {
          // Matched bundle (e.g. Foo.app) — collect but don't descend into
          // its internals; Contents/Frameworks/*.app are helpers, not apps.
          collect(full)
        } else if (depth + 1 < maxDepth) {
          stack.push({ dir: full, depth: depth + 1 })
        }
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
 * Enumerate Store/UWP apps via `Get-StartApps` + `Get-AppxPackage`, joined
 * on the Package Family Name portion of the AUMID. For each entry we also
 * resolve a logo file — Windows ships the real icon as per-scale PNGs
 * inside the package's `Assets` folder (e.g.
 * `Square44x44Logo.targetsize-32.png`); we pick the best match so
 * `nativeImage.createFromPath` has something to load on the TS side.
 *
 * One PowerShell round trip for everything — `Get-AppxPackage` alone takes
 * ~1s on a typical box, so we pay that once per enumeration cache window.
 */
async function enumerateWindowsUwp(): Promise<AppEntry[]> {
  const json = await runPowerShell(UWP_ENUMERATION_SCRIPT)
  if (!json) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return []
  }
  const rows: Array<{ Name?: string; AppID?: string; Logo?: string | null }> =
    Array.isArray(parsed)
      ? (parsed as Array<{ Name?: string; AppID?: string; Logo?: string | null }>)
      : [parsed as { Name?: string; AppID?: string; Logo?: string | null }]
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
      iconPath: row.Logo ?? undefined,
      source: 'uwp'
    })
  }
  return out
}

/**
 * Joins Start-Menu-visible AUMIDs with `Get-AppxPackage` install locations,
 * reads each package's `AppxManifest.xml` to find the per-Application
 * `Square44x44Logo` attribute (the base filename — something like
 * `Assets\CalculatorAppList.png`), then picks the best scale variant from
 * the Assets folder. Regex-on-XML is fine here: we only pull one well-known
 * attribute out of a doc with a stable shape, and the namespace-aware
 * XPath alternative is uglier than the worst-case regex noise.
 *
 * Scale preference: targetsize-32 (matches our 32 px tile exactly), then
 * targetsize-48, then scale-100 / scale-200 / targetsize-24, finally any
 * variant that isn't `contrast-*` or `altform-*` (high-contrast /
 * unplated icons skew weird in a normal palette row).
 */
const UWP_ENUMERATION_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$apps = Get-StartApps | Where-Object { $_.AppID -like '*!*' }

$installLocations = @{}
foreach ($p in Get-AppxPackage) {
    if ($p.InstallLocation) {
        $installLocations[[string]$p.PackageFamilyName] = [string]$p.InstallLocation
    }
}

function Get-LogoBase($installLocation, $appIdPart) {
    $manifestPath = Join-Path $installLocation 'AppxManifest.xml'
    if (-not (Test-Path -LiteralPath $manifestPath)) { return $null }
    $content = Get-Content -LiteralPath $manifestPath -Raw
    if (-not $content) { return $null }
    # Prefer the block for this specific Application; fall back to the first
    # one if we can't find a match (single-app packages, weird Id casing, …).
    # Single-quoted PS literals keep the regex readable — no backslash-soup.
    $escaped = [regex]::Escape($appIdPart)
    $appPattern = '<Application\\s[^>]*Id="' + $escaped + '"[^>]*>.*?</Application>'
    $appBlock = [regex]::Match($content, $appPattern, 'Singleline')
    if (-not $appBlock.Success) {
        $appBlock = [regex]::Match($content, '<Application\\s[^>]*>.*?</Application>', 'Singleline')
    }
    if (-not $appBlock.Success) { return $null }
    $logoMatch = [regex]::Match($appBlock.Value, 'Square44x44Logo="([^"]+)"')
    if ($logoMatch.Success) { return $logoMatch.Groups[1].Value }
    return $null
}

function Resolve-Logo($installLocation, $appIdPart) {
    if (-not $installLocation) { return $null }
    $logoBase = Get-LogoBase $installLocation $appIdPart
    if (-not $logoBase) { $logoBase = 'Assets\\Square44x44Logo.png' }
    $logoAbs = Join-Path $installLocation $logoBase
    $logoDir = Split-Path -Parent $logoAbs
    $logoStem = [System.IO.Path]::GetFileNameWithoutExtension($logoAbs)
    if (-not (Test-Path -LiteralPath $logoDir)) { return $null }
    $candidates = Get-ChildItem -LiteralPath $logoDir -Filter "$logoStem*" -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'contrast' -and $_.Name -notmatch 'altform' }
    if (-not $candidates) { return $null }
    # Match against "targetsize-32." etc. — the literal dot in filenames makes
    # '.' safe here; no Assets/-level collisions expected.
    foreach ($pattern in @('targetsize-32.', 'targetsize-48.', 'scale-100.', 'scale-200.', 'targetsize-24.', 'targetsize-96.')) {
        $m = $candidates | Where-Object { $_.Name -match $pattern } | Select-Object -First 1
        if ($m) { return $m.FullName }
    }
    return ($candidates | Select-Object -First 1).FullName
}

$results = foreach ($app in $apps) {
    $parts = $app.AppID.Split('!')
    $pfn = $parts[0]
    $appIdPart = $parts[1]
    $installLocation = $installLocations[$pfn]
    $logo = Resolve-Logo $installLocation $appIdPart
    [PSCustomObject]@{
        Name = $app.Name
        AppID = $app.AppID
        Logo = $logo
    }
}
$results | ConvertTo-Json -Compress -Depth 3
`.trim()

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

async function enumerateMacApplications(includeHidden: boolean): Promise<AppEntry[]> {
  // Finder's /Applications view is a synthetic union of /Applications and
  // /System/Applications. The latter is where modern macOS keeps system apps
  // — System Settings, Calculator, Music, TV — and /System/Applications/
  // Utilities holds Terminal, Disk Utility, Activity Monitor, and friends.
  // None of these live under the top-level /Applications anymore, so we have
  // to scan both roots to match what the user sees in Finder.
  const roots = [
    '/Applications',
    '/System/Applications',
    path.join(os.homedir(), 'Applications')
  ]
  const out: AppEntry[] = []
  for (const root of roots) {
    await walkForApps(
      root,
      (name) => isMacAppBundleName(name, includeHidden),
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

/**
 * Match `.app` bundles, optionally excluding dot-prefixed ones (system
 * helpers like `.Karabiner-VirtualHIDDevice-Manager.app`). Same predicate
 * is used for custom paths on macOS so the toggle applies uniformly.
 */
function isMacAppBundleName(name: string, includeHidden: boolean): boolean {
  if (!name.toLowerCase().endsWith('.app')) return false
  if (!includeHidden && name.startsWith('.')) return false
  return true
}

// ─── Custom paths (both platforms) ─────────────────────────────────────────

async function enumerateCustomPaths(
  paths: string[],
  includeHidden: boolean
): Promise<AppEntry[]> {
  const out: AppEntry[] = []
  const isWin = process.platform === 'win32'
  const isMac = process.platform === 'darwin'
  for (const root of paths) {
    await walkForApps(
      root,
      (name) => {
        if (isWin) return WIN_EXTS.has(path.extname(name).toLowerCase())
        if (isMac) return isMacAppBundleName(name, includeHidden)
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
//
// Single-shot cache: the first `enumerateApps` call pays the enumeration
// cost (Get-AppxPackage is the expensive bit, ~1s), every subsequent call
// returns the memoised result. The cache is invalidated in exactly two
// ways:
//   1. The toggle set changes (Start Menu / UWP / Desktop / custom paths)
//      — a different cache key forces a fresh walk automatically.
//   2. The user presses Ctrl+R inside the app-search scope — the module's
//      onAction handler calls `invalidateAppCache()` explicitly.
// No time-based TTL: installed apps don't change often, and silently
// re-enumerating every minute is both expensive and unhelpful.

interface CacheEntry {
  apps: AppEntry[]
}

let cache: { key: string; entry: CacheEntry } | null = null

function cacheKey(opts: EnumerateOptions): string {
  return [
    opts.includeStartMenu ? '1' : '0',
    opts.includeUwp ? '1' : '0',
    opts.includeDesktop ? '1' : '0',
    opts.includeHidden ? '1' : '0',
    opts.customPaths.join('|')
  ].join('\x00')
}

export async function enumerateApps(opts: EnumerateOptions): Promise<AppEntry[]> {
  const key = cacheKey(opts)
  if (cache && cache.key === key) {
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
      collected.push(...(await enumerateMacApplications(opts.includeHidden)))
    }
  }

  if (opts.customPaths.length > 0) {
    collected.push(...(await enumerateCustomPaths(opts.customPaths, opts.includeHidden)))
  }

  const deduped = dedupeByName(collected)
  deduped.sort((a, b) => a.name.localeCompare(b.name))

  cache = { key, entry: { apps: deduped } }
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
