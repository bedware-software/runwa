import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpDown, CornerDownLeft } from 'lucide-react'
import { usePaletteStore } from '@/store/palette-store'
import { useSettingsStore } from '@/store/settings-store'
import { SearchInput } from './SearchInput'
import { ResultsList } from './ResultsList'
import { ModeBadge } from './ModeBadge'
import { ContextMenu, resetDeckAction, revealAction, setAliasAction } from './ContextMenu'
import { ConfirmDialog } from '../ConfirmDialog'
import { Toggle } from '../ui/Toggle'
import { AliasInputModal } from './AliasInputModal'
import { FooterHint } from './FooterHint'
import { Kbd, Hotkey } from '../ui/Kbd'
import { QuizView } from './QuizView'

/**
 * Module ids whose entries the user can attach a Ctrl+K alias to. Both
 * modules expose stable per-item ids (app paths, command ids) so an alias
 * stored in settings still matches the same row across restarts. Adding a
 * module here is the only step needed to surface the alias menu for it.
 */
const ALIAS_CAPABLE_MODULES = new Set(['app-search', 'command-palette'])

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
  const refresh = usePaletteStore((s) => s.refresh)
  const setSelectedIndex = usePaletteStore((s) => s.setSelectedIndex)

  const quiz = usePaletteStore((s) => s.quiz)
  const startQuiz = usePaletteStore((s) => s.startQuiz)
  const exitQuiz = usePaletteStore((s) => s.exitQuiz)
  const submitAnswer = usePaletteStore((s) => s.submitAnswer)
  const skipCurrent = usePaletteStore((s) => s.skipCurrent)
  const nextCard = usePaletteStore((s) => s.nextCard)
  const prevCard = usePaletteStore((s) => s.prevCard)

  const hydrate = useSettingsStore((s) => s.hydrate)
  const applyServerSettings = useSettingsStore((s) => s.applyServerSettings)
  const modules = useSettingsStore((s) => s.modules)
  const theme = useSettingsStore((s) => s.settings?.theme ?? 'system')
  // The keycaps + matching digit chord live or die together — drive both
  // off the same setting so an unchecked toggle silently disables both.
  const quickLaunchDigits = useSettingsStore(
    (s) => s.settings?.quickLaunchDigits ?? true
  )
  const isHydrated = useSettingsStore((s) => s.isHydrated)

  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Ctrl+K context-menu open state + alias-input modal state. Both are
  // pure UI; no other layer observes them.
  const [menuOpen, setMenuOpen] = useState(false)
  const [aliasModalOpen, setAliasModalOpen] = useState(false)
  // Flashcards-specific: deck-id slated for destructive reset.
  // `null` = no confirm dialog open; a string = dialog up for that
  // deck. Lives in PaletteApp because the action is invoked from a
  // context-menu item attached to a deck row.
  const [resetDeckId, setResetDeckId] = useState<string | null>(null)

  const setModuleAlias = useSettingsStore((s) => s.setModuleAlias)
  const setModuleConfig = useSettingsStore((s) => s.setModuleConfig)

  // Window-switcher exposes a "current desktop only" filter that the
  // user wants to flip mid-search via Tab without a trip to Settings.
  // We read the live value from the settings store so the badge in
  // the palette top bar reflects edits from Settings UI too (e.g.
  // user un-checks the box there → palette badge flips).
  const wsCurrentDesktopOnly =
    activeModuleId === 'window-switcher'
      ? (() => {
          const mod = modules.find((m) => m.id === 'window-switcher')
          const v = mod?.config.currentDesktopOnly
          // Manifest defaults the field to true, so an unset value
          // (fresh install, settings.json hand-trimmed) means "on".
          return v !== false
        })()
      : null

  const selectedItem = items[selectedIndex]
  const canSetAlias =
    !!selectedItem && ALIAS_CAPABLE_MODULES.has(selectedItem.moduleId)
  const isFlashcardDeckRow =
    !!selectedItem &&
    selectedItem.moduleId === 'flashcards' &&
    selectedItem.actionKind === 'start-quiz'
  // The action payload carries `deckId` on every flashcards row — see
  // `flashcards/index.ts` search(). We pull it once for the menu so
  // the ConfirmDialog knows which deck to wipe.
  const selectedDeckId =
    isFlashcardDeckRow &&
    typeof (selectedItem.action as { deckId?: unknown })?.deckId === 'string'
      ? ((selectedItem.action as { deckId: string }).deckId)
      : null
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
    if (selectedDeckId) {
      actions.push(
        resetDeckAction(() => {
          setMenuOpen(false)
          setResetDeckId(selectedDeckId)
        })
      )
    }
    return actions
  }, [
    selectedItem?.revealPath,
    selectedItem?.alias,
    canSetAlias,
    selectedDeckId
  ])
  const canOpenMenu = contextActions.length > 0

  const openContextMenuForRow = (index: number): void => {
    // Right-click should both "select" the row and open the menu; callers
    // that click on a row without any applicable action get nothing
    // (avoids an instant open-close flicker from the canOpenMenu effect
    // below). Alias-capable rows always have at least the "Set alias…"
    // action, so the menu opens even when no revealPath is set.
    const target = items[index]
    const hasAction =
      !!target &&
      (target.revealPath !== undefined ||
        ALIAS_CAPABLE_MODULES.has(target.moduleId) ||
        (target.moduleId === 'flashcards' && target.actionKind === 'start-quiz'))
    if (!hasAction) return
    setSelectedIndex(index)
    setMenuOpen(true)
  }

  const confirmReset = async (): Promise<void> => {
    if (!resetDeckId) return
    const id = resetDeckId
    setResetDeckId(null)
    try {
      await window.electronAPI.flashcardsResetDeck(id)
      // Re-pull the deck list so the row's subtitle / icon flip back
      // to the active-learning state. Keep the cursor where it was
      // so the user can immediately start (or re-quiz) the deck.
      refresh({ preserveSelection: true })
    } catch (err) {
      console.warn('[flashcards] reset failed', err)
    }
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

  // Same pattern for the Reset-deck confirm dialog. ConfirmDialog
  // auto-focuses its own button while it's open, so the search
  // input loses focus and (without this) the user has to click
  // back into the palette to resume typing.
  useEffect(() => {
    if (resetDeckId === null) return
    return () => {
      inputRef.current?.focus()
    }
  }, [resetDeckId])

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

  // flashcards:start-quiz event from main — flips the palette into
  // quiz mode in the same window. We rely on the rootRef focus effect
  // below to move keyboard focus off the SearchInput onto the root
  // div so 1-9 / Space / arrows go to the quiz handler.
  useEffect(() => {
    const unsub = window.electronAPI.onFlashcardsStartQuiz((payload) => {
      startQuiz(payload)
    })
    return unsub
  }, [startQuiz])

  // Keep keyboard focus aligned with the current mode. In search mode
  // the SearchInput must own focus so typing into the query works; in
  // quiz mode the root div owns focus so keystrokes hit the
  // quiz-mode branch of onKeyDown (the SearchInput is unmounted and
  // can't claim focus anyway). We re-focus on every quiz<->search
  // transition.
  useEffect(() => {
    if (quiz) {
      rootRef.current?.focus()
    } else {
      // setTimeout(0) lets React commit the unmount/remount of
      // SearchInput before we try to focus it.
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [quiz !== null, quiz?.finished])

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
    // While the context menu, alias-input modal, or reset-confirm
    // dialog is open, THEY own the keyboard — their own focus / capture
    // handlers run first and stop propagation for the keys they care
    // about. The early-return here is belt-and-suspenders so
    // arrow/enter/escape keys don't double-fire palette-level
    // behaviour while the overlay is up. The reset dialog in
    // particular auto-focuses its confirm button — without this guard
    // the palette's Enter handler would fire BEFORE the button's
    // native activation, executing the deck instead of confirming the
    // reset.
    if (menuOpen || aliasModalOpen || resetDeckId !== null) return

    // Quiz mode owns the keyboard while a session is active. We branch
    // EARLY so none of the search-mode handlers (Esc=dismiss palette,
    // arrow=move selection, digits=quick-launch) can fire on top of
    // the quiz semantics.
    if (quiz) {
      handleQuizKey(e)
      return
    }

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
    // Tab inside window-switcher: flip the "current desktop only"
    // filter mid-search without a trip to Settings. preventDefault
    // so the browser's default focus shift doesn't pull focus off
    // the search input. The settings-store IPC round-trip persists
    // the new value (it survives across sessions) AND broadcasts to
    // every renderer, so the Settings panel checkbox stays in sync
    // when both windows are open. refresh() re-runs the search with
    // the new filter applied; preserveSelection keeps the cursor on
    // the same window if it's still in the result set.
    if (
      e.key === 'Tab' &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      activeModuleId === 'window-switcher' &&
      wsCurrentDesktopOnly !== null
    ) {
      e.preventDefault()
      void setModuleConfig('window-switcher', {
        currentDesktopOnly: !wsCurrentDesktopOnly
      }).then(() => refresh({ preserveSelection: true }))
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      void window.electronAPI.paletteHide()
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
      // Ctrl+Enter on a flashcards deck row cram-launches (skip
      // SRS due-filter and quiz every well-formed card). For any
      // other module Ctrl+Enter behaves like Enter.
      const cram =
        e.ctrlKey && items[selectedIndex]?.actionKind === 'start-quiz'
      void executeSelected(cram ? { cram: true } : undefined)
      return
    }

    // Quick-launch digits: when the result list is narrow enough that
    // ResultsList renders 1..N badges (≤4 items), pressing the matching
    // digit selects + runs that row. Mirrors the badge cap so the chord
    // and the visual hint stay in lock-step. We bail on modifiers so
    // future Ctrl/Alt/Cmd+digit chords stay free for other features.
    // The whole feature is gated by the General-panel toggle so users
    // who'd rather just type "12" / "34" into the search box can opt out.
    if (
      quickLaunchDigits &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      items.length > 0 &&
      items.length <= 4 &&
      /^[1-4]$/.test(e.key)
    ) {
      const idx = Number(e.key) - 1
      if (idx < items.length) {
        e.preventDefault()
        setSelectedIndex(idx)
        void executeSelected()
        return
      }
    }
  }

  const handleQuizKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!quiz) return
    const key = e.key

    // Esc always exits the quiz back to the deck list. The user has
    // to press Esc again on the deck list to dismiss the palette,
    // mirroring the "press the same key twice to fully back out"
    // pattern the rest of the launcher uses.
    if (key === 'Escape') {
      e.preventDefault()
      exitQuiz()
      return
    }

    if (quiz.finished) {
      // On the summary screen only ← (revisit last card) is meaningful;
      // everything else is a no-op so it's clear the session is done.
      if (key === 'ArrowLeft' || key === 'Backspace') {
        e.preventDefault()
        prevCard()
      }
      return
    }

    const cardId = quiz.quizCardIds[quiz.index]
    const card = cardId
      ? quiz.deck.cards.find((c) => c.id === cardId)
      : undefined
    const result = cardId ? quiz.results[cardId] : undefined

    // Space is the primary "next" so a single hand stays on 1-9 + the
    // thumb on Space — Right and `w` are aliases. Both cases of W are
    // matched so Caps Lock doesn't strand the binding. Space keeps its
    // modifier guard so Ctrl/Meta/Alt + Space stays free for system
    // chords.
    if (
      key === 'ArrowRight' ||
      key === 'w' ||
      key === 'W' ||
      (key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey)
    ) {
      e.preventDefault()
      // Pre-Space without an answer = treat as "skip and advance"; users
      // who want to read but not commit press Enter to reveal first.
      if (!result) {
        void skipCurrent().then(nextCard)
      } else {
        nextCard()
      }
      return
    }
    if (key === 'ArrowLeft' || key === 'Backspace') {
      e.preventDefault()
      prevCard()
      return
    }
    if (key === 'Enter') {
      e.preventDefault()
      // Enter = reveal-without-picking. No-op once the user has
      // already answered (the answer is the reveal).
      if (!result) void skipCurrent()
      return
    }
    if (/^[1-9]$/.test(key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const idx = Number(key) - 1
      if (card && idx >= 0 && idx < card.options.length && !result) {
        e.preventDefault()
        void submitAnswer(idx)
      }
      return
    }
  }

  const activeId = activeModuleId ?? resolvedModuleId
  const activeMod = activeId ? modules.find((m) => m.id === activeId) : undefined

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="relative h-full bg-popover text-popover-foreground flex flex-col rounded-md border border-border overflow-hidden focus:outline-none"
      onKeyDown={onKeyDown}
    >
      {quiz ? (
        <QuizView quiz={quiz} />
      ) : (
        <>
          <div className="px-4 py-2 border-b border-border flex items-center gap-2 [-webkit-app-region:drag]">
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
            {activeModuleId === 'window-switcher' &&
              wsCurrentDesktopOnly !== null && (
                // Label + slider toggle row. The label reflects the
                // CURRENT state ("This desktop" / "All desktops") so
                // the user reads "where am I right now" at a glance;
                // the footer hint at the bottom of the palette
                // describes what Tab will switch TO. Click the
                // slider OR Tab from the keyboard to flip.
                <div
                  className="flex items-center gap-2 shrink-0 px-2 h-7 select-none"
                  title="Tab to switch"
                >
                  <span className="text-xs font-medium text-muted-foreground">
                    {wsCurrentDesktopOnly ? 'This desktop' : 'All desktops'}
                  </span>
                  <Toggle
                    checked={wsCurrentDesktopOnly}
                    onChange={(next) => {
                      void setModuleConfig('window-switcher', {
                        currentDesktopOnly: next
                      }).then(() => refresh({ preserveSelection: true }))
                    }}
                    ariaLabel={
                      wsCurrentDesktopOnly
                        ? 'This desktop (toggle to all desktops)'
                        : 'All desktops (toggle to this desktop)'
                    }
                  />
                </div>
              )}
            {activeMod && <ModeBadge name={activeMod.name} />}
          </div>

          <ResultsList
            items={items}
            selectedIndex={selectedIndex}
            isLoading={isLoading}
            onOpenContextMenu={openContextMenuForRow}
            showQuickLaunchDigits={quickLaunchDigits}
          />
        </>
      )}

      <div className="h-10 px-2 flex items-center justify-between border-t border-border bg-toolbar text-[12px] font-medium text-muted-foreground shrink-0">
        <div className="flex items-center gap-1">
          {quiz ? (
            quiz.finished ? (
              <>
                <FooterHint label="Revisit last" keys={<Hotkey value="Left" />} />
                <FooterHint label="Back to decks" keys={<Hotkey value="Esc" />} />
              </>
            ) : (
              <>
                <FooterHint
                  label="Answer"
                  keys={<span className="font-mono text-[11px]">1-9</span>}
                />
                <FooterHint label="Reveal" keys={<Hotkey value="Enter" />} />
                <FooterHint
                  label="Next"
                  keys={
                    <span className="inline-flex items-center gap-1">
                      <Hotkey value="Space" />
                      <span className="text-[11px] opacity-60">/</span>
                      <Hotkey value="Right" />
                      <span className="text-[11px] opacity-60">/</span>
                      <Hotkey value="W" />
                    </span>
                  }
                />
                <FooterHint label="Back to decks" keys={<Hotkey value="Esc" />} />
              </>
            )
          ) : (
            <>
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
              {activeModuleId === 'window-switcher' && (
                <FooterHint
                  label={
                    wsCurrentDesktopOnly
                      ? 'Switch to all desktops'
                      : 'Switch to this desktop'
                  }
                  keys={<Hotkey value="Tab" />}
                />
              )}
              {activeModuleId === 'flashcards' &&
                items[selectedIndex]?.actionKind === 'start-quiz' && (
                  <FooterHint label="Cram" keys={<Hotkey value="Ctrl+Enter" />} />
                )}
              <FooterHint label="Dismiss" keys={<Hotkey value="Esc" />} />
            </>
          )}
        </div>
      </div>

      <ContextMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        actions={contextActions}
      />

      {selectedItem && canSetAlias && (
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
            void setModuleAlias(selectedItem.moduleId, selectedItem.id, alias || null).then(
              () => refresh({ preserveSelection: true })
            )
            setAliasModalOpen(false)
          }}
        />
      )}

      <ConfirmDialog
        open={resetDeckId !== null}
        title="Reset deck data?"
        message="This wipes all review history for this deck — every card reverts to “new” and the next session starts from scratch. The deck file itself is not touched. This can't be undone."
        confirmLabel="Reset deck"
        destructive
        onConfirm={() => void confirmReset()}
        onCancel={() => setResetDeckId(null)}
      />
    </div>
  )
}
