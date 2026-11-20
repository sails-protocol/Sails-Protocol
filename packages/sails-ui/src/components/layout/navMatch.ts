/**
 * Active-state rule for a nav entry: `end` means exact match, otherwise
 * the path or any child path; `also` lists sibling routes the entry owns
 * (Sidebar's "Trades" covers both /profile/active and /profile/history).
 */
export function isNavActive(pathname: string, item: { to: string; end?: boolean; also?: readonly string[] }): boolean {
  const matches = (to: string, end?: boolean) => pathname === to || (!end && to !== '/' && pathname.startsWith(`${to}/`))
  return matches(item.to, item.end) || (item.also ?? []).some((to) => matches(to))
}
