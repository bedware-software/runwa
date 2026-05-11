import { cn } from '@/lib/utils'

interface Props {
  checked: boolean
  onChange: (next: boolean) => void
  /** Optional click target larger than the slider itself (e.g. a row).
   *  When `onChange` is invoked from the label/wrapper we want to stop
   *  propagation so click-throughs to focus-stealing parents don't fire. */
  ariaLabel?: string
  /** Pixel-size variant. `sm` matches the sidebar toggle (w-7 h-4),
   *  `md` (default here) is a touch larger and reads as interactive when
   *  it lives standalone in a toolbar. */
  size?: 'sm' | 'md'
}

/**
 * Generic on/off slider, visually matching the one in the settings
 * sidebar. Use this anywhere a button-with-changing-label would
 * misread as "the button label IS the action" — a toggle is "the
 * state is the label, the slider is the verb".
 */
export function Toggle({ checked, onChange, ariaLabel, size = 'md' }: Props) {
  const dims =
    size === 'sm'
      ? { track: 'w-7 h-4', thumb: 'w-3 h-3 top-0.5', on: 'translate-x-[14px]', off: 'translate-x-0.5' }
      : { track: 'w-8 h-[18px]', thumb: 'w-3.5 h-3.5 top-[2px]', on: 'translate-x-[16px]', off: 'translate-x-[2px]' }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onMouseDown={(e) => {
        // The palette's SearchInput steals focus on most pointer
        // interactions; if a wrapper of this Toggle relies on its
        // own focus, this preventDefault is the caller's escape
        // hatch. Inline so callers don't need to remember it.
        e.preventDefault()
      }}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={cn(
        dims.track,
        'rounded-full transition-colors relative shrink-0 cursor-pointer',
        checked ? 'bg-primary' : 'bg-muted'
      )}
    >
      <div
        className={cn(
          dims.thumb,
          'rounded-full bg-background absolute transition-transform',
          checked ? dims.on : dims.off
        )}
      />
    </button>
  )
}
