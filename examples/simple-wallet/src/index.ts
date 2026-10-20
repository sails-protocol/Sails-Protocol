/**
 * @sails/example-simple-wallet
 *
 * The dogfooding test for @satsails/p2p-trading-sdk (docs/TODO.md §25) —
 * and, as of Missão 07.4, the canonical golden-path reference every other
 * doc (README/GETTING_STARTED/SDK_GUIDE) points to instead of duplicating
 * its own copy of this flow. A wallet developer's first 15 minutes with
 * the SDK, written using ONLY its public surface
 * (`@satsails/p2p-trading-sdk`'s exports) — no reaching into this
 * monorepo's internal services, no mocks. It runs the real golden path
 * (identity → authenticate → publish → discover → trade → chat → escrow
 * → mark payment → payout address → release → reputation) against a real local Sails
 * node, exactly like a wallet integrating this protocol for the first
 * time would, ending on the same "rate the trade" step
 * README.md's own endpoint table names last.
 *
 * QVAC-assisted discovery (natural-language goal → generateTradeIntent()
 * → proposeTradeOutcome() → match/counterProposal) is a separate,
 * optional flow, not part of this golden path — see SDK_GUIDE.md's own
 * QVAC section for why it's kept apart (Missão 07.3: it's bounded
 * discovery, not interactive negotiation, and conflating the two here
 * would misrepresent both).
 *
 * Prerequisites: a Sails node running locally (`npm run dev` from the
 * repo root — see README.md in this directory for the full walkthrough,
 * including how to point this at a different node via SAILS_BASE_URL).
 *
 * Run: npm run start -w @sails/example-simple-wallet
 */
import { SailsClient, type ChatMessageEvent } from '@satsails/p2p-trading-sdk'

const BASE_URL = process.env.SAILS_BASE_URL ?? 'http://localhost:3000'

let stepNumber = 0
function step(label: string): void {
  stepNumber += 1
  console.log(`\n[${stepNumber}] ${label}`)
}

// Waits for one chat message on `channel`, or rejects after `timeoutMs` —
// a real wallet needs this same pattern (chat delivery is async, over a
// WebSocket, not a request/response call) so it's included here rather
// than hidden.
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
  // ── Two independent wallets, two independent SailsClient instances —
  // exactly how a real seller and a real buyer would each hold their own
  // client, their own keypair, their own session. Nothing is shared.
  const sellerWallet = new SailsClient({ baseUrl: BASE_URL })
  const buyerWallet = new SailsClient({ baseUrl: BASE_URL })

  step('Seller registers and authenticates (identity.create + identity.authenticate)')
  const { participant: seller, keypair: sellerKeypair } = await sellerWallet.identity.create(undefined, 'Simple Wallet — Seller')
  await sellerWallet.identity.authenticate(sellerKeypair)
  console.log('    seller session established')

  step('Buyer registers and authenticates')
  const { participant: buyer, keypair: buyerKeypair } = await buyerWallet.identity.create(undefined, 'Simple Wallet — Buyer')
  await buyerWallet.identity.authenticate(buyerKeypair)
  console.log('    buyer session established')

  step('Seller publishes a SELL offer (liquidity.publish)')
  // Priced deliberately low (real finding from running this example against
  // this repo's own well-used local dev backend, not a guess): discover()
  // orders SELL offers by priceUsd ascending and hard-caps at 10 results
  // (liquidity.service.ts's getOffers(), `take: 10`, no pagination param —
  // see docs/TODO.md §25). On a database that already has 10+ cheaper
  // active offers for this asset (true after enough E2E runs), a
  // realistically-priced new offer can silently fail to appear in
  // discover() at all. A real wallet integration hits this exact wall on
  // any sufficiently active marketplace — pricing aggressively low here
  // works around it for this demo; it does not fix the underlying gap.
  const offer = await sellerWallet.liquidity.publish({
    asset: 'USDT_ERC20',
    side: 'SELL',
    priceUsd: '0.01',
    minAmount: '1',
    maxAmount: '100',
    paymentMethod: 'PIX',
    paymentDetails: 'simple-wallet-example-pix-key',
  })
  console.log(`    offer ${offer.id} published`)

  step('Buyer discovers offers for USDT_ERC20/SELL (liquidity.discover)')
  // limit: 50 (the route's own max, docs/TODO.md §25) — the low price
  // above stopped being enough on its own once this repo's shared local
  // dev database accumulated more than 10 offers ALSO priced at the
  // minimum tier (every prior run of this example, plus §22-§26's own
  // E2E runs, all racing for the same "cheapest" slot). Real proof the
  // underlying gap is real: even the fix's own demo needed the fix.
  const { offers } = await buyerWallet.liquidity.discover({ asset: 'USDT_ERC20', side: 'SELL', limit: 50 })
  const found = offers.find((o) => o.id === offer.id)
  if (!found) throw new Error('Published offer did not appear in discover() results')
  console.log(`    found ${offers.length} offer(s), including the one just published`)

  step('Buyer opens a trade against the offer (openp2p.trade)')
  const trade = await buyerWallet.openp2p.trade(offer.id, '10')
  console.log(`    trade ${trade.id} created`)

  step('Both sides connect to chat and exchange one message (openp2p.chat)')
  const sellerChat = sellerWallet.openp2p.chat(trade.id)
  const buyerChat = buyerWallet.openp2p.chat(trade.id)
  await new Promise((r) => setTimeout(r, 300)) // let both WS JOIN_TRADE frames land before sending
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
    lockedAmount: '10',
    asset: 'USDT_ERC20',
  })
  await sellerWallet.settlement.lock(escrow.id)
  console.log(`    escrow ${escrow.id} locked`)

  step('Buyer marks the fiat payment as sent (settlement.markPaymentSent)')
  await buyerWallet.settlement.markPaymentSent(escrow.id)
  console.log('    payment marked sent')

  // Release pays the buyer's own registered payout address for the asset;
  // the server ignores any address the releasing seller supplies, and
  // refuses to release when the buyer has none registered.
  step('Buyer registers a payout address (settlement.setPayoutAddress)')
  await buyerWallet.settlement.setPayoutAddress({
    asset: 'USDT_ERC20',
    address: 'example-buyer-usdt-address', // placeholder: a real wallet registers its own receive address
  })

  step('Seller releases the escrow (settlement.release)')
  const released = await sellerWallet.settlement.release(escrow.id)
  console.log(`    escrow status: ${released.status}, txReleaseId: ${released.txReleaseId}`)

  // Missão 07.4 — the canonical golden path's own last step (README.md's
  // "Which endpoint for which action" table: "Rate a completed trade").
  // Informational only (RFC-007 D8/D9) — never feeds the ReputationScore
  // reputation.get() returns, see that method's own SDK doc comment —
  // included anyway because a real integration ends here, and a golden
  // path that stops at release() leaves the last documented step out.
  step('Both sides rate the completed trade (reputation.rate)')
  await sellerWallet.reputation.rate({ tradeId: trade.id, ratedId: buyer.id, score: 5, comment: 'Smooth trade.' })
  await buyerWallet.reputation.rate({ tradeId: trade.id, ratedId: seller.id, score: 5, comment: 'Smooth trade.' })
  const sellerScore = await sellerWallet.reputation.get(seller.id)
  console.log(`    both sides rated; seller's own reputation.get(): totalTrades=${sellerScore.totalTrades}`)

  console.log('\nDone — full golden path completed using only @satsails/p2p-trading-sdk\'s public API.')
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err)
  console.error(`\nIs a Sails node running at ${BASE_URL}? Start one with "npm run dev" from the repo root.`)
  process.exitCode = 1
})
