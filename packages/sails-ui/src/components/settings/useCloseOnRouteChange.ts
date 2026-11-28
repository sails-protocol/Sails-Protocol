import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'

/** Closes an open dialog when the address changes under it (Back, or a link to another ?section=). */
export function useCloseOnRouteChange(open: boolean, close: () => void) {
  const { pathname, search, hash } = useLocation()
  const where = pathname + search + hash
  const shownAt = useRef(where)
  useEffect(() => {
    if (!open) { shownAt.current = where; return }
    if (where !== shownAt.current) close()
    // close is a fresh closure each render; only the address matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [where, open])
}
