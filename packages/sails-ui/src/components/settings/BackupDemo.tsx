/**
 * Layer C, demo only: "Exportar backup" / "Importar backup" (Frente B identidade, Principal spec 2026-11-23; CTO R1 GO).
 * Screens ready for the SDK's future R0; nothing here is real. No key material is read, generated, stored or
 * downloaded: the passphrases live only in this component's state and are dropped when the dialog closes, and the
 * import reads only the picked file's name. Real mode never renders this file (the rows show "Em breve").
 */
import { useId, useRef, useState, type FormEvent } from 'react'
import { CheckCircle2, FileUp, KeyRound } from 'lucide-react'
import { SettingsRow } from './SettingsRow'
import { SimulatedBadge } from '../ui/SimulatedBadge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { LOOSE_WIRES } from '../../lib/looseWires'
import { t } from '../../i18n'

// shortcut: a demo-only floor so the form has a real validation state; R0 sets the actual passphrase rule.
const MIN_PASSPHRASE = 8

function Done({ text }: { text: string }) {
  return (
    <p role="status" className="flex items-start gap-2 rounded-lg bg-brand-elevated px-3 py-2 text-body-sm text-brand-text">
      <CheckCircle2 aria-hidden="true" className="mt-0.5 size-icon-sm shrink-0 text-brand-info" />{text}
    </p>
  )
}

