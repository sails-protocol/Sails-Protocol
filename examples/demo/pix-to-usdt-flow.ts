/**
 * Sails Protocol — Emulação: Comprador PIX ➡️ Vendedor USDT
 *
 * Two local agents (open-agents/buyer-agent.ts, seller-agent.ts) simulate
 * two Satsails Wallet instances, each autonomously generating their own
 * structured request via QVAC (open-agents/qvac-agent.provider.ts, real
 * local LLM inference) before anything is persisted:
 *
 *   SellerAgent  → proposes an offer shape (asset/side/amount range/
 *                  payment method) from a plain-language goal
 *   BuyerAgent   → generates a real TradeIntentPayload (common/types/
 *                  intent.ts) from a plain-language goal — "solicitando
 *                  a compra de USDT enviando um PIX"
 *
 * Both outputs pass through the same real validation every other client
 * of this system does — intentEngine.create()'s CISO Byzantine/Economic
 * rules for the buyer's Intent, liquidityRouter.createOffer()'s Prisma
 * write for the seller's offer. Neither is trusted specially for being
 * LLM-generated (qvac-agent.provider.ts's own doc comment states this
 * once, for both agents).
 *
 * From there the flow continues through every other real piece built in
 * this pass: OpenP2P negotiation (Pears) → QVAC risk check on the
 * resulting Trade → OpenSettlement escrow lifecycle → WDK USDT
 * settlement (real @tetherto/wdk-wallet-evm calls when configured).
 *
 * Step 6 (negotiation) sends the buyer's actual Intent directly to the
 * seller's node over Hyperswarm/HyperDHT — real keypairs (each PearNode
 * generates its own via `HyperDHT.keyPair()` internally, 2026-08-09 key-
 * custody fix — this script no longer generates or transmits one itself),
 * a real trade-scoped
 * topic join (`PearsTransportProvider.sendIntentToPeer`,
 * infrastructure/p2p/transport-provider.ts), and a real libsodium sealed
 * box (`infrastructure/p2p/payload-crypto.ts`) addressed to the seller's
 * actual identity key — not a Postgres write standing in for that
 * handoff. `tradeService.createTrade()` still runs alongside it: that's
 * the durability/audit record (RFC-008's hash-chained Timeline), a
 * different concern from the real-time P2P delivery, not a substitute
 * for it.
 *
 * Requires a reachable Postgres/Redis (DATABASE_URL/REDIS_URL) *and* a
 * reachable HyperDHT bootstrap network for step 6 — this script exercises
 * the real service and infrastructure layers, not mocks of them, so it
 * has the same requirements `npm run dev` plus a live P2P network would.
 * Not run live as part of this pass — neither Postgres/Redis nor a real
 * P2P network is reachable in the environment this was written in (same
 * limitation TODO.md documents everywhere else in this project). Each
 * individual piece it calls into is already built and, where the
 * environment allowed it, verified for real — see
 * tests/wdkSettlementProvider.test.ts, qvac-agent.provider.ts's own live
 * smoke-test note, and tests/payloadCrypto.test.ts /
 * tests/intentTransport.test.ts (the sealed-box math and the
 * sendIntentToPeer composition logic, both verified without needing a
 * live network — only the actual hole-punched connection itself can't be
 * exercised here).
 *
 * Steps 8-9 (escrow lock, emulated PIX receipt, USDT release) are a
 * single call to `settlement-orchestrator.ts`'s `executeSettlement()` —
 * the real orchestration function, not this script re-implementing the
 * sequence inline. WDK USDT settlement is only real when MOCK_ESCROW=false
 * and WDK_SEED_PHRASE/WDK_USDT_CONTRACT are set (.env.example) — otherwise
 * escrow.service.ts's own config gate (RT-001) silently uses
 * MockSettlementProvider, same as every other escrow flow in this repo.
 * This script never assumes real funds moved; it reports which provider
 * actually ran.
 *
 * The "buyer's USDT address" in the release step is derived from the
 * *same* WDK seed as the treasury/escrow accounts (a different account
 * index), standing in for the buyer's own independently-controlled
 * wallet — this reference implementation doesn't onboard per-user EVM
 * keys yet (participants only have Ed25519 identity keys,
 * common/database's User model). A real deployment would ask the buyer
 * for their own address here instead.
 */
