import { useState, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useAuth, hasStoredIdentity, WrongPassphraseError } from '../context/AuthContext'
import { InfoTooltip } from '../components/ui/InfoTooltip'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { ArrowLeft, ChevronRight, KeyRound, Link2, ShieldCheck, Wallet, type LucideIcon } from 'lucide-react'

const PASSPHRASE_EXPLAINER =
  'Essa senha nunca sai do seu navegador nem é enviada ao Sails Protocol — ela só criptografa sua chave privada aqui localmente (AES-256-GCM). Se esquecer, não tem como recuperar: a chave (e o acesso à conta/fundos vinculados) fica permanentemente inacessível.'

// Routes a visitor can see without a session. Cancelling the dialog returns
// there; returning to a protected route would bounce straight back here.
const isPublicPath = (path: string) => path === '/' || path.startsWith('/offer/')

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
  const [step, setStep] = useState<'list' | 'local'>('list')

  const close = () => {
    const from = state?.from
    navigate(from && isPublicPath(from) ? from : '/', { replace: true })
  }

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && close()}>
      <DialogContent className="max-w-sm">
        {step === 'list' ? (
          <>
            <DialogHeader>
              <DialogTitle>Conectar wallet</DialogTitle>
              <DialogDescription>Escolha como você quer se conectar.</DialogDescription>
            </DialogHeader>
            <ul className="mt-2 space-y-2">
              <Option icon={Wallet} title="Satsails Wallet" trailing="Em breve" />
              <Option icon={Link2} title="WalletConnect" trailing="Em breve" />
              <Option
                icon={KeyRound}
                title="Chave local"
                subtitle="Para testes, guardada neste navegador"
                onSelect={() => setStep('local')}
              />
            </ul>
            <p className="mt-4 text-center text-xs text-brand-text-muted">Não tem uma wallet? A Satsails Wallet chega em breve.</p>
          </>
        ) : (
          <LocalKeyStep
            onBack={() => setStep('list')}
            onConnected={() =>
              navigate(state?.from ?? '/', { replace: true, state: state?.amount ? { amount: state.amount } : undefined })
            }
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
        className="w-full min-h-14 flex items-center gap-3 rounded-lg border border-brand-border-subtle bg-brand-elevated/40 px-3 py-2.5 text-left transition-colors enabled:hover:bg-brand-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-orange-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        <span className="w-9 h-9 rounded-lg bg-brand-elevated flex items-center justify-center shrink-0">
          <Icon className="h-4 w-4 text-brand-text-secondary" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-brand-text">{title}</span>
          {subtitle && <span className="block text-xs text-brand-text-muted">{subtitle}</span>}
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

function LocalKeyStep({ onBack, onConnected }: { onBack: () => void; onConnected: () => void }) {
  const { login } = useAuth()
  const [connecting, setConnecting] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  // An existing encrypted keypair decides the copy ("crie" vs "digite").
  const [isReturning] = useState(() => hasStoredIdentity())

  const handleConnect = async () => {
    if (!passphrase) {
      toast.error(isReturning ? 'Digite sua senha' : 'Crie uma senha para proteger sua chave')
      return
    }
    setConnecting(true)
    try {
      // Real Ed25519 challenge-response (packages/sails-sdk/src/modules/identity.ts).
      // `passphrase` never reaches the SDK/backend — AuthContext uses it only
      // locally, to derive the AES key that encrypts the stored keypair.
      await login(passphrase)
      toast.success('Wallet conectada')
      onConnected()
    } catch (err) {
      toast.error(err instanceof WrongPassphraseError || err instanceof Error ? err.message : 'Falha ao conectar')
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
          aria-label="Voltar para as opções"
          className="-ml-1 mb-1 w-8 h-8 flex items-center justify-center rounded-md text-brand-text-secondary hover:text-brand-text hover:bg-brand-elevated"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <DialogTitle className="flex items-center gap-1.5">
          Chave local
          <InfoTooltip text="Autenticação por assinatura de chave Ed25519 gerada neste navegador. Sua chave privada nunca sai do seu dispositivo." />
        </DialogTitle>
        <DialogDescription>
          {isReturning ? 'Digite a senha que protege a chave deste navegador.' : 'Crie uma senha para proteger a chave que será gerada neste navegador.'}
        </DialogDescription>
      </DialogHeader>

      <label className="mt-2 block">
        <span className="text-label flex items-center gap-1">
          {isReturning ? 'Sua senha' : 'Crie uma senha'}
          <InfoTooltip text={PASSPHRASE_EXPLAINER} />
        </span>
        <Input
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !connecting && handleConnect()}
          placeholder={isReturning ? 'Digite sua senha' : 'Crie uma senha'}
          className="w-full mt-1.5"
          autoComplete={isReturning ? 'current-password' : 'new-password'}
          autoFocus
        />
      </label>
      <Button onClick={handleConnect} disabled={connecting || !passphrase} className="mt-3 w-full h-11">
        {connecting ? 'Conectando...' : 'Conectar'}
      </Button>
      <p className="mt-3 flex gap-2 text-xs text-brand-text-secondary">
        <ShieldCheck className="h-4 w-4 shrink-0" />
        Sua chave privada nunca sai do seu dispositivo. O Sails Protocol só verifica sua assinatura.
      </p>
    </>
  )
}
