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
   * The asset list is the Combobox primitive (2026-11-20): options are
   * role="option" named by `ASSET_LABELS[asset]`, and each carries the raw
   * `AssetType` code as `data-value`, the stable hook this helper's callers
   * want (OfferCard badges never carry it).
   */
  assetButton(asset: string): Locator {
    return this.page.locator(`[role="option"][data-value="${asset}"]`)
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
