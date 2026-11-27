import { useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from '../components/ui/toast'
import { useAuth, hasStoredIdentity, WrongPassphraseError } from '../context/AuthContext'
import { InfoTooltip } from '../components/ui/InfoTooltip'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { SafetyNote } from '../components/ui/SafetyNote'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { ArrowLeft, ChevronRight, KeyRound, Link2, RotateCcw, ShieldCheck, Wallet, type LucideIcon } from 'lucide-react'
import { ActivationFlow, RecoveryFlow } from '../components/settings/PortableIdentityDemo'
import { isDemoMode } from '../lib/demoMarkers'
import { markOnboardingSeen } from '../lib/onboarding'
import { t } from '../i18n'

// Routes a visitor can see without a session. Cancelling the dialog returns
// there; returning to a protected route would bounce straight back here.
const isPublicPath = (path: string) => path === '/' || path.startsWith('/offer/')

// Demo: offer the activation sheet once per page load, on the first sign-in with a new key.
let activationOffered = false

/**
 * "Conectar wallet" dialog, rendered at /login over the Market (App.tsx).
 * Follows the common DeFi pattern (e.g. Hyperliquid): a uniform list of
 * connection options; picking one opens its own step with a back button.
 * Every existing `navigate('/login', { state: { from, amount } })` caller
 * keeps working: success returns to `from` carrying `amount`.
 *
 * Satsails Wallet and WalletConnect are listed but not wired (no connector
 * exists in this repo yet): disabled and labelled "Em breve" instead of
 * simulating a connected session. The local browser key is the only real
 * method today.
 */
export function Login() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as { from?: string; amount?: number } | null
  // 'recover' and 'activate' are the CTO 29 portable identity flows, demo only (components/settings/PortableIdentityDemo.tsx).
  const [step, setStep] = useState<'list' | 'local' | 'recover' | 'activate'>('list')
  const demo = isDemoMode()
  const { signInDemo } = useAuth()
  const finish = () => navigate(state?.from ?? '/', { replace: true, state: state?.amount ? { amount: state.amount } : undefined })

  const close = () => {
    const from = state?.from
    navigate(from && isPublicPath(from) ? from : '/', { replace: true })
  }

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && close()}>
      {/* Below md a full-height sheet (content from the top); a centered dialog from md that scrolls when taller than the window (recovery result). */}
      <DialogContent className="max-w-sm md:max-h-[calc(100dvh-2rem)] md:overflow-y-auto max-md:inset-0 max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:content-start max-md:overflow-y-auto max-md:border-0">
        {step === 'list' ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('auth.login.title')}</DialogTitle>
              <DialogDescription>{state?.from && state.from !== '/' ? t('auth.login.continue') : t('auth.login.description')}</DialogDescription>
            </DialogHeader>
            <ul className="mt-2 space-y-2">
              <Option icon={Wallet} title="Satsails Wallet" trailing={t('common.soon')} />
              <Option icon={Link2} title="WalletConnect" trailing={t('common.soon')} />
              <Option
                icon={KeyRound}
                title={t('auth.login.localKey')}
                subtitle={t('auth.login.localKeySubtitle')}
                onSelect={() => setStep('local')}
              />
              {/* Real mode: no portable identity exists yet, so the option is listed as "Em breve". */}
              <Option
                icon={RotateCcw}
                title={t('identity.login.recoverOption')}
                subtitle={t('identity.login.recoverSubtitle')}
                trailing={demo ? undefined : t('common.soon')}
                onSelect={demo ? () => setStep('recover') : undefined}
              />
            </ul>
            <p className="mt-4 text-center text-xs text-brand-text-muted">{t('auth.login.noWallet')}</p>
          </>
        ) : step === 'recover' ? (
          // Demo: the recovered identity signs in as is (no new key, no activation sheet: the portable identity is already there).
          <RecoveryFlow
            onExit={() => setStep('list')}
            onDone={() => signInDemo().then(() => { markOnboardingSeen(); toast.success(t('auth.local.connected')); finish() }, () => toast.error(t('auth.local.connectFailed')))}
            doneLabel={t('identity.result.signIn')}
          />
        ) : step === 'activate' ? (
          <ActivationFlow onDone={finish} />
        ) : (
          <LocalKeyStep
            onBack={() => setStep('list')}
            // Demo, first sign-in with a new key: "Ativar o Sails P2P" before returning.
            onConnected={(isNew) => {
              // The activation sheet replaces the onboarding tour for this sign-in (never both in a row).
              if (demo && isNew && !activationOffered) { activationOffered = true; markOnboardingSeen(); setStep('activate') } else finish()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Option({ icon: Icon, title, subtitle, trailing, onSelect }: {
  icon: LucideIcon
  title: string
  subtitle?: string
  trailing?: ReactNode
  onSelect?: () => void
}) {
  const disabled = !onSelect
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className="w-full min-h-14 flex items-center gap-3 rounded-lg bg-brand-tonal px-3 py-2.5 text-left transition-colors state-layer disabled:cursor-not-allowed disabled:bg-brand-disabled-container"
      >
        <span className="w-9 h-9 rounded-lg bg-brand-elevated flex items-center justify-center shrink-0">
          <Icon className={`h-4 w-4 ${disabled ? 'text-brand-disabled-content' : 'text-brand-text-secondary'}`} />
        </span>
        <span className="flex-1 min-w-0">
          {/* Disabled tokens (DESIGN_SYSTEM.md 5.2), not opacity; the trailing "Em breve" label stays legible. */}
          <span className={`block text-sm font-medium ${disabled ? 'text-brand-disabled-content' : 'text-brand-text'}`}>{title}</span>
          {subtitle && <span className={`block text-xs ${disabled ? 'text-brand-disabled-content' : 'text-brand-text-muted'}`}>{subtitle}</span>}
        </span>
        {trailing ? (
          <span className="text-xs font-medium text-brand-text-muted shrink-0">{trailing}</span>
        ) : (
          <ChevronRight className="h-4 w-4 text-brand-text-muted shrink-0" />
        )}
      </button>
    </li>
  )
}

function LocalKeyStep({ onBack, onConnected }: { onBack: () => void; onConnected: (isNew: boolean) => void }) {
  const { login } = useAuth()
  const [connecting, setConnecting] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  // An existing encrypted keypair decides the copy ("crie" vs "digite").
  const [isReturning] = useState(() => hasStoredIdentity())
  // New key only: a typo here would lock the key away for good.
  const [confirmation, setConfirmation] = useState('')
  const mismatch = !isReturning && confirmation !== '' && confirmation !== passphrase
  const canConnect = !!passphrase && (isReturning || confirmation === passphrase)

  const handleConnect = async () => {
    if (!passphrase) {
      toast.error(isReturning ? t('auth.local.enterPassphrase') : t('auth.local.createToProtect'))
      return
    }
    if (!canConnect) return
    setConnecting(true)
    try {
      // Real Ed25519 challenge-response (packages/sails-sdk/src/modules/identity.ts).
      // `passphrase` never reaches the SDK/backend — AuthContext uses it only
      // locally, to derive the AES key that encrypts the stored keypair.
      await login(passphrase)
      toast.success(t('auth.local.connected'))
      onConnected(!isReturning)
    } catch (err) {
      toast.error(err instanceof WrongPassphraseError || err instanceof Error ? err.message : t('auth.local.connectFailed'))
    } finally {
      setConnecting(false)
    }
  }

  return (
    <>
      <DialogHeader>
        <button
          type="button"
          onClick={onBack}
          aria-label={t('auth.local.back')}
          className="-ml-1 mb-1 h-8 w-8 touch:h-11 touch:w-11 flex items-center justify-center rounded-md text-brand-text-secondary hover:text-brand-text state-layer"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <DialogTitle className="flex items-center gap-1.5">
          {t('auth.login.localKey')}
          <InfoTooltip text={t('auth.local.info')} />
        </DialogTitle>
        <DialogDescription>
          {isReturning ? t('auth.local.descriptionReturning') : t('auth.local.descriptionNew')}
        </DialogDescription>
      </DialogHeader>

      <label className="mt-2 block">
        <span className="text-label flex items-center gap-1">
          {isReturning ? t('auth.local.yourPassphrase') : t('auth.local.createPassphrase')}
          <InfoTooltip text={t('auth.local.passphraseExplainer')} />
        </span>
        <Input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !connecting && handleConnect()}
          placeholder={isReturning ? t('auth.local.enterPassphrase') : t('auth.local.createPassphrase')}
          className="w-full mt-1.5"
          autoComplete={isReturning ? 'current-password' : 'new-password'}
          autoFocus
        />
      </label>
      {!isReturning && (
        <>
          <label className="mt-3 block">
            <span className="text-label">{t('auth.local.confirmLabel')}</span>
            <Input
              type="password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !connecting && handleConnect()}
              placeholder={t('auth.local.confirmPlaceholder')}
              className="w-full mt-1.5"
              autoComplete="new-password"
              aria-invalid={mismatch}
              aria-describedby={mismatch ? 'passphrase-mismatch' : undefined}
            />
          </label>
          {mismatch && (
            <p id="passphrase-mismatch" role="alert" className="mt-1.5 text-xs text-brand-danger-fg">{t('auth.local.mismatch')}</p>
          )}
          <SafetyNote tone="warning" className="mt-3">
            {t('auth.local.warning')}
          </SafetyNote>
        </>
      )}
      <Button onClick={handleConnect} loading={connecting} disabled={!canConnect} className="mt-3 w-full h-11">
        {connecting ? t('auth.local.connecting') : t('auth.local.connect')}
      </Button>
      <p className="mt-3 flex gap-2 text-xs text-brand-text-secondary">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        {t('auth.local.privacyNote')}
      </p>
    </>
  )
}
