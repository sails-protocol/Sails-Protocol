import { expect, mergeTests } from '@playwright/test'
import { test as walletTest } from '../fixtures/wallet.fixture'
import { test as settlementTest } from '../fixtures/settlement.fixture'
import { WalletPage } from '../pages/wallet.page'

const test = mergeTests(walletTest, settlementTest)

/**
 * Real "timeout" enforcement this codebase actually has today is at the
 * Intent level (RFC-018/core/state-machine.ts's isExpired()), not on an
 * active Escrow's timelockHours — Escrow itself has no expiry check
 * anywhere (confirmed by grep before writing this). And nothing in any
 * real request path ever sets Intent.expiresAt (also confirmed by
 * grep) — the field only gets read, so in real day-to-day use
 * isExpired() is dead code today. Both findings, and the decision to
 * test this via direct DB seeding rather than skip it or build the
 * missing sweeper, were confirmed with the user before writing this file.
 *
 * The real mechanism under test (core/intent-engine.ts's transition(),
 * PROTOCOL_SPECIFICATION.md's CISO Byzantine "Free Option" rule): an
 * Offer's Intent is created at CREATED, then immediately auto-advanced
 * to COORDINATED (RFC-012's CREATED→VALIDATED→COORDINATED, run inline
 * by intentEngine.create() itself — confirmed empirically here, not
 * assumed) where it sits until a Trade is started against it, which
 * drives the Intent through DISCOVERING → MATCHED → NEGOTIATING. If
 * that Intent's expiresAt has passed by the time a Trade is attempted,
 * the engine must reject the COORDINATED → DISCOVERING transition,
 * force the Intent to EXPIRED itself (not just refuse the caller), and
 * the trade-creation call must fail — exactly the "no free option to
 * hold terms open past the window" guarantee the code comment describes.
 */
test.setTimeout(30_000)

test('timeout: an Intent whose window closed rejects trade creation and flips to EXPIRED', async ({ aliceWallet: seller, bobWallet: buyer, db }) => {
  // See p2p-trade-happy-path.spec.ts's header comment on the
  // tiny-BRL-price → priceUsd=0.00 rounding bug this range avoids.
  const priceBrl = (5 + Math.random() * 5).toFixed(4)

  let offerId = ''
  await test.step('seller publishes a real offer (creates a real Intent, auto-advanced to COORDINATED)', async () => {
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
    await seller.getByPlaceholder('Sua chave PIX').fill(`e2e-timeout-${Date.now()}@sailsprotocol.test`)
    await seller.getByRole('button', { name: 'Próximo' }).click()

    const [offerResponse] = await Promise.all([
      seller.waitForResponse((res) => res.url().includes('/v1/liquidity/offers') && res.request().method() === 'POST'),
      seller.getByRole('button', { name: 'Publicar', exact: true }).click(),
    ])
    offerId = (await offerResponse.json()).data.id
    expect(offerId).toBeTruthy()
  })

  let intentId = ''
  await test.step("seed that Intent's expiresAt in the past, directly in Postgres", async () => {
    const offer = await db.offer.findUniqueOrThrow({ where: { id: offerId } })
    expect(offer.intentId).toBeTruthy()
    intentId = offer.intentId as string

    const before = await db.intent.findUniqueOrThrow({ where: { id: intentId } })
    expect(before.status).toBe('COORDINATED')

    await db.intent.update({ where: { id: intentId }, data: { expiresAt: new Date(Date.now() - 60_000) } })
  })

  await test.step('buyer attempts to start a trade — the underlying COORDINATED → DISCOVERING transition is rejected', async () => {
    // Direct navigation, not Marketplace discovery — see
    // create-trade.page.ts's startTradeDirect() header comment; this
    // spec is about trade-creation rejection, not the marketplace
    // search UX. A real navigation wipes the session established by the
    // bobWallet fixture (2026-08-11: no more silent restore-on-mount —
    // see WalletPage.connect()'s own header), so this has to
    // re-authenticate rather than just goto() — driving OfferDetail.tsx's
    // own real "logged out → Iniciar Trade → bounced to /login → back
    // here" affordance directly, same as CreateTradePage.startTradeDirect()
    // (not reused here since this spec needs the raw rejected response,
    // not startTradeDirect()'s success-only return type).
    await buyer.goto(`/offer/${offerId}`)
    await buyer.getByPlaceholder('0.00').fill('20')
    await buyer.getByRole('button', { name: 'Iniciar Trade' }).click()
    await new WalletPage(buyer).completeLogin()
    await expect(buyer).toHaveURL(new RegExp(`/offer/${offerId}$`))
    await buyer.getByPlaceholder('0.00').fill('20')
    const [tradeResponse] = await Promise.all([
      buyer.waitForResponse((res) => res.url().includes('/v1/openp2p/trades') && res.request().method() === 'POST'),
      buyer.getByRole('button', { name: 'Iniciar Trade' }).click(),
    ])
    // The real engine rejects this — not a 2xx, and not a browser-level
    // crash: a clean, understood error response.
    expect(tradeResponse.ok()).toBe(false)
    expect(tradeResponse.status()).toBeLessThan(500)
  })

  await test.step('the Intent itself was force-expired server-side, not just the caller refused', async () => {
    const after = await db.intent.findUniqueOrThrow({ where: { id: intentId } })
    expect(after.status).toBe('EXPIRED')
  })
})
