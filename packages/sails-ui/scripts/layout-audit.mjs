#!/usr/bin/env node
/**
 * Sails UI layout audit (plan item 4.4, issue #746). Opens the running dev server in demo mode and checks every
 * main screen at every width, in both themes and both menu positions (optionally in every language):
 *   - no horizontal page scroll;
 *   - no text cut by an ellipsis (except monospace identifiers, which truncate on purpose);
 *   - no text pushed off screen outside a scroll container;
 *   - below 768px, interactive controls at least 44px tall when the pointer is coarse (touch).
 *
 * Usage (from the repository root, with the Sails UI dev server running):
 *   node packages/sails-ui/scripts/layout-audit.mjs [--base http://localhost:5173] [--quick] [--locales]
 *     --quick    1440, 834, 375 and 320 only
 *     --locales  also run pt-BR, en, es, fr and de (default: pt-BR only)
 * Exits with code 1 when any check fails and prints the failing screen/width/theme/menu/locale.
 * Uses its own browser; it never touches an existing browser tab.
 */
import { chromium } from '@playwright/test'

const args = process.argv.slice(2)
const arg = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback }
const BASE = arg('--base', 'http://localhost:5173')
const WIDTHS = args.includes('--quick') ? [1440, 834, 375, 320] : [1440, 1366, 1280, 1152, 1024, 900, 768, 640, 414, 375, 320]
const LOCALES = args.includes('--locales') ? ['pt-BR', 'en', 'es', 'fr', 'de'] : ['pt-BR']
const THEMES = ['dark', 'light']
const MENUS = ['side', 'top']

// Main screens reachable by URL. Flows with steps (wizards, dialogs) are covered by each lot's own audit.
const ROUTES = [
  '/', '/trades', '/trades/history', '/trades/offers', '/trades/disputes', '/profile',
  '/markets', '/markets/mine', '/markets/new', '/markets/join',
  '/settings?section=wallet', '/settings?section=aparencia', '/settings?section=idioma',
  '/settings?section=notificacoes', '/settings?section=seguranca', '/settings?section=no-sails',
  '/settings?section=comunidades', '/settings?section=ajuda',
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Client-side navigation keeps the in-memory demo session (a full reload would drop it).
const go = async (page, url) => { await page.evaluate((u) => { history.pushState(null, '', u); dispatchEvent(new PopStateEvent('popstate')) }, url); await sleep(400) }

async function signInDemo(page) {
  await page.goto(`${BASE}/?demo=1`)
  await page.waitForLoadState('networkidle').catch(() => {})
  await go(page, '/login')
  const local = page.getByRole('button', { name: /Chave local|Local key|Clave local|Clé locale|Lokaler Schlüssel/i })
  if (await local.count()) {
    await local.first().click()
    const pw = page.locator('input[type=password]')
    // Fixed demo passphrase: demo mode runs only in development and sends nothing to a Sails node.
    for (let i = 0; i < await pw.count(); i++) await pw.nth(i).fill('demo-audit-pass')
    // Enter submits the form in every language, whatever the button copy says.
    await pw.last().press('Enter')
    await sleep(1500)
  }
  for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await sleep(120) }
}

async function check(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth
    const coarse = matchMedia('(pointer: coarse)').matches
    const out = { scroll: document.documentElement.scrollWidth > vw + 1, truncated: [], offscreen: [], small: [] }
    const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !el.closest('.sr-only,[aria-hidden=true]') }
    for (const el of document.body.querySelectorAll('*')) {
      if (!visible(el)) continue
      const cs = getComputedStyle(el)
      const txt = (el.innerText || '').trim().slice(0, 40)
      if (!txt) continue
      if (cs.textOverflow === 'ellipsis' && !el.closest('.font-mono,.mono-id') && el.scrollWidth > el.clientWidth + 1) out.truncated.push(txt)
      const r = el.getBoundingClientRect()
      if ((r.right > vw + 1 || r.left < -1) && el.children.length === 0) {
        let p = el.parentElement, inScroller = false
        while (p && p !== document.body) { const ox = getComputedStyle(p).overflowX; if (ox === 'auto' || ox === 'scroll') { inScroller = true; break } p = p.parentElement }
        if (!inScroller) out.offscreen.push(txt)
      }
    }
    if (vw < 768 && coarse) for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), textarea, [role=tab]')) {
      if (!visible(el)) continue
      if (el.matches('input[type=radio], input[type=checkbox]') && el.closest('label')) continue // the label is the target
      const h = el.getBoundingClientRect().height
      if (h < 44) out.small.push(`${(el.getAttribute('aria-label') || el.innerText || el.tagName).trim().slice(0, 24)}:${Math.round(h)}`)
    }
    for (const k of ['truncated', 'offscreen', 'small']) out[k] = [...new Set(out[k])].slice(0, 6)
    return out
  })
}

const failures = []
let total = 0
const browser = await chromium.launch()
try {
  for (const locale of LOCALES) for (const theme of THEMES) for (const menu of MENUS) {
    for (const touch of [false, true]) {
      const widths = touch ? WIDTHS.filter((w) => w < 768) : WIDTHS
      if (!widths.length) continue
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, hasTouch: touch, isMobile: touch })
      await ctx.addInitScript(([m, t, l]) => {
        try {
          for (const [st, pre] of [[localStorage, ''], [sessionStorage, 'sails_demo_shadow:']]) {
            st.setItem(pre + 'sails_ui_nav_position', m); st.setItem(pre + 'sails_ui_theme', t)
            st.setItem(pre + 'sails_ui_locale', l); st.setItem(pre + 'sails_ui_onboarding_seen', 'true')
          }
        } catch { /* storage blocked: defaults apply */ }
      }, [menu, theme, locale])
      const page = await ctx.newPage()
      await signInDemo(page)
      for (const width of widths) {
        await page.setViewportSize({ width, height: 900 })
        for (const route of ROUTES) {
          await go(page, route)
          const r = await check(page)
          total++
          if (r.scroll || r.truncated.length || r.offscreen.length || r.small.length) failures.push({ route, width, theme, menu, locale, touch, ...r })
        }
      }
      await ctx.close()
    }
  }
} finally {
  await browser.close()
}

console.log(`Layout audit: ${total - failures.length}/${total} ok`)
for (const f of failures) console.log(`FAIL ${f.route} ${f.width}px ${f.theme} ${f.menu} ${f.locale}${f.touch ? ' touch' : ''}`, JSON.stringify({ scroll: f.scroll, truncated: f.truncated, offscreen: f.offscreen, small: f.small }))
process.exit(failures.length ? 1 : 0)
