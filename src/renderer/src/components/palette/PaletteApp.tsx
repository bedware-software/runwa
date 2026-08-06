import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpDown, CornerDownLeft } from '@/lib/lucide-icons'
import { usePaletteStore } from '@/store/palette-store'
import { useSettingsStore } from '@/store/settings-store'
import { SearchInput } from './SearchInput'
import { ResultsList } from './ResultsList'
import { ModeBadge } from './ModeBadge'
import {
  ContextMenu,
  ignoreProcessAction,
  ignoreWindowAction,
  resetDeckAction,
  revealAction,
  setAliasAction
} from './ContextMenu'
import { ConfirmDialog } from '../ConfirmDialog'
import { Toggle } from '../ui/Toggle'
import { AliasInputModal } from './AliasInputModal'
import { NewUserCommandModal } from './NewUserCommandModal'
import { FooterHint } from './FooterHint'
import { Kbd, Hotkey } from '../ui/Kbd'
import { QuizView } from './QuizView'
import { IS_MAC } from '@/lib/platform'
import type { PaletteItem, WindowIgnoreScope } from '@shared/types'

/**
 * Module ids whose entries the user can attach a Ctrl+K alias to. Both
 * modules expose stable per-item ids (app paths, command ids — including
 * user-created commands, keyed `user-command:<id>`) so an alias stored in
 * settings still matches the same row across restarts.
 */
const ALIAS_CAPABLE_MODULES = new Set(['app-search', 'command-palette'])

/**
 * True for a live-window row from the Window Switcher — the rows that can be
 * added to the module's ignore list from the Ctrl+K menu.
 */
