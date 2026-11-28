/**
 * Layer A: focus return for Dialog and Sheet. Radix returns focus only to a `<DialogTrigger>`; a dialog opened
 * from state (`open` + `onOpenChange`) sent focus to BODY, and WebKit never focuses a tapped button, so even the
 * focused-element fallback landed on MAIN. The content records its opener when it opens (the focused control,
 * else the control last pressed) and focuses it again on close. A command inside a menu resolves to the menu's
 * trigger, since the menu is gone by then.
 */
import * as React from 'react'

const OPENER = 'button, a[href], input, select, textarea, summary, [role=button], [role=menuitem], [role=tab], [role=switch], [tabindex]:not([tabindex="-1"])'

let lastPressed: HTMLElement | null = null
// Open dialog content -> its opener.
const openers = new WeakMap<Element, HTMLElement | null>()

function resolve(el: HTMLElement | null): HTMLElement | null {
  const menu = el?.closest<HTMLElement>('[role=menu]')
  if (menu?.id) return document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`) ?? el
  return el
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    const t = e.target instanceof Element ? e.target.closest<HTMLElement>(OPENER) : null
    lastPressed = resolve(t)
  }, true)
}

function currentOpener(): HTMLElement | null {
  const a = document.activeElement
  if (a instanceof HTMLElement && a !== document.body && a.matches(OPENER)) return resolve(a)
  return lastPressed?.isConnected ? lastPressed : null
}

/** Handlers for a Radix Dialog/Sheet Content: compose with the caller's own, which still win when they preventDefault. */
export function useOpenerFocus(props: { onOpenAutoFocus?: (e: Event) => void; onCloseAutoFocus?: (e: Event) => void }) {
  // [opener, the opener of the dialog it sat in]: a dialog opened from another one that closes on the way
  // ("Filtros avançados" in the mobile filter sheet) gives focus back to where the first one was opened.
  const opener = React.useRef<(HTMLElement | null)[]>([])
  return {
    // Fires on mount, before focus moves into the content: the opener is still the focused (or last pressed) control.
    onOpenAutoFocus: (e: Event) => {
      const o = currentOpener()
      const parent = o?.closest('[role=dialog]')
      opener.current = [o, (parent && openers.get(parent)) ?? null]
      if (e.target instanceof Element) openers.set(e.target, o)
      props.onOpenAutoFocus?.(e)
    },
    onCloseAutoFocus: (e: Event) => {
      props.onCloseAutoFocus?.(e)
      if (e.defaultPrevented) return
      const o = opener.current.find((el) => el?.isConnected)
      opener.current = []
      if (o) {
        e.preventDefault()
        o.focus()
      }
    },
  }
}
