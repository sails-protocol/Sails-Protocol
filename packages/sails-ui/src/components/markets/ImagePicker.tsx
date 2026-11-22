/**
 * Layer A: pick a local image for a market (square icon, 3:1 banner, optional 3:4 cover) and see it in the target
 * ratio. Nothing is uploaded: the caller turns the File into an object URL for a local preview and revokes it.
 * PNG, JPEG, WebP or SVG. Copy from props, tokens only.
 */
import { useId, useRef } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml'
const ACCEPTED = new Set(IMAGE_ACCEPT.split(','))

export type ImageRatio = '1:1' | '3:1' | '3:4'
const FRAME: Record<ImageRatio, string> = { '1:1': 'aspect-square w-24', '3:1': 'aspect-[3/1] w-full', '3:4': 'aspect-[3/4] w-24' }

export interface ImagePickerCopy {
  label: string
  /** e.g. "Proporção 3:1. A imagem fica só neste aparelho." */
  help: string
  choose: string
  replace: string
  remove: string
  wrongType: string
}

export function ImagePicker({ ratio, url, copy, onPick, onReject, error }: {
  ratio: ImageRatio
  url: string | null
  copy: ImagePickerCopy
  /** A valid image File, or null to clear. */
  onPick: (file: File | null) => void
  /** A file of another type was picked (nothing changes). */
  onReject: () => void
  /** Shown under the field (the caller sets it when a wrong type was picked). */
  error?: boolean
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  return (
    <div>
      <p id={`${id}-label`} className="text-sm font-medium text-brand-text">{copy.label}</p>
      <div className={cn('flex gap-3', ratio === '3:1' ? 'mt-1 flex-col' : 'mt-1 items-end')}>
        <div aria-hidden="true" className={cn('relative shrink-0 overflow-hidden rounded-lg bg-brand-tonal', FRAME[ratio])}>
          {url
            ? <img src={url} alt="" className="h-full w-full object-cover" />
            : <span className="absolute inset-0 flex items-center justify-center text-caption text-brand-text-muted">{ratio}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input} id={`${id}-file`} type="file" accept={IMAGE_ACCEPT} className="sr-only" tabIndex={-1}
            aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              e.target.value = ''
              if (f) { if (ACCEPTED.has(f.type)) onPick(f); else onReject() }
            }}
          />
          <Button type="button" size="sm" variant="secondary" onClick={() => input.current?.click()} aria-describedby={`${id}-help`} className="touch:min-h-11">
            <ImagePlus aria-hidden="true" />{url ? copy.replace : copy.choose}<span className="sr-only">: {copy.label}</span>
          </Button>
          {url && (
            <Button type="button" size="sm" variant="ghost" onClick={() => onPick(null)} className="touch:min-h-11">
              <Trash2 aria-hidden="true" />{copy.remove}<span className="sr-only">: {copy.label}</span>
            </Button>
          )}
        </div>
      </div>
      <p id={`${id}-help`} className="mt-1 text-caption text-brand-text-muted">{copy.help}</p>
      {error && <p role="alert" className="mt-1 text-caption text-brand-danger-fg">{copy.wrongType}</p>}
    </div>
  )
}
