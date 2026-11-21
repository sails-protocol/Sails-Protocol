import { type Page, type Locator, expect } from '@playwright/test'

/**
 * App.tsx's actual home route is `/` → <Marketplace /> (the offer
 * discovery/listing screen) — there's no separate "home" page, so this
 * wraps Marketplace under the name the brief asked for.
 */
export class HomePage {
  constructor(private readonly page: Page) {}

  async goto(): Promise<void> {
    await this.page.goto('/')
  }

  /**
   * The trigger's accessible name is "Ativo" (AssetPicker.tsx's
   * `aria-label`), not its visible text "Todos os ativos" — an
   * `aria-label` overrides text-content in accessible-name computation.
   * Matching by role name here (not the currently-displayed value) is
   * also the more stable selector: the visible text changes once an
   * asset is selected, the aria-label never does.
   */
  get allAssetsButton(): Locator {
    return this.page.getByRole('button', { name: 'Ativo' })
  }

  /**
   * `title` alone isn't enough: AssetPicker.tsx's own option buttons
   * render `ASSET_LABELS[asset]` as visible text/accessible name (e.g.
   * "USDT (ERC-20)"), not the raw `AssetType` code this method takes —
   * but each option button also carries `title={asset}` (the raw code),
   * which is the stable hook this helper's callers actually want.
   * However every OfferCard row on the SAME page also renders a
   * `<span title={asset}>` asset badge (inside an `<a>`, not a
   * `<button>`) — matching on `title` alone hits both and throws a
   * strict-mode violation. `.and()` narrows to elements satisfying both
   * conditions on the same node, which only the real dropdown option is.
   */
  assetButton(asset: string): Locator {
    return this.page.getByRole('button').and(this.page.getByTitle(asset, { exact: true }))
  }

  async filterByAsset(asset: string): Promise<void> {
    await this.allAssetsButton.click()
    await this.assetButton(asset).click()
  }

  offerLink(offerId: string): Locator {
    return this.page.locator(`a[href="/offer/${offerId}"]`)
  }

  async openOffer(offerId: string): Promise<void> {
    const link = this.offerLink(offerId)
    await expect(link).toBeVisible({ timeout: 15_000 })
    await link.click()
    await expect(this.page).toHaveURL(`/offer/${offerId}`)
  }
}
