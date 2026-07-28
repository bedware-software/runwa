import { isLocalTime } from '@shared/auto-dark-mode'

export type ScheduledTheme = 'light' | 'dark'

export interface ThemeBoundary {
  at: Date
  theme: ScheduledTheme
}

interface OrderedThemeBoundary extends ThemeBoundary {
  /** Nominal HH:mm order, used when a DST gap collapses two times together. */
  wallMinutes: number
}

const ONE_MINUTE_MS = 60 * 1000

function minutesSinceMidnight(time: string): number {
  if (!isLocalTime(time)) {
    throw new Error(`Invalid local theme time: ${JSON.stringify(time)}`)
  }
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

/**
 * Resolve the schedule segment containing `now` from the most recent actual
 * boundary instant.
 *
 * This is deliberately instant-based rather than comparing only wall-clock
 * minutes. On a spring DST gap, a nonexistent time fires at the first valid
 * local minute after the gap. On a repeated fall hour, the first occurrence
 * is authoritative and the theme does not roll back when the clock repeats.
 */
export function scheduledThemeAt(
  now: Date,
  lightTime: string,
  darkTime: string
): ScheduledTheme {
  if (lightTime === darkTime) {
    throw new Error('Light and dark theme times must be different.')
  }

  const candidates: OrderedThemeBoundary[] = []
  const lightWallMinutes = minutesSinceMidnight(lightTime)
  const darkWallMinutes = minutesSinceMidnight(darkTime)
  // Looking back two local dates also covers the rare case where a timezone
  // change skips an entire calendar date.
  for (const dayOffset of [-2, -1, 0]) {
    candidates.push(
      {
        at: boundaryOnLocalDate(now, dayOffset, lightTime),
        theme: 'light',
        wallMinutes: lightWallMinutes
      },
      {
        at: boundaryOnLocalDate(now, dayOffset, darkTime),
        theme: 'dark',
        wallMinutes: darkWallMinutes
      }
    )
  }

  const nowMs = now.getTime()
  const latest = candidates
    .filter((candidate) => candidate.at.getTime() <= nowMs)
    .sort(
      (a, b) =>
        b.at.getTime() - a.at.getTime() || b.wallMinutes - a.wallMinutes
    )[0]
  if (!latest) {
    throw new Error('Could not resolve the current local theme interval.')
  }
  return latest.theme
}

/**
 * Find the next local-time transition after `now`, using the same DST gap /
 * fold policy as `scheduledThemeAt`.
 */
export function nextThemeBoundary(
  now: Date,
  lightTime: string,
  darkTime: string
): ThemeBoundary {
  if (lightTime === darkTime) {
    throw new Error('Light and dark theme times must be different.')
  }

  const candidates: OrderedThemeBoundary[] = []
  const lightWallMinutes = minutesSinceMidnight(lightTime)
  const darkWallMinutes = minutesSinceMidnight(darkTime)
  for (const dayOffset of [0, 1, 2]) {
    candidates.push(
      {
        at: boundaryOnLocalDate(now, dayOffset, lightTime),
        theme: 'light',
        wallMinutes: lightWallMinutes
      },
      {
        at: boundaryOnLocalDate(now, dayOffset, darkTime),
        theme: 'dark',
        wallMinutes: darkWallMinutes
      }
    )
  }
  const nowMs = now.getTime()
  const future = candidates.filter(
    (candidate) => candidate.at.getTime() > nowMs
  )
  if (future.length === 0) {
    throw new Error('Could not resolve the next local theme boundary.')
  }
  future.sort(
    (a, b) =>
      a.at.getTime() - b.at.getTime() || b.wallMinutes - a.wallMinutes
  )
  const next = future[0]
  return { at: next.at, theme: next.theme }
}

/**
 * Return the first real instant on a local calendar date whose displayed
 * HH:mm is at or after `time`.
 *
 * Walking real instants one minute at a time gives explicit, portable DST
 * semantics with the built-in Date API:
 *  - a missing 02:30 resolves to 03:00 (the first valid minute after the gap)
 *  - a repeated 01:30 resolves to its first occurrence
 */
function boundaryOnLocalDate(
  reference: Date,
  dayOffset: number,
  time: string
): Date {
  const targetMinutes = minutesSinceMidnight(time)
  const day = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate() + dayOffset,
    0,
    0,
    0,
    0
  )
  const year = day.getFullYear()
  const month = day.getMonth()
  const date = day.getDate()
  const nextDay = new Date(year, month, date + 1, 0, 0, 0, 0)

  for (
    let instant = day.getTime();
    instant < nextDay.getTime();
    instant += ONE_MINUTE_MS
  ) {
    const candidate = new Date(instant)
    if (
      candidate.getFullYear() !== year ||
      candidate.getMonth() !== month ||
      candidate.getDate() !== date
    ) {
      continue
    }
    const wallMinutes = candidate.getHours() * 60 + candidate.getMinutes()
    if (wallMinutes >= targetMinutes) return candidate
  }

  // A timezone can exceptionally skip an entire local date. Treat the start
  // of the next representable date as the first valid instant after it.
  return nextDay
}
