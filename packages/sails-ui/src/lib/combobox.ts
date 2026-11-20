/**
 * Combobox logic (DESIGN_SYSTEM.md 5.11): search matching and active-option
 * movement, pure so the pickers' filtering and keyboard behavior are tested.
 */

/** Lowercase, no accents: "Maré" matches "mare", "Ação" matches "acao". */
export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** Options whose value or any of the given texts contains the query (accent- and case-insensitive). */
export function filterOptions<T extends { value: string; label: string; keywords?: readonly string[] }>(options: readonly T[], query: string): T[] {
  const q = normalize(query)
  if (!q) return [...options]
  return options.filter((o) => [o.value, o.label, ...(o.keywords ?? [])].some((t) => normalize(t).includes(q)))
}

/** Next active index for a key, skipping nothing (the list holds only enabled options). -1 = none. */
export function moveActive(index: number, count: number, key: 'ArrowDown' | 'ArrowUp' | 'Home' | 'End'): number {
  if (count === 0) return -1
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count
  return index < 0 ? count - 1 : (index - 1 + count) % count
}

/** Typeahead for menus: first item after `from` whose label starts with `query`, wrapping. -1 = none. */
export function typeaheadIndex(labels: readonly string[], query: string, from: number): number {
  const q = normalize(query)
  if (!q) return -1
  for (let step = 1; step <= labels.length; step++) {
    const i = (from + step) % labels.length
    if (normalize(labels[i]).startsWith(q)) return i
  }
  return -1
}
