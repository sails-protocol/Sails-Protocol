import { useState } from 'react'
import { toast } from './toast'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUiStrings } from './uiStrings'

export function CopyButton({ value, label, ariaLabel, className }: { value: string; label?: string; ariaLabel?: string; className?: string }) {
  const strings = useUiStrings()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      toast.error(strings.copyFailed)
      return
    }
    setCopied(true)
    toast.success(strings.copied)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? undefined : ariaLabel}
      className={cn("inline-flex items-center justify-center rounded-md bg-brand-tonal px-2 py-1 text-xs font-medium text-brand-text state-layer", className)}
    >
      {copied ? <><Check className="size-icon-sm" aria-hidden="true" /><span className="sr-only">{strings.copied}</span></> : label ?? strings.copy}
    </button>
  )
}
