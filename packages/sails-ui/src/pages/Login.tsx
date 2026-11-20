import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useAuth, hasStoredIdentity, WrongPassphraseError } from '../context/AuthContext'
import { InfoTooltip } from '../components/ui/InfoTooltip'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { KeyRound, Link2, ShieldCheck, Wallet, type LucideIcon } from 'lucide-react'

const PASSPHRASE_EXPLAINER =
  'Essa senha nunca sai do seu navegador nem é enviada ao Sails Protocol — ela só criptografa sua chave privada aqui localmente (AES-256-GCM). Se esquecer, não tem como recuperar: a chave (e o acesso à conta/fundos vinculados) fica permanentemente inacessível.'

// Routes a visitor can see without a session. Cancelling the dialog returns
// there; returning to a protected route would bounce straight back here.
const isPublicPath = (path: string) => path === '/' || path.startsWith('/offer/')

/**
 * "Conectar carteira" dialog, rendered at /login over the Market (App.tsx).
 * Every existing `navigate('/login', { state: { from, amount } })` caller
 * keeps working unchanged: success returns to `from` carrying `amount`.
 *
 * Satsails Wallet and WalletConnect are listed but not wired yet (no
 * connector exists in this repo); they are disabled and labelled "Em breve"
 * rather than simulating a connected session. The local browser key is the
 * only real method today.
 */
export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const state = location.state as { from?: string; amount?: number } | null
  const [connecting, setConnecting] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  // Computed once at mount: an existing encrypted keypair decides the copy
  // ("crie uma senha" vs "digite sua senha").
  const [isReturning] = useState(() => hasStoredIdentity())

  const close = () => {
    const from = state?.from
    navigate(from && isPublicPath(from) ? from : '/', { replace: true })
  }

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
      toast.success('Carteira conectada')
      navigate(state?.from ?? '/', { replace: true, state: state?.amount ? { amount: state.amount } : undefined })
    } catch (err) {
      toast.error(err instanceof WrongPassphraseError || err instanceof Error ? err.message : 'Falha ao conectar')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open: boolean) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Conectar carteira</DialogTitle>
          <DialogDescription>Escolha como você quer se conectar ao Sails Market.</DialogDescription>
        </DialogHeader>

        <ul className="mt-2 space-y-2">
          <UnavailableOption icon={Wallet} title="Satsails Wallet" desc="Conexão direta com a Satsails Wallet" />
          <UnavailableOption icon={Link2} title="WalletConnect" desc="Use uma carteira compatível com WalletConnect" />
        </ul>

        <div className="mt-4 rounded-lg border border-brand-border-subtle p-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-brand-text">
            <KeyRound className="h-4 w-4 shrink-0" />
            Chave local neste navegador
            <InfoTooltip text="Autenticação por assinatura de chave Ed25519 gerada neste navegador. Sua chave privada nunca sai do seu dispositivo." />
          </div>
          <label className="mt-3 block">
            <span className="text-label flex items-center gap-1">
              {isReturning ? 'Sua senha' : 'Crie uma senha'}
              <InfoTooltip text={PASSPHRASE_EXPLAINER} />
            </span>
            <Input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !connecting && handleConnect()}
              placeholder={isReturning ? 'Digite sua senha' : 'Crie uma senha para proteger sua chave'}
              className="w-full mt-1.5"
              autoComplete={isReturning ? 'current-password' : 'new-password'}
              autoFocus
            />
          </label>
          <Button onClick={handleConnect} disabled={connecting || !passphrase} className="mt-3 w-full h-11">
            {connecting ? 'Conectando...' : 'Conectar'}
          </Button>
        </div>

        <p className="mt-3 flex gap-2 text-xs text-brand-text-secondary">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          Sua chave privada nunca sai do seu dispositivo. O Sails Protocol só verifica sua assinatura.
        </p>
      </DialogContent>
    </Dialog>
  )
}

function UnavailableOption({ icon: Icon, title, desc }: { icon: LucideIcon; title: string; desc: string }) {
  return (
    <li>
      <button
        type="button"
        disabled
        aria-disabled="true"
        className="w-full flex items-center gap-3 rounded-lg border border-brand-border-subtle p-3 text-left opacity-60 cursor-not-allowed"
      >
        <span className="w-9 h-9 rounded-lg bg-brand-elevated flex items-center justify-center shrink-0">
          <Icon className="h-4 w-4 text-brand-text-secondary" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-brand-text">{title}</span>
          <span className="block text-xs text-brand-text-muted">{desc}</span>
        </span>
        <span className="text-xs font-medium text-brand-text-muted shrink-0">Em breve</span>
      </button>
    </li>
  )
}
