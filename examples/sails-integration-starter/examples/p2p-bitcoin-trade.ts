/**
 * Fase 6 — golden-path example: a real BTC/PIX P2P trade start to finish,
 * using only `@satsails/p2p-trading-sdk`'s public API. Mirrors
 * `examples/simple-wallet/src/index.ts`'s proven pattern (two independent
 * SailsClient instances, one per side, nothing shared) — see that file's
 * own header for why each step is shaped the way it is; this script
 * doesn't repeat that reasoning, only the asset differs (BTC, not
 * USDT_ERC20).
 *
 * Escrow type: deliberately left unset, so the server falls back to
 * whatever `config.features.mockEscrow` resolves to
 * (`escrow.service.ts`'s `type ?? (config.features.mockEscrow ? 'MOCK' :
 * 'MULTISIG')`) — MOCK on this repo's own local dev `.env`
 * (`MOCK_ESCROW=true`). The real MULTISIG provider is non-custodial by
 * design (`multisig.provider.ts`'s `lockFunds()`): it verifies actual
 * on-chain BTC arrived at a derived P2WSH address via a block-explorer
 * API — it does not, and structurally cannot, move funds itself. That
 * makes it correct but not something an unattended script can drive
 * end-to-end without a human sending real testnet BTC. Explicitly
 * requesting `type: 'MULTISIG'` here would make this script fail exactly
 * where a real integration also would, at the same real wall — see
 * `docs/USE_CASES.md` for how to drive the real MULTISIG flow by hand.
 *
 * Prerequisites: a Sails node running locally (`npm run dev` from the
 * repo root).
 *
 * Run: npm run example:p2p-bitcoin-trade -w @sails/example-integration-starter
 */
import { SailsClient, type ChatMessageEvent } from '@satsails/p2p-trading-sdk'

const BASE_URL = process.env.SAILS_BASE_URL ?? 'http://localhost:3000'

let stepNumber = 0
function step(label: string): void {
  stepNumber += 1
  console.log(`\n[${stepNumber}] ${label}`)
}

function waitForMessage(
  channel: ReturnType<SailsClient['openp2p']['chat']>,
  timeoutMs = 5000
): Promise<ChatMessageEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No chat message received within ${timeoutMs}ms`)), timeoutMs)
    channel.onMessage((msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
  })
}

async function main() {
  const sellerWallet = new SailsClient({ baseUrl: BASE_URL })
  const buyerWallet = new SailsClient({ baseUrl: BASE_URL })

  step('Seller registers and authenticates (identity.create + identity.authenticate)')
  const { keypair: sellerKeypair } = await sellerWallet.identity.create(undefined, 'P2P Bitcoin Trade — Seller')
  await sellerWallet.identity.authenticate(sellerKeypair)
  console.log('    seller session established')

  step('Buyer registers and authenticates')
  const { keypair: buyerKeypair } = await buyerWallet.identity.create(undefined, 'P2P Bitcoin Trade — Buyer')
  await buyerWallet.identity.authenticate(buyerKeypair)
  console.log('    buyer session established')

  step('Seller publishes a BTC/SELL offer (liquidity.publish)')
  // Priced aggressively low for the same real reason simple-wallet's own
  // script documents: discover() orders SELL offers by priceUsd ascending
  // with a hard cap, and this repo's shared local dev database
  // accumulates offers from every prior run of every example/E2E suite.
  const offer = await sellerWallet.liquidity.publish({
    asset: 'BTC',
    side: 'SELL',
    priceUsd: '0.01',
    minAmount: '0.001',
    maxAmount: '1',
    paymentMethod: 'PIX',
    paymentDetails: 'p2p-bitcoin-trade-example-pix-key',
  })
  console.log(`    offer ${offer.id} published`)

  step('Buyer discovers offers for BTC/SELL (liquidity.discover)')
  const { offers } = await buyerWallet.liquidity.discover({ asset: 'BTC', side: 'SELL', limit: 50 })
  const found = offers.find((o) => o.id === offer.id)
  if (!found) throw new Error('Published offer did not appear in discover() results')
  console.log(`    found ${offers.length} offer(s), including the one just published`)

  step('Buyer opens a trade against the offer (openp2p.trade)')
  const trade = await buyerWallet.openp2p.trade(offer.id, '0.01')
  console.log(`    trade ${trade.id} created`)

  step('Both sides connect to chat and exchange one message (openp2p.chat)')
  const sellerChat = sellerWallet.openp2p.chat(trade.id)
  const buyerChat = buyerWallet.openp2p.chat(trade.id)
  await new Promise((r) => setTimeout(r, 300))
  const received = waitForMessage(sellerChat)
  buyerChat.send({ content: 'Hi — sending payment now via PIX.' })
  const message = await received
  console.log(`    seller received: "${message.content}"`)
  sellerChat.close()
  buyerChat.close()

  step('Seller creates and locks the escrow (settlement.create + settlement.lock)')
  // MOCK explicitly: without a type, create() picks the asset's real
  // settlement rail, which needs a funded testnet wallet on the node. The
  // node refuses MOCK escrows in production.
  const escrow = await sellerWallet.settlement.create({
    tradeId: trade.id,
    type: 'MOCK',
    lockedAmount: '0.01',
    asset: 'BTC',
  })
  await sellerWallet.settlement.lock(escrow.id)
  console.log(`    escrow ${escrow.id} locked (type: ${escrow.type})`)

  step('Buyer marks the fiat payment as sent (settlement.markPaymentSent)')
  await buyerWallet.settlement.markPaymentSent(escrow.id)
  console.log('    payment marked sent')

  // Release pays the buyer's own registered payout address for the asset;
  // the server ignores any address the releasing seller supplies, and
  // refuses to release when the buyer has none registered.
  step('Buyer registers a payout address (settlement.setPayoutAddress)')
  await buyerWallet.settlement.setPayoutAddress({
    asset: 'BTC',
    address: 'example-buyer-btc-address', // placeholder: a real wallet registers its own receive address
  })

  step('Seller releases the escrow (settlement.release)')
  const released = await sellerWallet.settlement.release(escrow.id)
  console.log(`    escrow status: ${released.status}, txReleaseId: ${released.txReleaseId}`)

  console.log(`\nDone. Paste this tradeId into the Next.js starter's "View a trade" section:\n\n    ${trade.id}\n`)
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err)
  console.error(`\nIs a Sails node running at ${BASE_URL}? Start one with "npm run dev" from the repo root.`)
  process.exitCode = 1
})
