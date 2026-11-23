import { Switch } from '@bedware/ui'

interface Props {
  checked: boolean
  onChange: (next: boolean) => void
  ariaLabel?: string
  /** `sm` is the 36×20 switch for rows, `md` the 44×24 one that heads a section. */
  size?: 'sm' | 'md'
  disabled?: boolean
}

/**
 * The design system's Switch with the two habits Runwa's surfaces rely on:
 * it never takes focus on a pointer press (the palette's SearchInput keeps
 * it), and its click doesn't bubble to a clickable row around it.
 */
export function Toggle({ checked, onChange, ariaLabel, size = 'sm', disabled }: Props) {
  return (
    // The span, not the Switch, stops the click: stopping it in the capture
    // phase on the Switch itself would also swallow the Switch's own onClick.
    <span className="inline-flex" onClick={(e) => e.stopPropagation()}>
      <Switch
        checked={checked}
        onChange={onChange}
        label={ariaLabel ?? ''}
        size={size}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
      />
    </span>
  )
}
