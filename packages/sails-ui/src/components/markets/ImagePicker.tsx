/**
 * Layer A: pick a local image for a market (square icon, 3:1 banner, optional 3:4 cover) and see it in the target
 * ratio, centered and cropped like it will show (object-cover). Nothing is uploaded: the caller turns the File into an
 * object URL for a local preview and revokes it. The file is checked here (lib/imageCheck.ts): a wrong type or over
 * 5 MB is an error and the file is refused; a smaller or differently shaped image only warns. Copy from props.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, ImagePlus, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { IMAGE_SPECS, imageDimensionCheck, imageFileError, type ImageKind } from '../../lib/imageCheck'

const FRAME: Record<ImageKind, string> = { icon: 'aspect-square w-24', banner: 'aspect-[3/1] w-full', cover: 'aspect-[3/4] w-24' }

export interface ImagePickerCopy {
  label: string
  /** Recommended size, formats, limit and the safe-area note. */
  help: string
  choose: string
  replace: string
  remove: string
  wrongType: string
  tooBig: string
  warnSmall: string
  warnRatio: string
}

export function ImagePicker({ kind, url, copy, onPick }: {
  kind: ImageKind
  url: string | null
  copy: ImagePickerCopy
  /** A valid image File, or null to clear. */
  onPick: (file: File | null) => void
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<'wrongType' | 'tooBig' | null>(null)
  const [warning, setWarning] = useState<'small' | 'ratio' | null>(null)
  const vector = useRef(false)
  // A new (or no) image starts without a warning until its preview reports its pixel size.
  useEffect(() => { setWarning(null) }, [url])
  const messageId = `${id}-message`
  return (
    <div>
      <p id={`${id}-label`} className="text-sm font-medium text-brand-text">{copy.label}</p>
      <div className={cn('flex gap-3', kind === 'banner' ? 'mt-1 flex-col' : 'mt-1 items-end')}>
        <div aria-hidden="true" className={cn('relative shrink-0 overflow-hidden rounded-lg bg-brand-tonal', FRAME[kind])}>
          {url
            ? (
              <img
                src={url} alt="" className="h-full w-full object-cover object-center"
                onLoad={(e) => {
                  const r = imageDimensionCheck(kind, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight, vector.current)
                  setWarning(r === 'ok' ? null : r)
                }}
              />
            )
            : <span className="absolute inset-0 flex items-center justify-center text-caption text-brand-text-muted">{IMAGE_SPECS[kind].ratioLabel}</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            ref={input} id={`${id}-file`} type="file" accept={IMAGE_SPECS[kind].types.join(',')} className="sr-only" tabIndex={-1}
            aria-labelledby={`${id}-label`} aria-describedby={`${id}-help`}
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              e.target.value = ''
              if (!f) return
              const err = imageFileError(kind, f)
              setError(err)
              if (!err) { vector.current = f.type === 'image/svg+xml'; onPick(f) }
            }}
          />
          <Button type="button" size="sm" variant="secondary" onClick={() => input.current?.click()} aria-describedby={`${id}-help ${messageId}`} className="touch:min-h-11">
            <ImagePlus aria-hidden="true" />{url ? copy.replace : copy.choose}<span className="sr-only">: {copy.label}</span>
          </Button>
          {url && (
            <Button type="button" size="sm" variant="ghost" onClick={() => { setError(null); onPick(null) }} className="touch:min-h-11">
              <Trash2 aria-hidden="true" />{copy.remove}<span className="sr-only">: {copy.label}</span>
            </Button>
          )}
        </div>
      </div>
      <p id={`${id}-help`} className="mt-1 text-caption text-brand-text-muted">{copy.help}</p>
      <div id={messageId} aria-live="polite">
        {error && <p className="mt-1 text-caption text-brand-danger-fg">{error === 'tooBig' ? copy.tooBig : copy.wrongType}</p>}
        {!error && warning && (
          <p className="mt-1 flex items-start gap-1.5 text-caption text-brand-warning-fg">
            <AlertTriangle aria-hidden="true" className="mt-px size-icon-xs shrink-0" />{warning === 'small' ? copy.warnSmall : copy.warnRatio}
          </p>
        )}
      </div>
    </div>
  )
}
