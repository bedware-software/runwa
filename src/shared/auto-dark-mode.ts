export const AUTO_DARK_MODE_ID = 'auto-dark-mode'

export const AUTO_DARK_MODE_MODE_KEY = 'mode'
export const AUTO_DARK_MODE_LIGHT_TIME_KEY = 'lightTime'
export const AUTO_DARK_MODE_DARK_TIME_KEY = 'darkTime'
export const AUTO_DARK_MODE_MANAGE_WINDOWS_BACKGROUND_KEY =
  'manageWindowsBackground'
export const AUTO_DARK_MODE_LIGHT_BACKGROUND_COLOR_KEY =
  'lightBackgroundColor'
export const AUTO_DARK_MODE_DARK_BACKGROUND_COLOR_KEY = 'darkBackgroundColor'

export type AutoDarkModeMode = 'scheduled' | 'manual'

export interface AutoDarkModeConfig {
  mode: AutoDarkModeMode
  lightTime: string
  darkTime: string
  manageWindowsBackground: boolean
  lightBackgroundColor: string
  darkBackgroundColor: string
}

export const DEFAULT_AUTO_DARK_MODE_CONFIG: Readonly<AutoDarkModeConfig> = {
  // A new install must not change the user's OS appearance without an
  // explicit choice. The palette's Toggle Theme command still works in
  // manual mode; selecting Scheduled opts into the automatic transitions.
  mode: 'manual',
  lightTime: '07:00',
  darkTime: '19:00',
  // Opt-in so an upgrade never hides an existing picture or slideshow.
  manageWindowsBackground: false,
  lightBackgroundColor: '#FFFFFF',
  darkBackgroundColor: '#000000'
}

export interface AutoDarkModeConfigResult {
  config: AutoDarkModeConfig
  /** Schedule/mode error. The scheduler pauses until this is fixed. */
  error?: string
  /** Windows-only background error. Theme switching can continue safely. */
  backgroundColorError?: string
}

const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

export function isLocalTime(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_TIME_RE.test(value)
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR_RE.test(value)
}

interface ReadAutoDarkModeConfigOptions {
  /**
   * Background colors are a Windows-only feature. Keeping validation opt-in
   * prevents malformed synced Windows values from affecting macOS.
   */
  validateWindowsBackground?: boolean
}

/**
 * Read the opaque module config bag at the main/renderer boundary.
 *
 * Missing values use defaults so upgrading an existing install is safe.
 * Malformed hand-edited values are reported instead of silently choosing a
 * different schedule. The returned config remains displayable, while the
 * scheduler pauses until the values are fixed.
 */
export function readAutoDarkModeConfig(
  values: Record<string, unknown> | undefined,
  options: ReadAutoDarkModeConfigOptions = {}
): AutoDarkModeConfigResult {
  const rawMode = values?.[AUTO_DARK_MODE_MODE_KEY]
  const mode: AutoDarkModeMode =
    rawMode === 'scheduled' || rawMode === 'manual'
      ? rawMode
      : DEFAULT_AUTO_DARK_MODE_CONFIG.mode

  const rawLightTime = values?.[AUTO_DARK_MODE_LIGHT_TIME_KEY]
  const rawDarkTime = values?.[AUTO_DARK_MODE_DARK_TIME_KEY]
  const rawManageWindowsBackground =
    values?.[AUTO_DARK_MODE_MANAGE_WINDOWS_BACKGROUND_KEY]
  const rawLightBackgroundColor =
    values?.[AUTO_DARK_MODE_LIGHT_BACKGROUND_COLOR_KEY]
  const rawDarkBackgroundColor =
    values?.[AUTO_DARK_MODE_DARK_BACKGROUND_COLOR_KEY]
  const lightTime =
    rawLightTime === undefined
      ? DEFAULT_AUTO_DARK_MODE_CONFIG.lightTime
      : typeof rawLightTime === 'string'
        ? rawLightTime
        : ''
  const darkTime =
    rawDarkTime === undefined
      ? DEFAULT_AUTO_DARK_MODE_CONFIG.darkTime
      : typeof rawDarkTime === 'string'
        ? rawDarkTime
        : ''

  const manageWindowsBackground =
    rawManageWindowsBackground === undefined
      ? DEFAULT_AUTO_DARK_MODE_CONFIG.manageWindowsBackground
      : rawManageWindowsBackground === true
  const lightBackgroundColor =
    rawLightBackgroundColor === undefined
      ? DEFAULT_AUTO_DARK_MODE_CONFIG.lightBackgroundColor
      : typeof rawLightBackgroundColor === 'string'
        ? rawLightBackgroundColor.toUpperCase()
        : ''
  const darkBackgroundColor =
    rawDarkBackgroundColor === undefined
      ? DEFAULT_AUTO_DARK_MODE_CONFIG.darkBackgroundColor
      : typeof rawDarkBackgroundColor === 'string'
        ? rawDarkBackgroundColor.toUpperCase()
        : ''

  const config: AutoDarkModeConfig = {
    mode,
    lightTime,
    darkTime,
    manageWindowsBackground,
    lightBackgroundColor,
    darkBackgroundColor
  }

  if (rawMode !== undefined && rawMode !== 'scheduled' && rawMode !== 'manual') {
    return { config, error: 'Mode must be Scheduled or Manual.' }
  }
  if (!isLocalTime(lightTime) || !isLocalTime(darkTime)) {
    return { config, error: 'Theme times must use the 24-hour HH:mm format.' }
  }
  if (lightTime === darkTime) {
    return { config, error: 'Light and dark theme times must be different.' }
  }

  if (
    options.validateWindowsBackground &&
    rawManageWindowsBackground !== undefined &&
    typeof rawManageWindowsBackground !== 'boolean'
  ) {
    return {
      config,
      backgroundColorError:
        'Desktop background management must be turned on or off.'
    }
  }
  if (
    options.validateWindowsBackground &&
    manageWindowsBackground &&
    (!isHexColor(lightBackgroundColor) || !isHexColor(darkBackgroundColor))
  ) {
    return {
      config,
      backgroundColorError:
        'Desktop background colors must use the #RRGGBB format.'
    }
  }

  return { config }
}
