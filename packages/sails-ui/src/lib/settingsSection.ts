/** Configurações deep link: `?section=<id>`. Absent or unknown id → the first section (Wallet). */
export function sectionFromSearch(search: string | URLSearchParams, ids: readonly string[]): { id: string; fromUrl: boolean } {
  const value = (typeof search === 'string' ? new URLSearchParams(search) : search).get('section')
  return value && ids.includes(value) ? { id: value, fromUrl: true } : { id: ids[0], fromUrl: false }
}
