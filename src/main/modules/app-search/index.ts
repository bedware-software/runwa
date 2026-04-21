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
        'Windows: User and system Start Menu shortcuts. macOS: `/Applications` and `~/Applications` bundles.',
      defaultValue: true
    },
    {
      key: 'includeUwp',
      type: 'checkbox',
      label: 'Store / UWP apps',
      description:
        'Windows-only. Apps registered with Windows AppX / Microsoft Store (Calculator, Settings, PWAs, etc.) that aren\'t plain shortcuts.',
      defaultValue: true
    },
    {
      key: 'includeDesktop',
      type: 'checkbox',
      label: 'Desktop shortcuts',
      description:
        'Windows-only. User and Public Desktop shortcuts. Often duplicates Start Menu entries — on by the user\'s request only.',
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

export function createAppSearchModule(): PaletteModule {
  // Every enumeration call caches internally; this map is a process-wide
  // lookup so `execute()` can find the entry by id without re-enumerating.
  const entriesById = new Map<string, AppEntry>()

  const toItem = (
    entry: AppEntry,
    score: number
  ): Omit<PaletteItem, 'moduleId'> => ({
    id: entry.id,
    title: entry.name,
    subtitle: entry.uwpAppId ? 'Store app' : entry.filePath,
    // Icon resolution:
    //  - Files with a real path: reuse the warmed exe-icon cache (works for
    //    .lnk on Windows because app.getFileIcon resolves the target, and
    //    for .app on macOS because icon-cache routes those through
    //    createThumbnailFromPath).
    //  - UWP entries: no path to pass to getFileIcon, so fall back to the
    //    Lucide `rocket` glyph. Richer UWP logo extraction is a later pass.
    iconHint:
      getIconDataUrlSync(entry.filePath) ?? 'rocket',
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
      const customPaths = parseCustomPaths(context.config.customPaths)

      const apps = await enumerateApps({
        includeStartMenu,
        includeUwp,
        includeDesktop,
        customPaths
      })
      if (signal.aborted) return []

      // Refresh the id→entry map for execute().
      entriesById.clear()
      for (const a of apps) entriesById.set(a.id, a)

      const trimmed = query.trim()

      // Empty query (always scoped — the home-screen picker never calls us
      // unscoped): alphabetical full list, lightly warm-loaded icons for
      // the first page of results so the visible rows don't flash to the
      // lucide fallback.
      if (trimmed === '') {
        const visibleHead = apps.slice(0, 30).map((a) => a.filePath)
        await warmIconCache(visibleHead)
        if (signal.aborted) return []
        return apps.map((a, i) => toItem(a, i / 10000))
      }

      const fuse = new Fuse(apps, {
        keys: [{ name: 'name', weight: 1 }],
        includeScore: true,
        threshold: 0.4,
        ignoreLocation: true
      })
      const matches = fuse.search(trimmed)
      if (signal.aborted) return []

      // Warm icons only for the matched subset — enumerating all 100+ apps'
      // icons every keystroke is wasteful when only ~10 will render.
      await warmIconCache(matches.map((r) => r.item.filePath))
      if (signal.aborted) return []

      return matches.map((r) => toItem(r.item, r.score ?? 1))
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
    }
  }
}
