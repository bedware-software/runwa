export const AUTO_DARK_MODE_ID = 'auto-dark-mode'

export const AUTO_DARK_MODE_MODE_KEY = 'mode'
export const AUTO_DARK_MODE_LIGHT_TIME_KEY = 'lightTime'
export const AUTO_DARK_MODE_DARK_TIME_KEY = 'darkTime'

export type AutoDarkModeMode = 'scheduled' | 'manual'

export interface AutoDarkModeConfig {
  mode: AutoDarkModeMode
  lightTime: string
  darkTime: string
}

export const DEFAULT_AUTO_DARK_MODE_CONFIG: Readonly<AutoDarkModeConfig> = {
  // A new install must not change the user's OS appearance without an
  // explicit choice. The palette's Toggle Theme command still works in
  // manual mode; selecting Scheduled opts into the automatic transitions.
  mode: 'manual',
  lightTime: '07:00',
  darkTime: '19:00'
}

export interface AutoDarkModeConfigResult {
  config: AutoDarkModeConfig
  error?: string
}

const LOCAL_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

export function isLocalTime(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_TIME_RE.test(value)
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
  values: Record<string, unknown> | undefined
): AutoDarkModeConfigResult {
  const rawMode = values?.[AUTO_DARK_MODE_MODE_KEY]
  const mode: AutoDarkModeMode =
    rawMode === 'scheduled' || rawMode === 'manual'
      ? rawMode
      : DEFAULT_AUTO_DARK_MODE_CONFIG.mode

  const rawLightTime = values?.[AUTO_DARK_MODE_LIGHT_TIME_KEY]
  const rawDarkTime = values?.[AUTO_DARK_MODE_DARK_TIME_KEY]
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

  const config: AutoDarkModeConfig = { mode, lightTime, darkTime }

  if (rawMode !== undefined && rawMode !== 'scheduled' && rawMode !== 'manual') {
    return { config, error: 'Mode must be Scheduled or Manual.' }
  }
  if (!isLocalTime(lightTime) || !isLocalTime(darkTime)) {
    return { config, error: 'Theme times must use the 24-hour HH:mm format.' }
  }
  if (lightTime === darkTime) {
    return { config, error: 'Light and dark theme times must be different.' }
  }

  return { config }
}
