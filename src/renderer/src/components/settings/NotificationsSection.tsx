import { useEffect, useState } from 'react'
import { Button, InputField, Label, SectionTitle } from '@bedware/ui'
import type { NotificationsCliInfo } from '@shared/notifications'
import { Check, Clipboard } from '@/lib/lucide-icons'
import { useModuleLocked } from './module-lock'

/**
 * "From the console" block of the Notifications module: where the
 * `runwa-notify` command lives and a line to paste. The command isn't put on
 * PATH — Runwa doesn't edit the user's environment — so the full path is the
 * thing to show and copy.
 */
export function NotificationsSection() {
  const [info, setInfo] = useState<NotificationsCliInfo | null>(null)
  const locked = useModuleLocked()

  useEffect(() => {
    let cancelled = false
    void window.electronAPI
      .notificationsCliInfo()
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle
        level={2}
        flush
        title="From the console"
        description={
          <>
            Any script can show a notification with the{' '}
            <span className="font-mono text-foreground">runwa-notify</span> command.{' '}
            <span className="font-mono text-foreground">--text</span> is required;{' '}
            <span className="font-mono text-foreground">--title</span>,{' '}
            <span className="font-mono text-foreground">--duration</span> (milliseconds),{' '}
            <span className="font-mono text-foreground">--tone</span> (neutral, error,
            success) and <span className="font-mono text-foreground">--source</span> are
            optional. A later notification with the same source replaces the earlier
            one.
          </>
        }
      />
      <CopyLine
        label="Example"
        description="Paste into your shell. Add the folder to PATH, or make an alias, to call it by name."
        value={info?.example ?? ''}
        locked={locked}
      />
      <CopyLine
        label="Command"
        value={info?.commandPath ?? ''}
        locked={locked}
      />
    </div>
  )
}

function CopyLine({
  label,
  description,
  value,
  locked
}: {
  label: string
  description?: string
  value: string
  locked: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {})
  }
  return (
    <div>
      <Label description={description}>{label}</Label>
      <div className="flex items-center gap-2">
        <InputField
          type="text"
          size="sm"
          mono
          readOnly
          disabled={locked}
          value={value}
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
          boxClassName="flex-1"
          className="text-xs truncate"
        />
        <Button
          onClick={copy}
          disabled={!value}
          icon={copied ? <Check size={12} /> : <Clipboard size={12} />}
          className="shrink-0"
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  )
}
