/**
 * Layer A: "Adicionar nó manualmente" form: the node's address or identifier, an optional local name, connection and
 * privacy notes, and the operator's responsibility. It never parses or validates the identifier's format (formats are
 * pending the Principal), never asks for a node profile and never ties a node to a market or its visibility.
 * `submitAvailable` false = the action is shown disabled with `unavailableNote` explaining why. Copy from props.
 */
import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { Alert } from '../ui/alert'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

export interface AddNodeCopy {
  address: string
  addressHelp: string
  addressPlaceholder: string
  name: string
  nameOptional: string
  nameHelp: string
  connectionTitle: string
  connection: string[]
  privacy: string
  responsibility: string
  submit: string
  cancel: string
}

export function AddNodeForm({ copy, submitAvailable, unavailableNote, onSubmit, onCancel }: {
  copy: AddNodeCopy
  submitAvailable: boolean
  /** Why the action is not available yet (rendered under the actions and linked to the button). */
  unavailableNote?: ReactNode
  onSubmit?: (value: { address: string; name: string }) => void
  onCancel: () => void
}) {
  const id = useId()
  const [address, setAddress] = useState('')
  const [name, setName] = useState('')
  const canSubmit = submitAvailable && address.trim().length > 0

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (canSubmit) onSubmit?.({ address: address.trim(), name: name.trim() })
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor={`${id}-address`} className="text-sm font-medium text-brand-text">{copy.address}</label>
        <Input
          id={`${id}-address`}
          name="node-address"
          className="mt-1"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={copy.addressPlaceholder}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${id}-address-help`}
        />
        <p id={`${id}-address-help`} className="mt-1 text-caption text-brand-text-muted">{copy.addressHelp}</p>
      </div>

      <div>
        <label htmlFor={`${id}-name`} className="text-sm font-medium text-brand-text">
          {copy.name} <span className="font-normal text-brand-text-secondary">{copy.nameOptional}</span>
        </label>
        <Input id={`${id}-name`} name="node-local-name" className="mt-1" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" aria-describedby={`${id}-name-help`} />
        <p id={`${id}-name-help`} className="mt-1 text-caption text-brand-text-muted">{copy.nameHelp}</p>
      </div>

      <Alert tone="info" size="sm" title={copy.connectionTitle}>
        <ul className="list-disc space-y-0.5 pl-4">
          {copy.connection.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </Alert>
      <Alert tone="warning" size="sm">{copy.privacy}</Alert>
      <p className="text-caption text-brand-text-muted">{copy.responsibility}</p>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onCancel} className="touch:min-h-11">{copy.cancel}</Button>
        <Button type="submit" disabled={!canSubmit} aria-describedby={!submitAvailable && unavailableNote ? `${id}-unavailable` : undefined} className="touch:min-h-11">
          {copy.submit}
        </Button>
      </div>
      {!submitAvailable && unavailableNote && <div id={`${id}-unavailable`}>{unavailableNote}</div>}
    </form>
  )
}
