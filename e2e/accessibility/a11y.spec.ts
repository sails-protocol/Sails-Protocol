import AxeBuilder from '@axe-core/playwright'
import { expect } from '@playwright/test'
import { test } from '../fixtures/sails.fixture'
import { WalletPage } from '../pages/wallet.page'

/**
 * WCAG 2.1 AA via the real running UI (localhost:5173), not a static
 * fixture. Covers every page reachable with a single connected identity:
 * Login (unauthenticated), Marketplace ('/'), Profile, and OfferDetail
 * (a real offer, published here). Trade ('/trade/:id') is not scanned
 * here — it needs a full two-party setup (see e2e/flows/*) and its
 * interactive primitives (buttons, badges) are the same ones already
 * exercised on the pages below; re-running a second full trade setup
 * just for an a11y pass would be disproportionate. A future pass could
 * extend this using wallet.fixture.ts if Trade-specific violations turn
 * up elsewhere.
 */
test.describe('Accessibility — WCAG 2.1 AA', () => {
  test('Login page has no WCAG 2.1 AA violations', async ({ page }) => {
    await page.goto('/login')
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
  })

  test('Marketplace (home) has no WCAG 2.1 AA violations', async ({ authenticatedPage: page }) => {
    // A bare page.goto() here would be a real navigation, wiping the
    // session the fixture just established (2026-08-11: no more silent
    // restore-on-mount — see WalletPage.connectAndGoTo()'s own header).
    // Marketplace itself wouldn't crash logged-out, but this test is
    // specifically meant to scan the authenticated render.
    await new WalletPage(page).connectAndGoTo('/')
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
  })

  test('Profile has no WCAG 2.1 AA violations', async ({ authenticatedPage: page }) => {
    // Profile.tsx force-redirects to /login on a lost session
    // (`if (!user) navigate('/login', { state: { from: '/profile' } })`).
    // A bare page.goto('/profile') wipes the session (no silent
    // re-authenticate-on-mount since 2026-08-11) and would just bounce
    // straight back to /login — this drives that real redirect-then-
    // return round trip instead of a broken connectAndGoTo() shortcut
    // (real bug found running this spec: connectAndGoTo() re-
    // authenticates FIRST then hard-navigates SECOND, wiping the session
    // it just established — see its own header).
    await page.goto('/profile')
    await new WalletPage(page).completeLogin()
    await expect(page).toHaveURL('/profile')
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
  })

  test('OfferDetail has no WCAG 2.1 AA violations', async ({ authenticatedPage: page }) => {
    await page.getByRole('link', { name: 'Perfil' }).click()
    await page.getByRole('button', { name: 'Nova Oferta' }).click()
    await page.getByRole('button', { name: 'Vender' }).click()
    await page.getByRole('button', { name: 'Ativo' }).click()
    await page.getByRole('button', { name: 'USDT (ERC-20)', exact: true }).click()
    // See e2e/flows/p2p-trade-happy-path.spec.ts's header comment on the
    // tiny-BRL-price → priceUsd=0.00 rounding bug this range avoids.
    await page.getByPlaceholder('0').fill((5 + Math.random() * 5).toFixed(4))
    await page.getByRole('button', { name: 'Próximo' }).click()
    const amountInputs = page.getByPlaceholder('0.00')
    await amountInputs.nth(0).fill('10')
    await amountInputs.nth(1).fill('500')
    await page.getByPlaceholder('Sua chave PIX').fill(`e2e-a11y-${Date.now()}@sailsprotocol.test`)
    await page.getByRole('button', { name: 'Próximo' }).click()
    const [offerResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/v1/liquidity/offers') && res.request().method() === 'POST'),
      page.getByRole('button', { name: 'Publicar', exact: true }).click(),
    ])
    const offerId = (await offerResponse.json()).data.id

    await new WalletPage(page).connectAndGoTo(`/offer/${offerId}`)
    const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()
    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([])
  })
})

test.describe('Accessibility — keyboard navigation', () => {
  test('Login: the wallet-connect button is reachable and activatable via keyboard alone', async ({ page }) => {
    await page.goto('/login')
    const connectButton = page.getByRole('button', { name: 'Conectar Carteira' })
    // A passphrase is required since 2026-08-11 (real gap fixed: the
    // identity/escrow keys used to sit in localStorage as plain hex) —
    // filled directly rather than via keyboard, since this test's own
    // purpose is proving the CONNECT BUTTON is keyboard-reachable, not
    // re-testing the password field's own operability.
    await page.locator('input[type="password"]').fill('e2e-test-passphrase')

    // Tab from a clean slate until the connect button itself receives
    // focus, rather than asserting a specific tab-index count (brittle
    // against unrelated layout changes) — proves it's actually reachable
    // by keyboard, not just present in the DOM.
    let reached = false
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab')
      if (await connectButton.evaluate((el) => el === document.activeElement)) {
        reached = true
        break
      }
    }
    expect(reached).toBe(true)

    await page.keyboard.press('Enter')
    await expect(page).toHaveURL('/')
  })

  test('Marketplace: asset filter is operable via keyboard', async ({ authenticatedPage: page }) => {
    await new WalletPage(page).connectAndGoTo('/')
    const allAssetsButton = page.getByRole('button', { name: 'Ativo' })
    await allAssetsButton.focus()
    await expect(allAssetsButton).toBeFocused()
    await page.keyboard.press('Enter')
    // Opening the picker must expose at least one selectable asset option via keyboard.
    await expect(page.getByRole('button', { name: 'USDT (ERC-20)', exact: true })).toBeVisible()
  })
})

test.describe('Accessibility — ARIA labels on real interactive elements', () => {
  test('every button on Login and Marketplace has an accessible name', async ({ authenticatedPage: page }) => {
    await page.goto('/login')
    for (const button of await page.getByRole('button').all()) {
      // toHaveAccessibleName() requires an expected value — asserting
      // "not empty" this way (rather than a specific string) is the
      // correctly-typed way to check every button has *some* real name.
      await expect(button).not.toHaveAccessibleName('')
    }

    await page.goto('/')
    for (const button of await page.getByRole('button').all()) {
      await expect(button).not.toHaveAccessibleName('')
    }
  })
})
