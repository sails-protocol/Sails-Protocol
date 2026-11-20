/**
 * Layer A: the toast skin (DESIGN_SYSTEM.md 5.3) over sonner, the library the
 * app already uses. Inverse surface, no border, one icon per tone, optional
 * action, durations by kind (lib/toast.ts). sonner announces each toast in a
 * polite live region and never moves focus. Import `toast` from here, not from
 * 'sonner', so every call gets the durations.
 */
import { toast as sonner, Toaster as Sonner, type ExternalToast } from 'sonner'
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react'
import { toastDuration, type ToastKind } from '../../lib/toast'

type Message = Parameters<typeof sonner.success>[0]

const withPolicy = (kind: ToastKind, data?: ExternalToast): ExternalToast => ({
  ...data,
  duration: data?.duration ?? toastDuration(kind, !!data?.action),
  // Errors and actionable toasts can be dismissed by hand; a short confirmation needs no close button.
  closeButton: data?.closeButton ?? (kind === 'error' || !!data?.action),
})

export const toast = Object.assign((message: Message, data?: ExternalToast) => sonner(message, withPolicy('default', data)), {
  success: (message: Message, data?: ExternalToast) => sonner.success(message, withPolicy('success', data)),
  info: (message: Message, data?: ExternalToast) => sonner.info(message, withPolicy('info', data)),
  warning: (message: Message, data?: ExternalToast) => sonner.warning(message, withPolicy('warning', data)),
  error: (message: Message, data?: ExternalToast) => sonner.error(message, withPolicy('error', data)),
  dismiss: sonner.dismiss,
})

const ICON = 'size-icon shrink-0'
/** The toast container look, also used by the /dev/design-system specimen. */
export const TOAST_CLASS = 'flex w-full items-center gap-3 rounded-md bg-brand-inverse py-3 pl-4 pr-2 text-body-sm text-brand-on-inverse shadow-elevation-2'

export function Toaster({ position, theme }: { position: 'top-center' | 'bottom-right'; theme: 'light' | 'dark' }) {
  return (
    <Sonner
      position={position}
      theme={theme}
      visibleToasts={3}
      gap={8}
      containerAriaLabel="Notificações"
      icons={{
        success: <CheckCircle2 aria-hidden="true" className={`${ICON} text-brand-inverse-success`} />,
        info: <Info aria-hidden="true" className={`${ICON} text-brand-inverse-info`} />,
        warning: <AlertTriangle aria-hidden="true" className={`${ICON} text-brand-inverse-warning`} />,
        error: <XCircle aria-hidden="true" className={`${ICON} text-brand-inverse-danger`} />,
        loading: <Loader2 aria-hidden="true" className={`${ICON} motion-safe:animate-spin`} />,
        close: <X aria-hidden="true" className="size-icon-sm" />,
      }}
      toastOptions={{
        unstyled: true,
        closeButtonAriaLabel: 'Fechar',
        classNames: {
          // No border: the inverse surface and elevation-2 separate it from any page.
          toast: TOAST_CLASS,
          content: 'min-w-0 flex-1 py-1',
          title: 'font-medium',
          description: 'mt-0.5',
          icon: 'flex shrink-0',
          // The action reads as a link on the inverse surface (5.51-5.67:1), 44px on touch.
          actionButton: 'shrink-0 rounded-sm px-2 h-9 touch:h-11 text-control font-medium text-brand-inverse-link state-layer [--state-layer:var(--color-on-inverse)]',
          closeButton: 'order-last shrink-0 inline-flex items-center justify-center rounded-sm size-9 touch:size-11 text-brand-on-inverse state-layer [--state-layer:var(--color-on-inverse)]',
        },
      }}
    />
  )
}
