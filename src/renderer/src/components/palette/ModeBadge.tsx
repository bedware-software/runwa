interface Props {
  name: string
}

export function ModeBadge({ name }: Props) {
  return (
    <span className="px-2 h-7 flex items-center rounded-md bg-accent text-accent-foreground text-xs font-medium shrink-0">
      {name}
    </span>
  )
}
