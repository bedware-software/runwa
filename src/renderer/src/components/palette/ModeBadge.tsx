import { Badge } from '@bedware/ui'

interface Props {
  name: string
}

export function ModeBadge({ name }: Props) {
  return <Badge className="shrink-0">{name}</Badge>
}
