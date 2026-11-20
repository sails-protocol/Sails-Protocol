/**
 * Layer A: the buyer registers their own payout address (the host calls
 * setPayoutAddress). Labelled input + submit; the server validates.
 */
import { useId } from 'react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'

interface Props {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  saving: boolean
  hasAddress: boolean
  assetLabel: string
}

export function PayoutAddressForm({ value, onChange, onSubmit, saving, hasAddress, assetLabel }: Props) {
  const id = useId()
  return (
    <form className="mt-2" onSubmit={(e) => { e.preventDefault(); onSubmit() }}>
      <label htmlFor={id} className="text-xs font-medium text-brand-text-secondary">
        {hasAddress ? 'Novo endereço' : 'Seu endereço'} — {assetLabel}
      </label>
      <div className="mt-1 flex flex-col gap-2 sm:flex-row">
        <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off" spellCheck={false} className="min-h-11 font-mono text-field" />
        <Button type="submit" variant="outline" loading={saving} disabled={!value.trim()} className="min-h-11 shrink-0 text-sm">
          {saving ? 'Salvando…' : hasAddress ? 'Atualizar' : 'Cadastrar endereço'}
        </Button>
      </div>
    </form>
  )
}
