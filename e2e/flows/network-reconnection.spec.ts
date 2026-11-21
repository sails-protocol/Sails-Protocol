import { expect } from '@playwright/test'
import { test } from '../fixtures/wallet.fixture'
import { CreateTradePage } from '../pages/create-trade.page'
import { TradePage } from '../pages/trade.page'

/**
 * Real finding, checked directly against Trade.tsx before writing this
 * (confirmed with the user's own established precedent of documenting
 * — not silently working around — gaps like this in this suite): the
 * chat WebSocketChannel is opened exactly once (`channelRef.current`)
 * with no `onclose`/retry handler anywhere. There is no client-side
 * auto-reconnect to test. RFC-011's "P2P reconciliation on peer
 * reconnect" is a backend-to-backend (PearNode/relay) protocol concern,
 * not something a browser-driven Playwright test can observe directly.
 *
 * So "trade sobrevive a disconnect/reconnect" is tested against what
 * actually provides that resilience here: all real state (Trade,
 * Escrow, Message rows) lives server-side in Postgres, so a network
 * interruption can't lose it — and a page reload (the same recovery
 * mechanism this suite's other specs already rely on for escrow-status
 * updates, since there's no live WS push for those either) re-syncs
 * everything from scratch. That reload-to-resync path is the real
 * "survives disconnect/reconnect" guarantee this app has today.
 */
test.setTimeout(60_000)

test('network reconnection: state and messages survive a real offline/online cycle via reload', async ({ aliceWallet: seller, bobWallet: buyer }) => {
  const createTrade = new CreateTradePage(buyer)
  const sellerTrade = new TradePage(seller)
  const buyerTrade = new TradePage(buyer)

  // See p2p-trade-happy-path.spec.ts's header comment on the
  // tiny-BRL-price → priceUsd=0.00 rounding bug this range avoids.
  const priceBrl = (5 + Math.random() * 5).toFixed(4)
  const offlineMessage = `sent-while-buyer-offline-${Date.now()}`

  let offerId = ''
  await test.step('seller publishes a real offer', async () => {
    await seller.getByRole('link', { name: 'Perfil' }).click()
    await seller.getByRole('button', { name: 'Nova Oferta' }).click()
    await seller.getByRole('button', { name: 'Vender' }).click()
    await seller.getByRole('button', { name: 'Ativo' }).click()
    await seller.getByRole('button', { name: 'USDT (ERC-20)', exact: true }).click()
    await seller.getByPlaceholder('0').fill(priceBrl)
    await seller.getByRole('button', { name: 'Próximo' }).click()

    const amountInputs = seller.getByPlaceholder('0.00')
    await amountInputs.nth(0).fill('10')
    await amountInputs.nth(1).fill('500')
    await seller.getByPlaceholder('Sua chave PIX').fill(`e2e-reconnect-${Date.now()}@sailsprotocol.test`)
    await seller.getByRole('button', { name: 'Próximo' }).click()

    const [offerResponse] = await Promise.all([
      seller.waitForResponse((res) => res.url().includes('/v1/liquidity/offers') && res.request().method() === 'POST'),
      seller.getByRole('button', { name: 'Publicar', exact: true }).click(),
    ])
    offerId = (await offerResponse.json()).data.id
    expect(offerId).toBeTruthy()
  })

  let tradeId = ''
  await test.step('buyer starts a real trade against the offer (direct navigation — see create-trade.page.ts on why)', async () => {
    tradeId = await createTrade.startTradeDirect(offerId, '20')
  })

  await test.step('seller opens the trade and creates escrow', async () => {
    await sellerTrade.reauthenticate(tradeId)
    await sellerTrade.createEscrow()
  })

  await test.step("buyer goes offline (context.setOffline), then seller sends a real message and locks funds", async () => {
    await buyer.context().setOffline(true)

    // Same real gap p2p-trade-happy-path.spec.ts's header comment
    // documents: no signal exists that the chat WS channel finished its
    // JOIN_TRADE handshake, so a message sent immediately after opening
    // the page can be silently dropped. This wait stands in for that
    // missing signal — not padding, a workaround for a real gap.
    await seller.waitForTimeout(1000)

    // These real, server-side actions happen while the buyer's browser
    // is genuinely offline (not merely "not looking") — the point is
    // that neither is lost.
    await sellerTrade.sendMessage(offlineMessage)
    await sellerTrade.lockFunds()
  })

  await test.step('buyer comes back online and reloads — no auto-reconnect exists, so this models what a real user has to do today', async () => {
    await buyer.context().setOffline(false)
    await buyerTrade.reauthenticate(tradeId)

    // The message sent during the outage was never lost server-side —
    // it's in the REST chat history the fresh page load fetches.
    await expect(buyer.getByText(offlineMessage)).toBeVisible({ timeout: 10_000 })

    // Escrow state the seller changed while the buyer was offline is
    // likewise fully resynced, not partially stale.
    await expect(buyerTrade.markPaymentSentButton).toBeVisible({ timeout: 10_000 })
  })
})
