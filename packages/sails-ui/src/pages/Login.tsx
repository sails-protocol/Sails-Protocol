import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { useAuth, hasStoredIdentity, WrongPassphraseError } from '../context/AuthContext'
import { ThemeToggle } from '../components/ui/ThemeToggle'
import { InfoTooltip } from '../components/ui/InfoTooltip'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Lock, Zap, Globe, KeyRound, ShieldCheck, type LucideIcon } from 'lucide-react'

const PASSPHRASE_EXPLAINER =
  'Essa senha nunca sai do seu navegador nem é enviada ao Sails Protocol — ela só criptografa sua chave privada aqui localmente (AES-256-GCM). Se esquecer, não tem como recuperar: a chave (e o acesso à conta/fundos vinculados) fica permanentemente inacessível.'

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [connecting, setConnecting] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  // Computed once at mount, not re-checked per keystroke — whether this
  // browser already has an encrypted keypair decides the copy below
  // ("crie uma senha" vs "digite sua senha"), same signal
  // AuthContext.tsx's own hasStoredIdentity() exports for this purpose.
  const [isReturning] = useState(() => hasStoredIdentity())

  const handleConnect = async () => {
    if (!passphrase) {
      toast.error(isReturning ? 'Digite sua senha' : 'Crie uma senha para proteger sua chave')
      return
    }
    setConnecting(true)
    try {
      // Real Ed25519 challenge-response — identity.create() once (fresh
      // keypair), identity.authenticate() every login
      // (packages/sails-sdk/src/modules/identity.ts). WDK itself
      // (@tetherto/wdk-wallet-evm) never runs in a browser tab — it holds
      // seed material, server-side only; this is the separate identity
      // keypair (Ed25519), not a WDK-managed key. `passphrase` never
      // reaches the SDK/backend — AuthContext.tsx uses it only locally,
      // to derive the AES key that encrypts the stored keypair.
      await login(passphrase)
      toast.success('Conectado!')
      // Real fix: this used to always navigate to '/', so any protected
      // action (e.g. OfferDetail's "Iniciar Trade") that bounced an
      // unauthenticated user here lost all context — they'd land back on
      // the Marketplace and have to re-find the offer and retype the
      // amount. Now returns to wherever the redirect came from, carrying
      // the amount forward too (OfferDetail reads it back to prefill).
      const state = location.state as { from?: string; amount?: number } | null
      navigate(state?.from ?? '/', { state: state?.amount ? { amount: state.amount } : undefined })
    } catch (err) {
      if (err instanceof WrongPassphraseError) {
        toast.error(err.message)
      } else {
        toast.error(err instanceof Error ? err.message : 'Falha ao conectar')
      }
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-brand-bg">
      {/* Brand showcase panel — deliberately always dark (the official
          Satsails identity), independent of the light/dark toggle,
          which only affects the form panel on the right. */}
      <div
        className="hidden lg:flex flex-col justify-center px-14 text-white relative overflow-hidden"
        /* Hardcoded, not `var(--color-orange-subtle)`: this panel is
           deliberately always dark regardless of the site-wide light/dark
           toggle (see this div's own comment above), but that CSS var
           flips with `.dark` on <html> — reading it here would dim this
           glow whenever a visitor's overall theme choice is light. */
        style={{ backgroundColor: '#050505', backgroundImage: 'radial-gradient(ellipse 80% 40% at 50% -5%, rgba(249,115,22,0.1) 0%, transparent 65%)' }}
      >
        <h1 className="text-4xl font-display font-bold tracking-tight leading-tight">
          O marketplace P2P para crypto soberana
        </h1>
        <p className="text-neutral-400 text-lg mt-4">Negocie direto com outras pessoas. Sua chave fica no seu dispositivo.</p>

        <ul className="mt-10 space-y-4 text-sm">
          <Feature icon={Lock} title="Escrow por trade" desc="Cada trade mostra o tipo de escrow e quem pode assinar a liberação" />
          <Feature icon={Zap} title="P2P direto" desc="Negocie direto com a contraparte pelo chat do trade" />
          <Feature icon={Globe} title="Vários ativos" desc="Os ativos e as redes disponíveis aparecem em cada oferta" />
        </ul>

        <p className="mt-16 text-xs text-neutral-500">Powered by Satsails</p>
      </div>

      <div className="flex flex-col justify-center px-6 lg:px-16 py-16 relative">
        <div className="absolute top-6 right-6">
          <ThemeToggle />
        </div>

        {/* UI-FOUNDATION-1-VISUAL-CORRECTION §4.7 — mobile/tablet has no
            brand panel (that's `hidden lg:flex` above), so this was the
            only breakpoint with zero Sails Market identity on the whole
            screen. Same wordmark treatment as Sidebar.tsx's own header. */}
        <div className="lg:hidden mb-8 font-display font-bold tracking-tight text-brand-text text-lg">
          Sails <span className="text-brand-orange-accent">Market</span>
        </div>

        {/* UI-FOUNDATION-1-VISUAL-CORRECTION §4.7 — the form used to float
            directly on the page background with no surface of its own,
            reading as unfinished next to the new shell's layered panels.
            A bounded card gives it the same tonal weight as the rest of
            the product. */}
        <div className="w-full max-w-sm mx-auto lg:mx-0 rounded-2xl border border-brand-border-subtle bg-brand-surface p-6 sm:p-8">
          {/* Real fix from a cold-start UX walkthrough: "Use seu keypair
              Ed25519 para autenticar" and "Conectar com WDK" were the
              FIRST and ONLY things a brand-new, non-technical user saw —
              neither means anything without already knowing what this
              product is. The technical detail is true and stays (this is
              a reference implementation of real crypto, not a claim to
              water down) but it now lives behind an info icon instead of
              being the primary copy a first-time user has to parse. */}
          <div className="flex items-center gap-1.5">
            <h2 className="text-page-title">Entrar</h2>
            <InfoTooltip text="Tecnicamente: autenticação por assinatura de chave Ed25519 — sem senha, sem servidor guardando credenciais. Sua chave privada nunca sai do seu dispositivo." />
          </div>
          <p className="text-sm text-brand-text-muted mt-1.5">Conecte sua carteira para comprar e vender com segurança</p>

          <div className="mt-7">
            <label className="mb-1.5 block">
              {/* DESIGN-LANGUAGE-1 §4.4 — was ad-hoc `text-xs text-brand-text-muted`;
                  `.text-label` is the same typography level FilterPanel's
                  section headers and Marketplace's column headers now use,
                  so a form field label reads as the same design language
                  rather than a one-off size/color pairing. */}
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
              />
            </label>
          </div>

          <Button onClick={handleConnect} disabled={connecting || !passphrase} className="mt-5 w-full h-14">
            {connecting ? (
              'Conectando...'
            ) : (
              <>
                <KeyRound className="h-4 w-4" />
                Conectar Carteira
              </>
            )}
          </Button>
          <p className="text-xs text-brand-text-muted text-center mt-2">Powered by Satsails</p>

          <div className="mt-7 bg-brand-elevated border border-brand-border-subtle rounded-lg p-4 flex gap-3">
            <ShieldCheck className="h-4 w-4 text-brand-text-secondary shrink-0" />
            <p className="text-xs text-brand-text-secondary">
              Sua chave privada nunca sai do seu dispositivo. O Sails Protocol só verifica sua assinatura.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

function Feature({ icon: Icon, title, desc }: { icon: LucideIcon; title: string; desc: string }) {
  return (
    <li className="flex gap-3">
      <span className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4" />
      </span>
      <div>
        <div className="font-semibold">{title}</div>
        <div className="text-neutral-400 text-xs">{desc}</div>
      </div>
    </li>
  )
}