import { config } from '../../src/config'
import { connectDatabase } from '../../src/common/database'
import { connectRedis } from '../../src/common/redis'
import nacl from 'tweetnacl'
import { identityService } from '../../src/modules/open-identity/identity.service'
import { issueRegistrationChallenge, registrationProofMessage } from '../../src/common/middleware/auth'
import { liquidityRouter } from '../../src/modules/open-liquidity/liquidity.service'
import { tradeService } from '../../src/modules/open-p2p/trade.service'
import { executeSettlement } from '../../src/modules/open-settlement/settlement-orchestrator'
import { wdkSettlementProvider } from '../../src/modules/open-settlement/wdk-settlement.provider'
import { qvacAgentProvider } from '../../src/modules/open-agents/qvac-agent.provider'
import { BuyerAgent } from '../../src/modules/open-agents/buyer-agent'
import { SellerAgent } from '../../src/modules/open-agents/seller-agent'
import { intentEngine } from '../../src/core/intent-engine'
import { capabilityRegistry, CAPABILITY_IMPLEMENTATIONS } from '../../src/core/capability-registry'
import { pearsTransportProvider } from '../../src/infrastructure/p2p/transport-provider'
import { pearNodeRegistry } from '../../src/infrastructure/p2p/pear.service'
import { decryptFromPeer } from '../../src/infrastructure/p2p/payload-crypto'

const BUYER_DEMO_ACCOUNT_INDEX = 1 // treasury is account 0 — see wdk-settlement.provider.ts

function step(n: number, total: number, label: string) {
  console.log(`\n[${n}/${total}] ${label}`)
}

// Issue #302 — registration now requires real proof of possession
// (common/middleware/auth.ts's verifyRegistrationProof()); this demo
// previously registered with arbitrary, non-Ed25519 placeholder
// strings ("demo-seller-<ts>") as the "public key," which can no
// longer satisfy that requirement. Generates a real, throwaway keypair
// instead — a strict improvement, same net effect (an isolated,
// disposable User row for this one rehearsal run).
async function registerDemoParticipant(displayName: string) {
  const keypair = nacl.sign.keyPair()
  const publicKey = Buffer.from(keypair.publicKey).toString('hex')
  const { challenge } = await issueRegistrationChallenge(publicKey)
  const signature = Buffer.from(
    nacl.sign.detached(registrationProofMessage(challenge, displayName), keypair.secretKey)
  ).toString('hex')
  return identityService.register({ publicKey, signature, displayName })
}

