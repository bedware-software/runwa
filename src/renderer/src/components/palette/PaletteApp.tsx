import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpDown, CornerDownLeft, Settings as SettingsIcon } from 'lucide-react'
import { usePaletteStore } from '@/store/palette-store'
import { useSettingsStore } from '@/store/settings-store'
import { keyEventToAccelerator } from '@/lib/hotkey'
import { SearchInput } from './SearchInput'
import { ResultsList } from './ResultsList'
import { ModeBadge } from './ModeBadge'
import { ContextMenu, revealAction } from './ContextMenu'
import { Kbd, Hotkey } from '../ui/Kbd'

export function PaletteApp() {
  const query = usePaletteStore((s) => s.query)
  const items = usePaletteStore((s) => s.items)
  const selectedIndex = usePaletteStore((s) => s.selectedIndex)
  const isLoading = usePaletteStore((s) => s.isLoading)
  const resolvedModuleId = usePaletteStore((s) => s.resolvedModuleId)
  const activeModuleId = usePaletteStore((s) => s.activeModuleId)
  const setQuery = usePaletteStore((s) => s.setQuery)
  const selectNext = usePaletteStore((s) => s.selectNext)
  const selectPrev = usePaletteStore((s) => s.selectPrev)
  const executeSelected = usePaletteStore((s) => s.executeSelected)
  const onPaletteShow = usePaletteStore((s) => s.onPaletteShow)
  const unscope = usePaletteStore((s) => s.unscope)
  const refresh = usePaletteStore((s) => s.refresh)

  const hydrate = useSettingsStore((s) => s.hydrate)
  const applyServerSettings = useSettingsStore((s) => s.applyServerSettings)
  const modules = useSettingsStore((s) => s.modules)
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'system')
  const openSettingsHotkey = useSettingsStore(
    (s) => s.settings?.openSettingsHotkey ?? ''
  )
  const isHydrated = useSettingsStore((s) => s.isHydrated)

  const inputRef = useRef<HTMLInputElement>(null)

  // Ctrl+K context-menu open state. Local to this component because the
  // menu is purely UI — no other layer cares whether it's open.
  const [menuOpen, setMenuOpen] = useState(false)

  const selectedItem = items[selectedIndex]
  const contextActions = useMemo(
    () =>
      selectedItem?.revealPath ? [revealAction(selectedItem.revealPath)] : [],
    [selectedItem?.revealPath]
  )
  const canOpenMenu = contextActions.length > 0

  // Close the menu if the selection moves to a row without reveal actions
  // (e.g. user navigated to a UWP entry in app-search).
  useEffect(() => {
    if (!canOpenMenu) setMenuOpen(false)
  }, [canOpenMenu])

  // Initial hydration
  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Theme → data-theme attribute
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // palette:show event from main (activation or direct-launch hotkey)
  useEffect(() => {
    const unsub = window.electronAPI.onPaletteShow((payload) => {
      onPaletteShow(payload.initialModuleId)
      // Re-focus the input — the window loses focus on hide
      setTimeout(() => inputRef.current?.focus(), 0)
    })
    return unsub
  }, [onPaletteShow])

  // Settings change broadcasts
  useEffect(() => {
    const unsub = window.electronAPI.onSettingsChanged((settings) => {
      applyServerSettings(settings)
    })
    return unsub
  }, [applyServerSettings])

  // Once hydrated, populate the initial (empty query) result list.
  useEffect(() => {
    if (isHydrated) {
      setQuery('')
    }
  }, [isHydrated, setQuery])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    // While the context menu is open it owns the keyboard — its own
    // document-level capture handler runs before this one and stops
    // propagation. The early-return here is belt-and-suspenders so a
    // React synthetic event can't fall through and re-trigger select/
    // dismiss logic.
    if (menuOpen) return

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && canOpenMenu) {
      e.preventDefault()
      setMenuOpen(true)
      return
    }
    // Ctrl+R inside app-search: drop the main-process enumeration cache and
    // re-run the current search. preventDefault so the browser's built-in
    // "reload page" doesn't fire inside Electron's webContents.
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === 'r' &&
      activeModuleId === 'app-search'
    ) {
      e.preventDefault()
      void (async () => {
        await window.electronAPI.modulesAction('app-search', 'rescan')
        refresh()
      })()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      // Escape inside a scoped module returns to the home-screen picker
      // instead of dismissing — matches Alfred / Raycast convention. A
      // second Escape (now unscoped) dismisses the palette.
      if (activeModuleId) {
        unscope()
      } else {
        void window.electronAPI.paletteHide()
      }
      return
    }
    if (e.key === 'Backspace' && query === '' && activeModuleId) {
      // Backspace on an empty query while scoped also returns to the picker.
      e.preventDefault()
      unscope()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectNext()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectPrev()
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      void executeSelected()
      return
    }

    // Window-local shortcut: Open Settings (default Ctrl+,). Only fires while
    // the palette has focus — intentionally not a globalShortcut so the chord
    // stays available to IDEs when runwa isn't active.
    if (openSettingsHotkey) {
      const accel = keyEventToAccelerator(e)
      if (accel && accel === openSettingsHotkey) {
        e.preventDefault()
        void window.electronAPI.openSettings()
      }
    }
  }

  const activeId = activeModuleId ?? resolvedModuleId
  const activeMod = activeId ? modules.find((m) => m.id === activeId) : undefined

  return (
    <div
      className="relative h-full bg-popover text-popover-foreground flex flex-col rounded-md border border-border overflow-hidden"
      onKeyDown={onKeyDown}
    >
      <div className="px-3 py-2 border-b border-border flex items-center gap-2 [-webkit-app-region:drag]">
        <SearchInput
          ref={inputRef}
          value={query}
          onChange={setQuery}
          placeholder={
            activeMod
              ? `Search ${activeMod.name.toLowerCase()}…`
              : 'Type a command or search…'
          }
        />
        {activeMod && <ModeBadge name={activeMod.name} />}
      </div>

      <ResultsList items={items} selectedIndex={selectedIndex} isLoading={isLoading} />

      <div className="h-10 px-3 flex items-center justify-between border-t border-border bg-toolbar text-[11px] font-medium text-muted-foreground shrink-0">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            Navigate <Kbd><ArrowUpDown size={11} strokeWidth={2.5} /></Kbd>
          </span>
          <span className="flex items-center gap-1">
            Select <Kbd><CornerDownLeft size={11} strokeWidth={2.5} /></Kbd>
          </span>
          {canOpenMenu && (
            <span className="flex items-center gap-1">
              Context menu <Hotkey value="Ctrl+K" />
            </span>
          )}
          {activeModuleId === 'app-search' && (
            <span className="flex items-center gap-1">
              Rescan <Hotkey value="Ctrl+R" />
            </span>
          )}
          <span className="flex items-center gap-1">
            {activeModuleId ? 'Back' : 'Dismiss'} <Hotkey value="Esc" />
          </span>
        </div>
        <button
          type="button"
          className="flex items-center gap-1 hover:text-foreground transition-colors"
          onClick={() => void window.electronAPI.openSettings()}
        >
          <SettingsIcon size={11} />
          Settings
          <Hotkey value={openSettingsHotkey} />
        </button>
      </div>

      <ContextMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        actions={contextActions}
      />
    </div>
  )
}
