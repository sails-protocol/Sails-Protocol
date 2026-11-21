import { expect } from '@playwright/test'
import { test } from '../fixtures/wallet.fixture'
import { HomePage } from '../pages/home.page'
import { CreateTradePage } from '../pages/create-trade.page'
import { TradePage } from '../pages/trade.page'

/**
 * Renamed from golden-path.spec.ts (Fase 3 reorg) — same real flow,
 * now built on the shared Page Objects/fixtures instead of inline
 * locators, no behavior change. `aliceWallet`/`bobWallet` (wallet.fixture.ts)
 * replace the old inline `browser.newContext()` calls — same dual real-
 * identity isolation, sourced from one fixture instead of duplicated
 * per spec.
 *
 * The official protocol test — CTO-directed hardening pass, 2026-07-20
 * ("testes E2E automatizados, prioridade máxima... esse teste passa a
 * ser o teste oficial do protocolo"). Drives the full golden path
 * against the real local stack: real Postgres, real Redis, the real
 * Fastify server, the real Vite-built UI. No mocked fetch, no mocked
 * WebSocket: register → publish → discover → trade → chat → escrow →
 * settle.
 *
 * Real findings from writing this test, not fixed here (already
 * registered in docs/TODO.md §22, unchanged by this rename):
 * - Trade.tsx never subscribes to escrow-status WS frames, only chat —
 *   a counterparty's escrow action never appears on an already-open tab
 *   without a fresh page load. The `TradePage.reauthenticate()` calls
 *   below model what a real user has to do today (reload, then unlock
 *   again since 2026-08-11's passphrase change), not test scaffolding
 *   around a flaky UI.
 * - liquidity.service.ts's discover() hard-caps at 10 results with no
 *   pagination — priced deliberately tiny below so this spec keeps
 *   passing regardless of how much the shared local DB has accumulated.
 */
test.setTimeout(60_000)

test('golden path: register, publish, discover, trade, chat, escrow, settle', async ({ aliceWallet: seller, bobWallet: buyer }) => {
  const sellerHome = new HomePage(seller)
  const buyerHome = new HomePage(buyer)
  const createTrade = new CreateTradePage(buyer)
  const sellerTrade = new TradePage(seller)
  const buyerTrade = new TradePage(buyer)

  // Real finding while writing this suite: PublishOffer.tsx converts BRL
  // to priceUsd via `.toFixed(2)` (illustrative FX only) — any BRL price
  // whose USD equivalent rounds to less than a cent silently becomes
  // priceUsd=0.00. A tiny price (this file's original range) collided
  // with 14 other zero-priced offers this same bug produced across this
  // suite's own earlier runs, permanently crowding discover()'s
  // unpaginated `take: 10` window (docs/TODO.md §19's already-disclosed
  // gap). This range stays cheap but keeps priceUsd meaningfully
  // non-zero.
  const priceBrl = (5 + Math.random() * 5).toFixed(4)
  const pixKey = `e2e-${Date.now()}@sailsprotocol.test`
  const chatMessage = `E2E golden path — ${Date.now()}`

  let offerId = ''
  await test.step('seller publishes a real offer (POST /v1/liquidity/offers)', async () => {
    await seller.getByRole('link', { name: 'Perfil' }).click()
    await seller.getByRole('button', { name: 'Nova Oferta' }).click()
    await expect(seller).toHaveURL('/profile/new-offer')

    await seller.getByRole('button', { name: 'Vender' }).click()
    await seller.getByRole('button', { name: 'Ativo' }).click()
    await seller.getByRole('button', { name: 'USDT (ERC-20)', exact: true }).click()
    await seller.getByPlaceholder('0').fill(priceBrl)
    await seller.getByRole('button', { name: 'Próximo' }).click()

    const amountInputs = seller.getByPlaceholder('0.00')
    await amountInputs.nth(0).fill('10')
    await amountInputs.nth(1).fill('500')
    await seller.getByPlaceholder('Sua chave PIX').fill(pixKey)
    await seller.getByRole('button', { name: 'Próximo' }).click()

    const [offerResponse] = await Promise.all([
      seller.waitForResponse((res) => res.url().includes('/v1/liquidity/offers') && res.request().method() === 'POST'),
      seller.getByRole('button', { name: 'Publicar', exact: true }).click(),
    ])
    expect(offerResponse.ok()).toBe(true)
    offerId = (await offerResponse.json()).data.id
    expect(offerId).toBeTruthy()
    await expect(seller).toHaveURL('/profile')
  })

  await test.step('buyer discovers the offer via the real Marketplace (GET /v1/liquidity/offers)', async () => {
    await buyerHome.filterByAsset('USDT_ERC20')
    await buyerHome.openOffer(offerId)
  })

  let tradeId = ''
  await test.step('buyer starts a real Trade against the discovered offer', async () => {
    tradeId = await createTrade.startTrade('20')
  })

  await test.step('seller opens the same real Trade', async () => {
    // A real navigation rather than clicking through nav — simpler test
    // setup, not a real gap: ActiveTrades.tsx/TradeHistory.tsx both link
    // to a real trade now (corrected 2026-08-04; this comment used to
    // say no in-app link existed, back when TradeHistory.tsx was still
    // MOCK_TRADE_HISTORY).
    await sellerTrade.reauthenticate(tradeId)
    await expect(sellerTrade.createEscrowButton).toBeVisible()
  })

  await test.step('real-time chat — buyer sends, seller receives over a live WebSocket, no reload', async () => {
    // Real finding, registered in docs/TODO.md §22, not fixed here:
    // ChatWindow.tsx's connection indicator is static markup, not tied
    // to the WebSocket's actual readyState — no real signal exists that
    // the chat channel finished connecting. This wait stands in for that
    // missing signal.
    await seller.waitForTimeout(1000)
    await buyerTrade.sendMessage(chatMessage)
    await expect(seller.getByText(chatMessage)).toBeVisible({ timeout: 10_000 })
  })

  await test.step('seller creates and locks escrow', async () => {
    await sellerTrade.createEscrow()
    await sellerTrade.lockFunds()
  })

  await test.step("buyer sees the locked escrow and the seller's PIX details, marks payment sent", async () => {
    await buyerTrade.reauthenticate(tradeId) // no live WS push for escrow status yet — see this file's header
    await expect(buyer.getByText(pixKey)).toBeVisible()
    await buyerTrade.markPaymentSent()
  })

  await test.step('seller releases funds — real WdkSettlementProvider/MockSettlementProvider call, trade completes', async () => {
    await sellerTrade.reauthenticate(tradeId)
    await sellerTrade.releaseFunds()
    await expect(seller.getByText('Concluído').first()).toBeVisible({ timeout: 10_000 })
  })
})
