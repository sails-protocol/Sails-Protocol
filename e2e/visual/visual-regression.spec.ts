import { devices, expect } from '@playwright/test'
import { test } from '../fixtures/wallet.fixture'
import { HomePage } from '../pages/home.page'
import { CreateTradePage } from '../pages/create-trade.page'
import { TradePage } from '../pages/trade.page'

/**
 * No `TradeCard` component exists in packages/sails-ui (that's
 * @satsails/sdk-react — a separate package for third-party integrators,
 * not what this running app renders). The real analog here is the
 * Trade page itself (`/trade/:id`) across its real Trade+Escrow state
 * progression, plus the real Marketplace `OfferCard` component for the
 * listing side — both snapshotted below instead of a component that
 * doesn't exist in this app. Confirmed by grep before writing this file.
 *
 * First run has no baseline yet — `npx playwright test --config=e2e/playwright.config.ts --project=visual --update-snapshots`
 * establishes it; subsequent runs compare against that baseline (the
 * acceptance criterion's "snapshots visuais estáveis").
 */
test.setTimeout(90_000)

test.describe('Marketplace — OfferCard states', () => {
  test('marketplace listing, light mode, desktop', async ({ aliceWallet: seller, bobWallet: viewer }) => {
    // See e2e/flows/p2p-trade-happy-path.spec.ts's header comment on the
    // tiny-BRL-price → priceUsd=0.00 rounding bug this range avoids.
    const priceBrl = (5 + Math.random() * 5).toFixed(4)
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
    await seller.getByPlaceholder('Sua chave PIX').fill(`e2e-visual-${Date.now()}@sailsprotocol.test`)
    await seller.getByRole('button', { name: 'Próximo' }).click()
    await Promise.all([
      seller.waitForResponse((res) => res.url().includes('/v1/liquidity/offers') && res.request().method() === 'POST'),
      seller.getByRole('button', { name: 'Publicar', exact: true }).click(),
    ])

    // No viewerHome.goto() here — bobWallet already lands `viewer` on
    // '/' (WalletPage.connect()'s own end state), and a real navigation
    // to the SAME url would still reload and wipe that session
    // (2026-08-11: no more silent restore-on-mount).
    const viewerHome = new HomePage(viewer)
    await viewerHome.filterByAsset('USDT_ERC20')
    await expect(viewer).toHaveScreenshot('marketplace-usdt-listing-light.png', { maxDiffPixelRatio: 0.02 })
  })

  test('marketplace listing, dark mode', async ({ bobWallet: viewer }) => {
    // bobWallet already lands `viewer` on '/' — no goto() needed (see
    // this describe block's first test for why one would be destructive).
    await viewer.getByRole('button', { name: 'Alternar tema' }).click()
    await expect(viewer).toHaveScreenshot('marketplace-dark-mode.png', { maxDiffPixelRatio: 0.02 })
  })
})

test.describe('Marketplace — mobile responsive', () => {
  // Only `viewport` (not the full device descriptor) — spreading a whole
  // `devices[...]` entry here includes `defaultBrowserType`, which
  // Playwright refuses to override below the top level (it would force
  // a different browser engine per describe block, which needs its own
  // project, not a describe-scoped `test.use()`). The acceptance
  // criterion is real responsive layout at these viewport sizes, not
  // literally which rendering engine draws them.
  test.use({ viewport: devices['iPhone SE'].viewport })
  test('iPhone SE viewport', async ({ bobWallet: viewer }) => {
    // bobWallet already lands `viewer` on '/' — see the first test in
    // this file's own comment on why a goto() here would be destructive.
    await expect(viewer).toHaveScreenshot('marketplace-mobile-iphone-se.png', { maxDiffPixelRatio: 0.02 })
  })
})

test.describe('Marketplace — mobile responsive (Pixel 5)', () => {
  test.use({ viewport: devices['Pixel 5'].viewport })
  test('Pixel 5 viewport', async ({ bobWallet: viewer }) => {
    await expect(viewer).toHaveScreenshot('marketplace-mobile-pixel-5.png', { maxDiffPixelRatio: 0.02 })
  })
})

test.describe('Trade page — real Trade+Escrow state progression', () => {
  test('snapshots at each real state transition', async ({ aliceWallet: seller, bobWallet: buyer }) => {
    const createTrade = new CreateTradePage(buyer)
    const sellerTrade = new TradePage(seller)
    const buyerTrade = new TradePage(buyer)
    // See e2e/flows/p2p-trade-happy-path.spec.ts's header comment on the
    // tiny-BRL-price → priceUsd=0.00 rounding bug this range avoids.
    const priceBrl = (5 + Math.random() * 5).toFixed(4)

    let offerId = ''
    let tradeId = ''
    await test.step('setup: seller publishes, buyer starts a trade', async () => {
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
      await seller.getByPlaceholder('Sua chave PIX').fill(`e2e-visual-trade-${Date.now()}@sailsprotocol.test`)
      await seller.getByRole('button', { name: 'Próximo' }).click()
      const [offerResponse] = await Promise.all([
        seller.waitForResponse((res) => res.url().includes('/v1/liquidity/offers') && res.request().method() === 'POST'),
        seller.getByRole('button', { name: 'Publicar', exact: true }).click(),
      ])
      offerId = (await offerResponse.json()).data.id
      // Direct navigation, not Marketplace discovery — see
      // create-trade.page.ts's startTradeDirect() header comment; this
      // spec snapshots Trade page states, not the marketplace search UX.
      tradeId = await createTrade.startTradeDirect(offerId, '20')
    })

    // Trade.tsx renders a real UUID prefix ("Trade #xxxxxxx") that's
    // different every run by construction — masked out, not something
    // any run could ever match against a fixed baseline.
    const tradeIdMask = [seller.locator('span.font-mono.text-sm.text-brand-text-muted')]

    await sellerTrade.reauthenticate(tradeId)
    await expect(seller).toHaveScreenshot('trade-pending-no-escrow.png', { maxDiffPixelRatio: 0.02, mask: tradeIdMask })

    await sellerTrade.createEscrow()
    await expect(seller).toHaveScreenshot('trade-escrow-created.png', { maxDiffPixelRatio: 0.02, mask: tradeIdMask })

    await sellerTrade.lockFunds()
    await expect(seller).toHaveScreenshot('trade-escrow-funds-locked.png', { maxDiffPixelRatio: 0.02, mask: tradeIdMask })

    await buyerTrade.reauthenticate(tradeId)
    await buyerTrade.markPaymentSent()
    await expect(buyer).toHaveScreenshot('trade-escrow-payment-pending.png', {
      maxDiffPixelRatio: 0.02,
      mask: [buyer.locator('span.font-mono.text-sm.text-brand-text-muted')],
    })

    await sellerTrade.reauthenticate(tradeId)
    await sellerTrade.releaseFunds()
    await expect(seller).toHaveScreenshot('trade-completed.png', { maxDiffPixelRatio: 0.02, mask: tradeIdMask })
  })
})
