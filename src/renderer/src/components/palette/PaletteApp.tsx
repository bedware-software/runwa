import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpDown, CornerDownLeft, Settings as SettingsIcon } from 'lucide-react'
import { usePaletteStore } from '@/store/palette-store'
import { useSettingsStore } from '@/store/settings-store'
import { keyEventToAccelerator } from '@/lib/hotkey'
import { SearchInput } from './SearchInput'
import { ResultsList } from './ResultsList'
import { ModeBadge } from './ModeBadge'
import { ContextMenu, revealAction, setAliasAction } from './ContextMenu'
import { AliasInputModal } from './AliasInputModal'
import { FooterHint } from './FooterHint'
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
  const setSelectedIndex = usePaletteStore((s) => s.setSelectedIndex)

  const hydrate = useSettingsStore((s) => s.hydrate)
  const applyServerSettings = useSettingsStore((s) => s.applyServerSettings)
  const modules = useSettingsStore((s) => s.modules)
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'system')
  const openSettingsHotkey = useSettingsStore(
    (s) => s.settings?.openSettingsHotkey ?? ''
  )
  const isHydrated = useSettingsStore((s) => s.isHydrated)

  const inputRef = useRef<HTMLInputElement>(null)

  // Ctrl+K context-menu open state + alias-input modal state. Both are
  // pure UI; no other layer observes them.
  const [menuOpen, setMenuOpen] = useState(false)
  const [aliasModalOpen, setAliasModalOpen] = useState(false)

  const setModuleAlias = useSettingsStore((s) => s.setModuleAlias)

  const selectedItem = items[selectedIndex]
  // Alias actions are app-search-specific today — the module owns the
  // stable entry id schema. Other modules can join the party by surfacing
  // their own module id + alias-capable rows.
  const canSetAlias = selectedItem?.moduleId === 'app-search'
  const contextActions = useMemo(() => {
    const actions = []
    if (canSetAlias) {
      actions.push(
        setAliasAction(Boolean(selectedItem?.alias), () => {
          setMenuOpen(false)
          setAliasModalOpen(true)
        })
      )
    }
    if (selectedItem?.revealPath) actions.push(revealAction(selectedItem.revealPath))
    return actions
  }, [selectedItem?.revealPath, selectedItem?.alias, canSetAlias])
  const canOpenMenu = contextActions.length > 0

  const openContextMenuForRow = (index: number): void => {
    // Right-click should both "select" the row and open the menu; callers
    // that click on a row without any applicable action get nothing
    // (avoids an instant open-close flicker from the canOpenMenu effect
    // below). app-search rows always have at least the "Set alias…"
    // action, so the menu opens even for UWP entries without revealPath.
    const target = items[index]
    const hasAction =
      target && (target.revealPath || target.moduleId === 'app-search')
    if (!hasAction) return
    setSelectedIndex(index)
    setMenuOpen(true)
  }

  // Close the menu if the selection moves to a row without reveal actions
  // (e.g. user navigated to a UWP entry in app-search).
  useEffect(() => {
    if (!canOpenMenu) setMenuOpen(false)
  }, [canOpenMenu])

  // Restore focus to the search input when the alias modal closes. The
  // modal's own <input> steals DOM focus while it's open, and once it
  // unmounts focus would otherwise land on <body> — which has no
  // keydown handler, so arrow keys / Enter / Esc silently stop working
  // until the user clicks back into the search box. The cleanup
  // pattern fires exactly on the close transition (true → false),
  // including the unmount-during-hide case.
  useEffect(() => {
    if (!aliasModalOpen) return
    return () => {
      inputRef.current?.focus()
    }
  }, [aliasModalOpen])

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
    // While the context menu or the alias-input modal is open, they own
    // the keyboard — their own document-level capture handlers run first
    // and stop propagation for the keys they care about. The early-return
    // here is belt-and-suspenders so arrow/enter/escape keys don't
    // double-fire palette-level behaviour while the overlay is up.
    if (menuOpen || aliasModalOpen) return

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

      <ResultsList
        items={items}
        selectedIndex={selectedIndex}
        isLoading={isLoading}
        onOpenContextMenu={openContextMenuForRow}
      />

      <div className="h-10 px-2 flex items-center justify-between border-t border-border bg-toolbar text-[12px] font-medium text-muted-foreground shrink-0">
        <div className="flex items-center gap-1">
          <FooterHint
            label="Navigate"
            keys={<Kbd><ArrowUpDown size={12} strokeWidth={1.5} /></Kbd>}
          />
          <FooterHint
            label="Select"
            keys={<Kbd><CornerDownLeft size={12} strokeWidth={1.5} /></Kbd>}
          />
          {canOpenMenu && (
            <FooterHint label="Context menu" keys={<Hotkey value="Ctrl+K" />} />
          )}
          {activeModuleId === 'app-search' && (
            <FooterHint label="Rescan" keys={<Hotkey value="Ctrl+R" />} />
          )}
          <FooterHint
            label={activeModuleId ? 'Back' : 'Dismiss'}
            keys={<Hotkey value="Esc" />}
          />
        </div>
        <FooterHint
          leading={<SettingsIcon size={12} strokeWidth={1.5} />}
          label="Settings"
          keys={<Hotkey value={openSettingsHotkey} />}
          onClick={() => void window.electronAPI.openSettings()}
        />
      </div>

      <ContextMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        actions={contextActions}
      />

      {selectedItem && selectedItem.moduleId === 'app-search' && (
        <AliasInputModal
          open={aliasModalOpen}
          itemTitle={selectedItem.title}
          initialValue={selectedItem.alias ?? ''}
          onClose={() => setAliasModalOpen(false)}
          onSave={(alias) => {
            // Main's `patchModuleAlias` handles empty-string = clear, so
            // we can hand the raw input straight through. refresh() so
            // the alias chip renders (or disappears) immediately;
            // preserveSelection keeps the cursor on the just-edited
            // row instead of snapping back to the top of the list.
            void setModuleAlias('app-search', selectedItem.id, alias || null).then(
              () => refresh({ preserveSelection: true })
            )
            setAliasModalOpen(false)
          }}
        />
      )}
    </div>
  )
}
