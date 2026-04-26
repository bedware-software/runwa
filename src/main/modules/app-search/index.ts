import Fuse from 'fuse.js'
import type { ModuleManifest, PaletteItem } from '@shared/types'
import type { PaletteModule } from '../types'
import { enumerateApps, invalidateAppCache, type AppEntry } from './enumerator'
import { launchApp } from './launcher'
import { getIconDataUrlSync, warmIconCache } from '../../icon-cache'

const MANIFEST: ModuleManifest = {
  id: 'app-search',
  name: 'App Search',
  icon: 'rocket',
  kind: 'search',
  description: 'Launch installed applications. Indexes Start Menu (Windows) / Applications (macOS), plus Store apps and optional extra locations.',
  defaultEnabled: true,
  supportsDirectLaunch: true,
  defaultDirectLaunchHotkey: 'Ctrl+Alt+A',
  configFields: [
    {
      key: 'includeStartMenu',
      type: 'checkbox',
      label: 'Start Menu apps',
      description:
        'Windows: User and system Start Menu shortcuts. macOS: `.app` bundles under `/Applications`, `/System/Applications` (including Utilities and System Settings), and `~/Applications`.',
      defaultValue: true
    },
    {
      key: 'includeHidden',
      type: 'checkbox',
      os: 'macos',
      label: 'Hidden apps',
      description:
        'Show `.app` bundles whose name starts with a dot (e.g. `.Karabiner-VirtualHIDDevice-Manager`). These are system helpers macOS hides from Finder and Spotlight by default — usually not what you want to launch.',
      defaultValue: false
    },
    {
      key: 'includeUwp',
      type: 'checkbox',
      os: 'windows',
      label: 'Store / UWP apps',
      description:
        'Apps registered with Windows AppX / Microsoft Store (Calculator, Settings, PWAs, etc.) that aren\'t plain shortcuts.',
      defaultValue: true
    },
    {
      key: 'includeDesktop',
      type: 'checkbox',
      os: 'windows',
      label: 'Desktop shortcuts',
      description:
        'User and Public Desktop shortcuts. Often duplicates Start Menu entries — on by the user\'s request only.',
      defaultValue: false
    },
    {
      key: 'customPaths',
      type: 'text',
      label: 'Additional folders',
      description:
        'One folder per line. Walked recursively (up to three levels) for executables / shortcuts / .app bundles. Useful for portable apps outside the Start Menu.',
      multiline: true,
      defaultValue: '',
      placeholder: 'D:\\Portable\\Apps'
    },
    {
      key: 'aliasMode',
      type: 'radio',
      label: 'Alias match behavior',
      description:
        'Aliases are set per-app from the Ctrl+K context menu. When the typed query exactly matches one:',
      defaultValue: 'prioritize',
      options: [
        {
          value: 'prioritize',
          label: 'Boost the matching app to the top of results'
        },
        {
          value: 'launch',
          label: 'Launch the app immediately without pressing Enter'
        }
      ]
    }
  ]
}

interface LaunchAction {
  entryId: string
}

function isLaunchAction(a: unknown): a is LaunchAction {
  return (
    typeof a === 'object' &&
    a !== null &&
    'entryId' in a &&
    typeof (a as { entryId: unknown }).entryId === 'string'
  )
}