function isWindowSwitcherRow(item: PaletteItem | undefined): boolean {
  return item?.moduleId === 'window-switcher' && item.actionKind === 'focus-window'
}

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
  const activateSecond = usePaletteStore((s) => s.activateSecond)
  const closeSelected = usePaletteStore((s) => s.closeSelected)

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
  // Quick-launch-by-number is always on; this flag only flips the chord.
  // false = plain digit runs the row, Alt+digit types the digit into the
  // search box. true = the reverse.
  const quickLaunchDigitsRequireAlt = useSettingsStore(
    (s) => s.settings?.quickLaunchDigitsRequireAlt ?? false
  )
  const isHydrated = useSettingsStore((s) => s.isHydrated)

  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // App version for the footer toolbar — fetched once on mount. Mirrors
  // the About panel's getAppInfo() read; null until it resolves, which
  // just hides the readout for the first frame.
  const [appVersion, setAppVersion] = useState<string | null>(null)

  // Ctrl+K context-menu open state + alias-input modal state. Both are
  // pure UI; no other layer observes them.
  const [menuOpen, setMenuOpen] = useState(false)
  const [aliasModalOpen, setAliasModalOpen] = useState(false)
  // Flashcards-specific: deck-id slated for destructive reset.
  // `null` = no confirm dialog open; a string = dialog up for that
  // deck. Lives in PaletteApp because the action is invoked from a
  // context-menu item attached to a deck row.
  const [resetDeckId, setResetDeckId] = useState<string | null>(null)
  // "Create user command for <app>" form. `draftApp` is the label main
  // sent with the open request (and the sign that the form is up); the app
  // the command gets scoped to is main's business, not ours.
  const [draftApp, setDraftApp] = useState<string | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [draftSaving, setDraftSaving] = useState(false)

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
  const isWindowRow = isWindowSwitcherRow(selectedItem)

  // Add an ignore rule for the highlighted window and drop it (plus any
  // sibling the rule now covers) from the list. Main derives the rule from
  // the row itself — see `window-switcher:ignore-item`.
  const ignoreSelected = (scope: WindowIgnoreScope): void => {
    if (!selectedItem) return
    void window.electronAPI
      .windowSwitcherIgnoreItem(selectedItem, scope)
      .then((ok) => {
        if (ok) refresh()
      })
      .catch((err) => console.warn('[window-switcher] ignore failed', err))
  }

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
    if (isWindowRow) {
      actions.push(ignoreWindowAction(() => ignoreSelected('window')))
      // The process-wide variant needs an executable name to key off — rows
      // without a subtitle (macOS windows enumerated without a process name)
      // only get the single-window rule.
      if (selectedItem?.subtitle) {
        actions.push(
          ignoreProcessAction(selectedItem.subtitle, () => ignoreSelected('process'))
        )
      }
    }
    if (selectedDeckId) {
      actions.push(
        resetDeckAction(() => {
          setMenuOpen(false)
          setResetDeckId(selectedDeckId)
        })
      )
    }
    return actions
    // `selectedItem?.id` keeps the ignore closures bound to the row that is
    // actually highlighted — the other deps are field values that can repeat
    // across rows (two windows of the same app share a subtitle).
  }, [
    selectedItem?.id,
    selectedItem?.revealPath,
    selectedItem?.alias,
    selectedItem?.subtitle,
    canSetAlias,
    isWindowRow,
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
        (ALIAS_CAPABLE_MODULES.has(target.moduleId) &&
          target.actionKind !== 'user-command') ||
        isWindowSwitcherRow(target) ||
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

  // Resolve the app version once for the footer readout.
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.getAppInfo().then((info) => {
      if (!cancelled) setAppVersion(info.version)
    })
    return () => {
      cancelled = true
    }
  }, [])

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

  // palette:activate-second — re-press of the window-switcher hotkey while
  // the palette is already up. Executes the second row (the previously
  // focused window) instead of dismissing, so a double-press behaves like
  // Alt+Tab on Windows — including for two windows of the same app, which
  // macOS's Cmd+Tab can't reach.
  useEffect(() => {
    const unsub = window.electronAPI.onPaletteActivateSecond(() => {
      activateSecond()
    })
    return unsub
  }, [activateSecond])

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

  // user-commands:draft — the "Create user command for <app>" entry was
  // run. The palette stays in search mode with the form over it, so the
  // user can see the app's other commands while adding another.
  useEffect(() => {
    const unsub = window.electronAPI.onUserCommandsDraft((payload) => {
      setDraftError(null)
      setDraftSaving(false)
      setDraftApp(payload.appLabel)
    })
    return unsub
  }, [])

  // Same focus-restoration pattern as the alias modal — see above.
  useEffect(() => {
    if (draftApp === null) return
    return () => {
      inputRef.current?.focus()
    }
  }, [draftApp])

  const saveDraftCommand = (command: {
    name: string
    kind: 'shell' | 'keystroke'
    action: string
  }): void => {
    setDraftSaving(true)
    setDraftError(null)
    void window.electronAPI
      .userCommandsCreateForFocusedApp(command)
      .then((commandId) => {
        setDraftSaving(false)
        setDraftApp(null)
        // Land the cursor on the command that was just created: it proves
        // the save landed, and Enter runs it straight away.
        refresh({ selectItemId: `user-command:${commandId}` })
      })
      .catch((err: unknown) => {
        setDraftSaving(false)
        const message = err instanceof Error ? err.message : String(err)
        setDraftError(
          message
            .replace(/^Error invoking remote method '[^']+': Error: /, '')
            .replace(/^Error: /, '') || 'The command could not be saved.'
        )
      })
  }

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
    if (menuOpen || aliasModalOpen || resetDeckId !== null || draftApp !== null) {
      return
    }

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
    // Ctrl/Cmd+D inside window-switcher: close the highlighted window
    // without leaving the palette, so several windows can be culled in one
    // pass when too many are open. The store removes the row optimistically
    // — the OS-side close is async and a refresh would re-list the closing
    // window for a frame.
    if (
      (e.ctrlKey || e.metaKey) &&
      e.key.toLowerCase() === 'd' &&
      activeModuleId === 'window-switcher'
    ) {
      e.preventDefault()
      void closeSelected()
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
      // SRS due-filter and quiz every well-formed card). Alt+Enter on
      // an app-search row forces a fresh instance instead of focusing
      // the already-running one. For any other module a modified Enter
      // behaves like plain Enter.
      const selected = items[selectedIndex]
      const cram = e.ctrlKey && selected?.actionKind === 'start-quiz'
      const newInstance = e.altKey && selected?.actionKind === 'launch-app'
      void executeSelected(
        cram ? { cram: true } : newInstance ? { newInstance: true } : undefined
      )
      return
    }

    // Quick-launch digits: the first nine results carry 1..9 keycaps
    // (see ResultsList) and can be run by number. One chord runs the
    // matching row, the other inserts the digit into the search box;
    // `quickLaunchDigitsRequireAlt` decides which is which. Ctrl/Meta
    // are always ignored so those chord spaces stay free.
    if (!e.ctrlKey && !e.metaKey && /^[1-9]$/.test(e.key)) {
      const idx = Number(e.key) - 1
      const isRunChord = quickLaunchDigitsRequireAlt ? e.altKey : !e.altKey

      if (isRunChord) {
        if (idx < items.length) {
          e.preventDefault()
          setSelectedIndex(idx)
          void executeSelected()
          return
        }
        // No row for this number. In Alt-runs mode swallow the chord —
        // Alt+digit emits no character anyway. In plain-runs mode let
        // the digit fall through and type, so short result lists don't
        // block queries like "7zip".
        if (e.altKey) e.preventDefault()
        return
      }

      // The other chord types the digit into the search box. It's only
      // Alt+digit (plain-runs mode) that needs help — Alt chords emit no
      // character, so splice it in at the caret by hand. A plain digit
      // here (Alt-runs mode) is already typed by the input, so leave it.
      if (e.altKey) {
        e.preventDefault()
        insertTextIntoQuery(e.key)
      }
    }
  }

  // Splice text into the search query at the caret and move the caret
  // just past it. Used for the Alt+digit "type the number" chord, which
  // the input never receives as a character on its own.
  const insertTextIntoQuery = (text: string): void => {
    const input = inputRef.current
    const start = input?.selectionStart ?? query.length
    const end = input?.selectionEnd ?? query.length
    setQuery(query.slice(0, start) + text + query.slice(end))
    if (input) {
      const caret = start + text.length
      // setQuery re-renders the controlled input; restore the caret on
      // the next frame so it lands after the inserted digit rather than
      // jumping to the end of the field.
      requestAnimationFrame(() => input.setSelectionRange(caret, caret))
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
                <>
                  <FooterHint
                    label={wsCurrentDesktopOnly ? 'All desktops' : 'This desktop'}
                    keys={<Hotkey value="Tab" />}
                  />
                  <FooterHint
                    label="Close"
                    keys={<Hotkey value={IS_MAC ? 'Cmd+D' : 'Ctrl+D'} />}
                  />
                </>
              )}
              {activeModuleId === 'flashcards' &&
                items[selectedIndex]?.actionKind === 'start-quiz' && (
                  <FooterHint label="Cram" keys={<Hotkey value="Ctrl+Enter" />} />
                )}
              <FooterHint label="Dismiss" keys={<Hotkey value="Esc" />} />
            </>
          )}
        </div>

        {appVersion && activeModuleId === 'command-palette' && (
          <span
            className="px-2 text-[11px] text-muted-foreground/60 tabular-nums select-none [-webkit-app-region:no-drag]"
            title={`runwa v${appVersion}`}
          >
            v{appVersion}
          </span>
        )}
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

      <NewUserCommandModal
        open={draftApp !== null}
        appLabel={draftApp ?? ''}
        error={draftError}
        saving={draftSaving}
        onSubmit={saveDraftCommand}
        onClose={() => setDraftApp(null)}
      />

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
