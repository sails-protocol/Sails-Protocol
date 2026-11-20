/**
 * Demo-mode markers, read only in development builds. The demo backend
 * (demo/demoBackend.ts) tags its stand-in agent output with
 * `modelConsulted: false`; the real route never sends that field, and in a
 * production build `import.meta.env.DEV` is statically false, so demo data
 * can never change what production renders.
 */
export interface DemoNoModelMarker {
  modelConsulted: false
}

export function isDemoNoModelOutput(value: unknown): boolean {
  return import.meta.env.DEV && (value as Partial<DemoNoModelMarker> | null)?.modelConsulted === false
}

/** sessionStorage flag demo/demoBackend.ts sets for `?demo=1` (read before the backend installs). */
export const DEMO_FLAG_KEY = 'sails_demo_mode'

/** True only in a dev build with demo mode on for this tab. */
export function isDemoMode(): boolean {
  if (!import.meta.env.DEV) return false
  try { return sessionStorage.getItem(DEMO_FLAG_KEY) === '1' } catch { return false }
}

/** Demo-only multi-method list on a raw offer/summary from the demo backend; undefined for real data. */
export function demoPaymentMethodsOf<T extends string>(raw: unknown): T[] | undefined {
  if (!import.meta.env.DEV) return undefined
  const list = (raw as { demoPaymentMethods?: unknown } | null)?.demoPaymentMethods
  return Array.isArray(list) && list.length > 0 ? (list as T[]) : undefined
}