export async function main() {
  console.log('=== Sails Protocol — Emulação: Comprador PIX ➡️ Vendedor USDT ===')

  await connectDatabase()
  await connectRedis()

  const TOTAL = 9

  step(1, TOTAL, 'Registrando identidades (Sails OpenIdentity)...')
  const seller = await registerDemoParticipant('Vendedor USDT')
  const buyer = await registerDemoParticipant('Comprador PIX')
  console.log(`   Vendedor: ${seller.id}`)
  console.log(`   Comprador: ${buyer.id}`)

  const sellerAgent = new SellerAgent(qvacAgentProvider, { participantId: seller.id, label: 'seller-wallet' })
  const buyerAgent = new BuyerAgent(qvacAgentProvider, { participantId: buyer.id, label: 'buyer-wallet' })

  // RFC-014: capability-registry.ts's enforcement is off by default
  // (config.features.enforceCapabilities) precisely because a reference
  // deployment with no grants issued is valid today — but that also means
  // no script in this repo ever exercised the registry's real issue/check
  // path end to end. Issuing these two grants here costs nothing when
  // enforcement stays off (an unused grant just sits in the table) and
  // means this demo keeps working, unmodified, the moment someone sets
  // ENFORCE_CAPABILITIES=true — rather than leaving that flag's first real
  // test to be whichever production deployment flips it on first.
  await capabilityRegistry.grant({
    grantedTo: buyer.id,
    capabilityName: CAPABILITY_IMPLEMENTATIONS.openp2p, // 'trade-coordination'
    // Missão 02.5 — 'intent.discovering' added alongside the original
    // 'intent.created': Missão 02 (RFC-023 amendment) gated
    // POST /v1/intents/:id/propose behind this same capability, and this
    // grant's own reason for existing (see header comment above) is to
    // keep working unmodified the moment ENFORCE_CAPABILITIES=true — a
    // grant that only covered Intent creation and not the propose step
    // that now follows it would have silently broken that promise.
    scope: ['intent.created', 'intent.discovering'],
    issuedBy: buyer.id, // self-issued — RFC-013's own MVP scope cut, not a new one here
  })
  await capabilityRegistry.grant({
    grantedTo: sellerAgent.agentId, // matches settlement-orchestrator.ts's sellerTriggeredBy
    capabilityName: CAPABILITY_IMPLEMENTATIONS.opensettlement, // 'settlement'
    scope: ['settlement.escrow.released'],
    issuedBy: seller.id,
  })

  step(2, TOTAL, 'Agente Vendedor gera a oferta autonomamente via QVAC (inferência local — primeira chamada baixa ~737MB)...')
  const proposedOffer = await sellerAgent.offerUsdtForPix()
  console.log(`   Gerado por ${sellerAgent.agentId}: ${JSON.stringify(proposedOffer)}`)

  step(3, TOTAL, 'Oferta é publicada (Sails OpenLiquidity)...')
  const offer = await liquidityRouter.createOffer({
    userId: seller.id,
    ...proposedOffer,
    priceUsd: '5.45', // BRL por USDT — preço de mercado externo, QVAC não decide isso (seller-agent.ts's own doc comment)
  })
  console.log(`   Offer: ${offer.id} (${offer.minAmount}-${offer.maxAmount} ${offer.asset} via ${offer.paymentMethod})`)

  step(4, TOTAL, 'Agente Comprador gera o Intent autonomamente via QVAC ("solicitando a compra de USDT enviando um PIX")...')
  const buyerPayload = await buyerAgent.requestUsdtViaPix('500')
  console.log(`   Gerado por ${buyerAgent.agentId}: ${JSON.stringify(buyerPayload)}`)

  step(5, TOTAL, 'Intent passa pela validação real do protocolo (Core: CISO Byzantine + Economic rules)...')
  const intent = await intentEngine.create('TradeIntent', buyerPayload, buyer.id, buyerAgent.agentId)
  console.log(`   Intent: ${intent.id} — status ${intent.status} (agentId: ${intent.agentId ?? 'n/a'})`)

  step(6, TOTAL, 'Comprador aceita a oferta e abre negociação (Sails OpenP2P, canal via Pears)...')
  const trade = await tradeService.createTrade({ offerId: offer.id, counterpartyId: buyer.id, amount: offer.minAmount.toString() })
  console.log(`   Trade: ${trade.id} — ${trade.amount} ${trade.asset}`)

  console.log('   Abrindo nós P2P reais (HyperDHT/Hyperswarm) para Comprador e Vendedor...')
  // Key-custody fix (2026-08-09) — pearsTransportProvider.start() no
  // longer takes a caller-supplied secret key; each PearNode generates
  // its own ephemeral identity internally (pear.service.ts's own doc
  // comment has the full reasoning). The seller's real keypair — needed
  // below only to prove the sealed box actually decrypts, standing in
  // for what the seller's own wallet process would do with a key it
  // alone holds — comes from the real running node via
  // pearNodeRegistry.get(), not a locally-generated copy the server
  // never has (there is no such copy anymore).
  await pearsTransportProvider.start(seller.id)
  await pearsTransportProvider.start(buyer.id)
  const sellerKeyPair = pearNodeRegistry.get(seller.id)!.getKeyPair()!

  let receivedIntentPlaintext: unknown = null
  pearsTransportProvider.onMessage(seller.id, (_peerId, message) => {
    const m = message as { type?: string; ciphertext?: string }
    if (m.type === 'INTENT' && m.ciphertext) {
      receivedIntentPlaintext = decryptFromPeer(m.ciphertext, sellerKeyPair)
    }
  })

  console.log('   Comprador envia o Intent criptografado diretamente ao nó do Vendedor (hole-punching via Hyperswarm, sem servidor central)...')
  const delivered = await pearsTransportProvider.sendIntentToPeer(buyer.id, seller.id, intent, trade.id)
  console.log(`   Entrega P2P direta: ${delivered ? 'confirmada' : 'não confirmada (par ainda não conectado/alcançável)'}`)
  if (receivedIntentPlaintext) {
    console.log(`   Vendedor decifrou o Intent recebido via Pears: ${JSON.stringify(receivedIntentPlaintext)}`)
  }

  step(7, TOTAL, 'QVAC avalia risco do Trade resultante (Sails OpenAgents)...')
  const risk = await qvacAgentProvider.assessIntentRisk({
    asset: trade.asset,
    side: 'SELL',
    minValue: offer.minAmount.toString(),
    maxValue: offer.maxAmount.toString(),
    currency: 'BRL',
    fiatMethod: 'PIX',
  })
  console.log(`   Risco: ${risk.risk} | Recomendação: ${risk.recommendation}`)
  console.log(`   Raciocínio: ${risk.reasoning}`)
  if (risk.recommendation === 'reject') {
    // RFC-007 D7: QVAC/OpenAgents produces a signal, never a unilateral
    // action — a real deployment routes this to the Policy Engine, which
    // decides. This demo script plays that role and continues anyway,
    // since halting here would just be this script deciding, not the
    // Policy Engine.
    console.log('   (QVAC sinalizou "reject" — em produção isso vai para o Policy Engine decidir, não é bloqueado aqui automaticamente. Prosseguindo.)')
  }

  step(8, TOTAL, 'executeSettlement(): escrow travado, PIX (emulado) confirmado pelo Vendedor, USDT liberado...')
  const usingRealWdk = !config.features.mockEscrow && Boolean(config.wdk.seedPhrase)
  const buyerAddress = usingRealWdk
    ? await wdkSettlementProvider.getAccountAddress(BUYER_DEMO_ACCOUNT_INDEX)
    : 'mock-buyer-address'

  const settlement = await executeSettlement({
    tradeId: trade.id,
    buyerReceivingAddress: buyerAddress,
    sellerAgentId: sellerAgent.agentId,
  })
  console.log(`   Escrow: ${settlement.escrowId} (provider: ${usingRealWdk ? 'WDK_USDT_EVM real (testnet)' : 'MOCK — MOCK_ESCROW/WDK_SEED_PHRASE não configurados para real'})`)
  console.log(`   Tx de lock: ${settlement.lockTxId}`)
  console.log(`   PIX confirmado por ${settlement.pixConfirmation.confirmedBy} (emulado — ref ${settlement.pixConfirmation.reference}; uma prova real viria via Sails OpenProof em produção, RFC-003)`)

  step(9, TOTAL, 'Vendedor liberou USDT para o Comprador...')
  console.log(`   Liberado para ${buyerAddress}`)
  console.log(`   Tx de release: ${settlement.releaseTxId}`)

  console.log('\n=== Fluxo completo: Agentes (QVAC) → Intent/Oferta → Negociação (Pears) → Risco (QVAC) → Settlement (WDK) → Liberação ===')

  await pearsTransportProvider.stop(buyer.id)
  await pearsTransportProvider.stop(seller.id)
  await qvacAgentProvider.dispose()
  process.exit(0)
}

// Guarded so importing `main` for reuse (root-level demo-satsails-qvac.ts)
// doesn't also trigger this file's own standalone run as a side effect of
// module import — only run automatically when this file is the actual
// entrypoint (`npm run demo:pix-to-usdt`).
if (require.main === module) {
  main().catch((err) => {
    console.error('\n[demo] Falhou:', err)
    process.exit(1)
  })
}
