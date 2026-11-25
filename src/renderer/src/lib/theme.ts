import { DEFAULT_SETTINGS, type LightBackground, type Settings, type Theme } from '@shared/types'

/**
 * Puts the theme on <html>: `data-theme`, and for a light theme with a
 * background other than white the design system's `data-theme-variant`
 * (light-paper, light-soft, light-steel, light-stone).
 *
 * The variant's colours apply wherever the attribute is, whatever the theme,
 * so it is only set while the theme on screen is light: with `system`, that
 * means while the OS is light — and it is put on or taken off as the OS
 * changes.
 */

const osLight = window.matchMedia('(prefers-color-scheme: light)')

let current: { theme: Theme; lightBackground: LightBackground } = {
  theme: 'system',
  lightBackground: DEFAULT_SETTINGS.lightBackground
}

function render(): void {
  const root = document.documentElement
  root.setAttribute('data-theme', current.theme)
  const light = current.theme === 'light' || (current.theme === 'system' && osLight.matches)
  if (light && current.lightBackground !== 'white') {
    root.setAttribute('data-theme-variant', `light-${current.lightBackground}`)
  } else {
    root.removeAttribute('data-theme-variant')
  }
}

osLight.addEventListener('change', render)

export function applyTheme(theme: Theme, lightBackground: LightBackground): void {
  current = { theme, lightBackground }
  render()
}

/** The same from a settings object; `theme` overrides the stored one. */
export function applyThemeFromSettings(settings: Settings, theme: Theme = settings.theme): void {
  applyTheme(theme, settings.lightBackground ?? DEFAULT_SETTINGS.lightBackground)
}