function parseCustomPaths(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * First app whose stored alias exactly matches the (normalised) query.
 * Aliases are stored lowercased by the main-process setter, so a simple
 * equality check is enough here.
 */
function findExactAliasMatch(
  apps: AppEntry[],
  aliases: Record<string, string>,
  normalisedQuery: string
): AppEntry | undefined {
  if (!normalisedQuery) return undefined
  for (const a of apps) {
    const alias = aliases[a.id]
    if (alias && alias === normalisedQuery) return a
  }
  return undefined
}

export function createAppSearchModule(): PaletteModule {
  // Every enumeration call caches internally; this map is a process-wide
  // lookup so `execute()` can find the entry by id without re-enumerating.
  const entriesById = new Map<string, AppEntry>()

  const toItem = (
    entry: AppEntry,
    score: number,
    alias?: string,
    autoExecute = false
  ): Omit<PaletteItem, 'moduleId'> => ({
    id: entry.id,
    title: entry.name,
    subtitle: entry.uwpAppId ? 'Store app' : entry.filePath,
    // Icon resolution, in priority order:
    //  1. `iconPath` when set — UWP entries resolve their
    //     `Square44x44Logo.*.png` at enumeration time, and icon-cache routes
    //     plain PNGs through `nativeImage.createFromPath`.
    //  2. `filePath` — Start-Menu .lnk / .exe / .url / .appref-ms on Windows,
    //     `.app` bundles on macOS.
    //  3. Lucide `rocket` glyph fallback — either UWP entry with no Assets
    //     folder match, or Win32 path that getFileIcon couldn't resolve.
    iconHint:
      getIconDataUrlSync(entry.iconPath ?? entry.filePath) ?? 'rocket',
    // Ctrl+K context menu's "Show in file explorer" target. Only Win32
    // entries carry a usable filesystem path; UWP entries are addressed by
    // AUMID and have no stable folder to open, so we leave revealPath
    // undefined for them (the menu hotkey then becomes a no-op per row).
    revealPath: entry.filePath,
    alias,
    autoExecute: autoExecute || undefined,
    actionKind: 'launch-app',
    action: { entryId: entry.id } satisfies LaunchAction,
    score
  })

  return {
    manifest: MANIFEST,

    async search(query, signal, context) {
      if (signal.aborted) return []

      const includeStartMenu = context.config.includeStartMenu !== false
      const includeUwp = context.config.includeUwp !== false
      const includeDesktop = context.config.includeDesktop === true
      const includeHidden = context.config.includeHidden === true
      const customPaths = parseCustomPaths(context.config.customPaths)
      const aliasMode =
        context.config.aliasMode === 'launch' ? 'launch' : 'prioritize'

      const apps = await enumerateApps({
        includeStartMenu,
        includeUwp,
        includeDesktop,
        includeHidden,
        customPaths
      })
      if (signal.aborted) return []

      // Refresh the id→entry map for execute().
      entriesById.clear()
      for (const a of apps) entriesById.set(a.id, a)

      const aliases = context.aliases ?? {}
      const trimmed = query.trim()
      const normalisedQuery = trimmed.toLowerCase()

      // Empty query: alphabetical full list, alias chip rendered where
      // the user set one so they can double-check their mappings.
      if (trimmed === '') {
        await warmIconCache(apps.map((a) => a.iconPath ?? a.filePath))
        if (signal.aborted) return []
        return apps.map((a, i) => toItem(a, i / 10000, aliases[a.id]))
      }

      // Exact alias match short-circuits when the user opted into
      // `launch` mode — return a single autoExecute item and skip the
      // fuzzy pass entirely. In `prioritize` mode we still run the
      // fuzzy search but bump the matching entry to the top below.
      const exactAliasEntry = findExactAliasMatch(apps, aliases, normalisedQuery)
      if (exactAliasEntry && aliasMode === 'launch') {
        await warmIconCache([exactAliasEntry.iconPath ?? exactAliasEntry.filePath])
        if (signal.aborted) return []
        return [toItem(exactAliasEntry, -1, aliases[exactAliasEntry.id], true)]
      }

      // Fuzzy pass — include aliases as a secondary search key so a
      // partial alias hit ("ch" → "chrome") still surfaces the app.
      const fuseSource = apps.map((a) => ({
        entry: a,
        name: a.name,
        alias: aliases[a.id] ?? ''
      }))
      const fuse = new Fuse(fuseSource, {
        keys: [
          { name: 'name', weight: 0.7 },
          { name: 'alias', weight: 0.3 }
        ],
        includeScore: true,
        threshold: 0.4,
        ignoreLocation: true
      })
      let matches = fuse.search(trimmed)
      if (signal.aborted) return []

      // Prioritize mode: lift the exact-alias entry to score -1 (above
      // any fuzzy hit). If Fuse's threshold dropped it, re-insert at
      // the top so the alias always wins against similar-looking names.
      if (exactAliasEntry && aliasMode === 'prioritize') {
        const idx = matches.findIndex((m) => m.item.entry.id === exactAliasEntry.id)
        const promoted = {
          item: { entry: exactAliasEntry, name: exactAliasEntry.name, alias: normalisedQuery },
          refIndex: 0,
          score: -1
        }
        if (idx >= 0) matches.splice(idx, 1)
        matches = [promoted, ...matches]
      }

      await warmIconCache(
        matches.map((r) => r.item.entry.iconPath ?? r.item.entry.filePath)
      )
      if (signal.aborted) return []

      return matches.map((r) =>
        toItem(r.item.entry, r.score ?? 1, aliases[r.item.entry.id])
      )
    },

    async execute(item) {
      if (item.actionKind !== 'launch-app' || !isLaunchAction(item.action)) {
        console.warn('[app-search] invalid action', item)
        return { dismissPalette: false }
      }
      const entry = entriesById.get(item.action.entryId)
      if (!entry) {
        // Stale item from a previous enumeration run — drop the cache so
        // the next search picks up a fresh snapshot.
        invalidateAppCache()
        return { dismissPalette: false }
      }
      const ok = await launchApp(entry)
      if (!ok) invalidateAppCache()
      return { dismissPalette: ok }
    },

    // Hotkey-driven actions. The palette's Ctrl+R handler (only wired while
    // app-search is the active scope) dispatches `rescan` here — invalidates
    // the enumeration cache so the subsequent automatic re-search picks up
    // newly-installed apps without waiting for a process restart.
    async onAction(key) {
      if (key === 'rescan') invalidateAppCache()
    }
  }
}
