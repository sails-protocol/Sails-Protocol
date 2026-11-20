import { cn } from '../../lib/utils'

/**
 * Sails Market brand (direction A, "Vela dupla", chosen 2026-11-20): main sail in brand orange, jib in
 * brand blue, over an orange waterline. The mark is decorative; the accessible name comes from the
 * wordmark text or from the caller's link label. The same geometry is in public/brand/*.svg.
 * White-label tenants replace this component with their own logo (SAILS_DESIGN_LANGUAGE.md).
 */
export function SailsMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false" className={cn('shrink-0', className)}>
      <path d="M33 6 L33 46 L56 46 Z" fill="#F97316" />
      <path d="M29 15 L29 46 L10 46 Z" fill="#3B82F6" />
      <path d="M6 53 Q19 49 32 53 T58 53" fill="none" stroke="#F97316" strokeWidth="4" strokeLinecap="round" />
    </svg>
  )
}

/** Horizontal lockup: mark + "Sails Market" (Sails in text color, Market in the brand accent). */
export function SailsLogo({ size = 'md', className }: { size?: 'sm' | 'md'; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight text-brand-text whitespace-nowrap', size === 'md' ? 'text-headline' : 'text-heading', className)}>
      <SailsMark size={size === 'md' ? 28 : 24} />
      <span>Sails <span className="text-brand-orange-accent">Market</span></span>
    </span>
  )
}
