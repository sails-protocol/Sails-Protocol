/**
 * Layer A: an image the market's admin linked (iconRef/bannerRef). The node never fetches it and the app never loads
 * it by itself (GK, 2026-11-22): the person sees a neutral placeholder (`placeholder`) and loads it on request,
 * after being told that loading shows their IP address to whoever hosts the image. The link is marked as external.
 * Copy from props, tokens only.
 */
import { useState, type ReactNode } from 'react'
import { ExternalLink, ImageOff } from 'lucide-react'
import { Button } from '../ui/button'

export interface AdminImageCopy {
  load: string
  privacy: string
  failed: string
  /** e.g. "Link do administrador". */
  linkLabel: string
}

export function AdminImage({ url, placeholder, copy, alt }: { url: string; placeholder: ReactNode; copy: AdminImageCopy; alt: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'loaded' | 'failed'>('idle')
  return (
    <div className="space-y-2">
      {state === 'loading' || state === 'loaded' ? (
        <div className="relative aspect-[3/1] w-full overflow-hidden rounded-lg bg-brand-elevated">
          <img src={url} alt={alt} referrerPolicy="no-referrer" onLoad={() => setState('loaded')} onError={() => setState('failed')} className="h-full w-full object-cover" />
        </div>
      ) : placeholder}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {state === 'idle' && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setState('loading')} className="touch:min-h-11">{copy.load}</Button>
        )}
        {state === 'failed' && (
          <p role="status" className="inline-flex items-center gap-1.5 text-caption text-brand-text-secondary">
            <ImageOff aria-hidden="true" className="size-icon-xs shrink-0" />{copy.failed}
          </p>
        )}
        <span className="inline-flex items-center gap-1 text-caption text-brand-text-muted">
          <ExternalLink aria-hidden="true" className="size-icon-xs shrink-0" />{copy.linkLabel}
        </span>
      </div>
      {state === 'idle' && <p className="text-caption text-brand-text-muted">{copy.privacy}</p>}
    </div>
  )
}
