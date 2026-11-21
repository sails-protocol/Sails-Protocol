import { useState } from 'react'
import { toast } from 'sonner'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export function CopyButton({ value, label = 'Copiar', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value)
    } catch {
      toast.error('Não foi possível copiar')
      return
    }
    setCopied(true)
    toast.success('Copiado!')
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={cn("text-xs text-brand-text-secondary hover:text-brand-text border border-brand-border rounded-md px-2 py-1 transition-colors", className)}
    >
      {copied ? <><Check className="h-3.5 w-3.5 inline" aria-hidden="true" /><span className="sr-only">Copiado</span></> : label}
    </button>
  )
}