function BackupDialog({ kind, open, onOpenChange }: { kind: 'export' | 'import'; open: boolean; onOpenChange: (open: boolean) => void }) {
  const id = useId()
  const fileRef = useRef<HTMLInputElement>(null)
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const close = (next: boolean) => {
    if (!next) { setPass(''); setConfirm(''); setFileName(null); setError(null); setDone(false) }
    onOpenChange(next)
  }
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const err = kind === 'import' && !fileName ? t('settings.backup.errorFile')
      : pass.length < MIN_PASSPHRASE ? t('settings.backup.errorShort', { count: MIN_PASSPHRASE })
      : kind === 'export' && pass !== confirm ? t('settings.backup.errorMatch')
      : null
    setError(err)
    if (err) return
    // Demo: nothing is derived, encrypted, written or read; the passphrases are dropped right away.
    setPass(''); setConfirm('')
    setDone(true)
  }
  const errorId = `${id}-error`
  const title = kind === 'export' ? t('settings.backup.exportTitle') : t('settings.backup.importTitle')
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto">
        <DialogHeader className="pr-10 text-left">
          <DialogTitle className="flex flex-wrap items-center gap-2">{title}<SimulatedBadge label={t('spaces.simulated')} /></DialogTitle>
          <DialogDescription>{kind === 'export' ? t('settings.backup.exportWhat') : t('settings.backup.importWhat')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-body-sm text-brand-text-secondary">
          <p>{t('settings.backup.restoreNeedsBoth')}</p>
          {kind === 'export' && <p>{t('settings.backup.snapshot')}</p>}
        </div>
        {done ? (
          <div className="space-y-2">
            {kind === 'import' && <Done text={t('settings.backup.importKeyMatches')} />}
            <Done text={kind === 'export' ? t('settings.backup.exportDone') : t('settings.backup.importDone')} />
            <div className="flex justify-end">
              <Button type="button" variant="secondary" onClick={() => close(false)} className="touch:min-h-11">{t('settings.backup.close')}</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="space-y-3">
            {kind === 'import' && (
              <div>
                <span id={`${id}-file-label`} className="text-control text-brand-text">{t('settings.backup.fileLabel')}</span>
                <input
                  ref={fileRef} id={`${id}-file`} type="file" accept=".sailsbackup,.json" className="sr-only" tabIndex={-1} aria-hidden="true"
                  // Only the name: the demo never opens the file.
                  onChange={(e) => { setFileName(e.target.files?.[0]?.name ?? null); setError(null); e.target.value = '' }}
                />
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="secondary" onClick={() => fileRef.current?.click()} aria-labelledby={`${id}-file-label ${id}-file-name`} className="touch:min-h-11">
                    <FileUp aria-hidden="true" />{t('settings.backup.fileChoose')}
                  </Button>
                  <span id={`${id}-file-name`} className="min-w-0 break-all text-caption text-brand-text-secondary">{fileName ?? t('settings.backup.fileNone')}</span>
                </div>
              </div>
            )}
            <div>
              <label htmlFor={`${id}-pass`} className="text-control text-brand-text">{kind === 'export' ? t('settings.backup.newPassphrase') : t('settings.backup.passphrase')}</label>
              <Input
                id={`${id}-pass`} type="password" name="backup-passphrase" autoComplete={kind === 'export' ? 'new-password' : 'off'} value={pass}
                onChange={(e) => { setPass(e.target.value); setError(null) }} aria-invalid={!!error || undefined} aria-describedby={error ? errorId : undefined} className="mt-1"
              />
            </div>
            {kind === 'export' && (
              <div>
                <label htmlFor={`${id}-confirm`} className="text-control text-brand-text">{t('settings.backup.confirmPassphrase')}</label>
                <Input
                  id={`${id}-confirm`} type="password" name="backup-passphrase-confirm" autoComplete="new-password" value={confirm}
                  onChange={(e) => { setConfirm(e.target.value); setError(null) }} aria-invalid={!!error || undefined} aria-describedby={error ? errorId : undefined} className="mt-1"
                />
              </div>
            )}
            {kind === 'export' && <p className="text-body-sm font-medium text-brand-text">{t('settings.backup.keepApart')}</p>}
            {error && <p id={errorId} role="alert" className="text-caption text-brand-danger-fg">{error}</p>}
            <div className="flex justify-end">
              <Button type="submit" variant="secondary" className="touch:min-h-11">{kind === 'export' ? t('settings.backup.exportAction') : t('settings.backup.importAction')}</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The demo row that opens one of the two dialogs. */
export function BackupDemoRow({ kind }: { kind: 'export' | 'import' }) {
  const [open, setOpen] = useState(false)
  const wire = LOOSE_WIRES[kind === 'export' ? 'keyBackupExport' : 'keyBackupImport']
  return (
    <>
      <SettingsRow icon={wire.icon} label={wire.label} description={<SimulatedBadge label={t('spaces.simulated')} />} onClick={() => setOpen(true)} />
      <BackupDialog kind={kind} open={open} onOpenChange={setOpen} />
    </>
  )
}

// Demo: the first-escrow prompt is offered once per page load (nothing is stored).
let escrowPromptDone = false

/**
 * "Crie o backup das chaves deste escrow" (CTO 29): R0 is asked only when an escrow is open, once, and opens the same
 * demo export dialog. Separate from the portable identity and the social record.
 */
export function EscrowBackupPrompt() {
  const [hidden, setHidden] = useState(escrowPromptDone)
  const [open, setOpen] = useState(false)
  const dismiss = () => { escrowPromptDone = true; setHidden(true) }
  if (hidden && !open) return null
  return (
    <>
      {!hidden && (
        <section aria-labelledby="escrow-backup-prompt" className="space-y-2 rounded-lg bg-brand-elevated p-4">
          <h2 id="escrow-backup-prompt" className="flex flex-wrap items-center gap-2 text-sm font-medium text-brand-text">
            <KeyRound aria-hidden="true" className="size-icon-sm shrink-0 text-brand-text-secondary" />{t('identity.escrowBackup.title')}<SimulatedBadge label={t('spaces.simulated')} />
          </h2>
          <p className="text-body-sm text-brand-text-secondary">{t('identity.escrowBackup.text')}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => { dismiss(); setOpen(true) }} className="touch:min-h-11">{t('identity.escrowBackup.action')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={dismiss} className="touch:min-h-11">{t('identity.escrowBackup.later')}</Button>
          </div>
        </section>
      )}
      <BackupDialog kind="export" open={open} onOpenChange={setOpen} />
    </>
  )
}
