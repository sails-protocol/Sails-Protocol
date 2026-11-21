import { useState } from 'react'
import { toast } from './toast'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUiStrings } from './uiStrings'

export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
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
      className={cn("text-xs text-brand-text-secondary hover:text-brand-text border border-brand-border rounded-md px-2 py-1 transition-colors", className)}
    >
      {copied ? <><Check className="h-3.5 w-3.5 inline" aria-hidden="true" /><span className="sr-only">{strings.copied}</span></> : label ?? strings.copy}
    </button>
  )
}
