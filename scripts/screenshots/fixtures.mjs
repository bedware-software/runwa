// Sample data for the screenshots. Mostly invented: the Windows apps,
// windows, paths, commands and the user "alex" are made up. The exception is
// App Search on macOS (MAC_APPS): real apps at their real paths, with their
// own icons converted from the bundles' .icns into icons/*.png.
import { readFileSync } from 'node:fs'

/** A flat square tile with a letter — stands in for an app's own icon. */
function tile(letter, colour) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">` +
    `<rect width="64" height="64" rx="12" fill="${colour}"/>` +
    `<text x="32" y="43" font-family="Arial, sans-serif" font-size="32" font-weight="700" ` +
    `text-anchor="middle" fill="#ffffff">${letter}</text></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

const APPS = [
  ['Atlas Notes', 'N', '#2f6fde'],
  ['Birch Terminal', 'T', '#1f2933'],
  ['Cobalt Mail', 'M', '#c2410c'],
  ['Copper Editor', 'E', '#0f766e'],
  ['Comet Browser', 'B', '#7c3aed'],
  ['Compass Maps', 'C', '#15803d'],
  ['Delta Sheets', 'S', '#16a34a'],
  ['Ember Music', 'M', '#be123c'],
  ['Fjord Calendar', 'C', '#0369a1']
]

const HOME = 'C:\\Users\\alex'

const icon = (file) =>
  `data:image/png;base64,${readFileSync(new URL(`icons/${file}.png`, import.meta.url)).toString('base64')}`

// App Search on macOS as it answers "r": the order fuzzyScore gives
// (src/main/fuzzy-match.ts — word starts first, equal scores in the order the
// enumerator walks /Applications, /System/Applications and then Finder).
// Notes does not match and drops out once the query is typed.
const MAC_APPS = [
  ['Runwa', '/Applications/Runwa.app', 'runwa'],
  ['Reminders', '/System/Applications/Reminders.app', 'reminders'],
  ['Dropbox', '/Applications/Dropbox.app', 'dropbox'],
  ['Safari', '/Applications/Safari.app', 'safari'],
  ['Telegram', '/Applications/Telegram.app', 'telegram'],
  ['Vimperium', '/Applications/Vimperium.app', 'vimperium'],
  ['Calendar', '/System/Applications/Calendar.app', 'calendar'],
  ['Notes', '/System/Applications/Notes.app', 'notes'],
  ['Terminal', '/System/Applications/Utilities/Terminal.app', 'terminal'],
  ['Finder', '/System/Library/CoreServices/Finder.app', 'finder']
]

const macAppItems = MAC_APPS.map(([name, path, file]) => ({
  id: `app:${path}`,
  moduleId: 'app-search',
  title: name,
  subtitle: path,
  iconHint: icon(file),
  revealPath: path,
  actionKind: 'launch-app',
  action: {}
}))

const appItems = APPS.map(([name, letter, colour], i) => ({
  id: `start-menu:${name}`,
  moduleId: 'app-search',
  title: name,
  subtitle: `${HOME}\\AppData\\Local\\Programs\\${name.replace(' ', '')}\\${name.split(' ')[1].toLowerCase()}.exe`,
  iconHint: tile(letter, colour),
  revealPath: `${HOME}\\AppData\\Local\\Programs\\${name.replace(' ', '')}`,
  actionKind: 'launch-app',
  action: {},
  ...(i === 3 ? { alias: 'ed' } : {}),
  ...(i === 4 ? { alias: 'br' } : {})
}))

const WINDOWS = [
  ['release-notes.md — Copper Editor', 'coppereditor.exe', 3],
  ['Inbox (4) — Cobalt Mail', 'cobaltmail.exe', 2],
  ['Quarterly plan — Delta Sheets', 'deltasheets.exe', 6],
  ['bedware.software — Comet Browser', 'cometbrowser.exe', 4],
  ['alex@workstation: ~/projects/site', 'birchterminal.exe', 1],
  ['Meeting notes — Atlas Notes', 'atlasnotes.exe', 0],
  ['Week 48 — Fjord Calendar', 'fjordcalendar.exe', 8]
]

const windowItems = WINDOWS.map(([title, exe, app], i) => ({
  id: `window:${i}`,
  moduleId: 'window-switcher',
  title,
  subtitle: exe,
  iconHint: tile(APPS[app][1], APPS[app][2]),
  actionKind: 'focus-window',
  action: {}
}))

const command = (id, title, subtitle, icon, group, extra = {}) => ({
  id: `command:${id}`,
  moduleId: 'command-palette',
  title,
  subtitle,
  iconHint: icon,
  group,
  actionKind: 'run-command',
  action: {},
  ...extra
})

// Titles, subtitles and groups as in src/main/modules/command-palette/index.ts;
// the two user commands are invented.
const commandItems = [
  command('open-settings', 'Open settings', 'Open the runwa settings window.', 'settings', 'Settings', { alias: ',' }),
  command('about', 'About runwa', 'App version, settings folder, and updates.', 'info', 'Settings'),
  command('maximize', 'Maximize window', 'Expand the focused window to fill the screen.', 'maximize-2', 'Windows Control', { alias: 'max' }),
  command('minimize', 'Minimize window', 'Hide the focused window to the taskbar / Dock.', 'minimize-2', 'Windows Control'),
  command('restore', 'Restore window', 'Undo a maximize / fullscreen / minimize.', 'square', 'Windows Control'),
  {
    id: 'user-command:build',
    moduleId: 'command-palette',
    title: 'Build the site',
    subtitle: 'npm run build',
    iconHint: 'terminal',
    group: 'User Commands',
    alias: 'b',
    actionKind: 'run-user-command',
    action: {}
  },
  {
    id: 'user-command:reformat',
    moduleId: 'command-palette',
    title: 'Reformat file',
    subtitle: 'Ctrl+Alt+L',
    iconHint: 'keyboard',
    group: 'User Commands',
    badge: 'Copper Editor',
    actionKind: 'run-user-command',
    action: {}
  },
  command('toggle-theme', 'Toggle theme', 'Switch between the light and dark system themes.', 'sun-moon', 'Themes'),
  command('themes-on-schedule', 'Themes on schedule', 'Resume automatic light and dark theme changes.', 'clock', 'Themes')
]

/** `platform: 'mac'` for a frame of the macOS build; Windows otherwise. */
export function fixtures({ version, platform = 'windows' }) {
  const mac = platform === 'mac'
  return {
    navigatorPlatform: mac ? 'MacIntel' : 'Win32',
    appInfo: {
      isPackaged: true,
      platform: mac ? 'darwin' : 'win32',
      version,
      name: 'Runwa',
      userDataPath: mac ? '/Users/alex/Library/Application Support/Runwa' : `${HOME}\\AppData\\Roaming\\Runwa`
    },
    searches: {
      'app-search': mac ? macAppItems : appItems,
      'window-switcher': windowItems,
      'command-palette': commandItems
    },
    replies: {
      getUpdateStatus: { state: 'up-to-date', currentVersion: version },
      permissionsGet: null,
      userCommandsList: [
        { id: 'build', name: 'Build the site', kind: 'shell', action: 'npm run build', appScope: '', alias: 'b' },
        { id: 'logs', name: 'Open the logs folder', kind: 'shell', action: `explorer "${HOME}\\Documents\\logs"`, appScope: '' },
        { id: 'reformat', name: 'Reformat file', kind: 'keystroke', action: 'Ctrl+Alt+L', appScope: 'coppereditor.exe', alias: 'f' },
        { id: 'zen', name: 'Zen mode', kind: 'keystroke', action: 'Ctrl+K, Z', appScope: 'coppereditor.exe' }
      ],
      userCommandsFilePath: `${HOME}\\AppData\\Roaming\\Runwa\\user-commands.json`,
      userCommandsListRunningApps: WINDOWS.map(([, exe]) => ({ name: exe })),
      windowSwitcherListIgnoreRules: [
        { id: 'r1', title: '', processName: 'widgets.exe' },
        { id: 'r2', title: 'Picture in picture', processName: 'cometbrowser.exe' }
      ],
      keyboardRemapListFullscreenBypass: ['orbitgame.exe'],
      keyboardRemapGetRules: {
        filePath: `${HOME}\\AppData\\Roaming\\Runwa\\keyboard-rules.yaml`,
        triggers: [
          { name: 'CapsLock', onTap: 'Escape', onHoldKind: 'transparent', onHoldModifier: 'Ctrl' },
          {
            name: 'Space',
            onTap: 'Space',
            onHoldKind: 'explicit',
            combos: [
              { trigger: 'Space+H', result: 'Left', description: 'Arrow keys on the home row' },
              { trigger: 'Space+J', result: 'Down' },
              { trigger: 'Space+K', result: 'Up' },
              { trigger: 'Space+L', result: 'Right' },
              { trigger: 'Space+W', result: 'Open Window Switcher', openModule: 'window-switcher' },
              { trigger: 'Space+Q', result: 'Alt+F4', description: 'Close the window', os: 'windows' }
            ]
          }
        ]
      },
      ulanziListProfiles: {
        installed: true,
        profiles: [
          { name: 'Default', app: 'default' },
          { name: 'Editor', app: 'coppereditor.exe' },
          { name: 'Browser', app: 'cometbrowser.exe' },
          { name: 'Dictation', app: null }
        ]
      },
      notificationsCliInfo: {
        commandPath: `${HOME}\\AppData\\Local\\Programs\\Runwa\\resources\\cli\\runwa-notify.cmd`,
        example: `& "${HOME}\\AppData\\Local\\Programs\\Runwa\\resources\\cli\\runwa-notify.cmd" --title "Build" --text "Finished in 74 s"`,
        inboxDir: `${HOME}\\AppData\\Roaming\\Runwa\\notify-inbox`
      },
      flashcardsGetLlmPrompt: {
        filePath: `${HOME}\\AppData\\Roaming\\Runwa\\flashcards-llm-prompt.md`,
        content: 'Write multiple-choice flashcards for the topic below.\nOne question per card, four options, one correct.'
      },
      flashcardsGetDecksFolder: {
        folder: `${HOME}\\AppData\\Roaming\\Runwa\\decks`,
        defaultFolder: `${HOME}\\AppData\\Roaming\\Runwa\\decks`,
        isDefault: true
      }
    }
  }
}

/**
 * Settings as a fresh install would have them, plus the few choices the frames
 * need. Module state comes from the real manifests: which modules start on,
 * default hotkey, default value of every config field.
 */
export function settingsFrom(manifests, { theme, lightBackground = 'white', disabled = [], config = {} }) {
  const modules = {}
  for (const m of manifests) {
    const defaults = {}
    for (const field of m.configFields ?? []) {
      if ('defaultValue' in field) defaults[field.key] = field.defaultValue
    }
    modules[m.id] = {
      enabled: disabled.includes(m.id) ? false : m.defaultEnabled,
      ...(m.defaultDirectLaunchHotkey ? { directLaunchHotkey: m.defaultDirectLaunchHotkey } : {}),
      config: { ...defaults, ...(config[m.id] ?? {}) },
      aliases: { ...(m.defaultAliases ?? {}) },
      elevated: []
    }
  }
  return {
    theme,
    lightBackground,
    quickLaunchDigitsRequireAlt: false,
    paletteSwitchToEnglish: true,
    startAtLogin: true,
    runAsAdmin: true,
    modules
  }
}
