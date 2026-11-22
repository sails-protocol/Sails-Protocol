/**
 * Busy buttons (DESIGN_SYSTEM.md 5.2): while one protocol action runs, the
 * button that started it shows `loading` (in progress, not refused); the other
 * actions it blocks show `disabled` (unavailable meanwhile). `running` is the
 * key of the button clicked last; callers keep it in local state.
 */
export function busyProps(acting: boolean, running: string | null, key: string): { loading?: true; disabled?: true } {
  if (!acting) return {}
  return running === key ? { loading: true } : { disabled: true }
}
