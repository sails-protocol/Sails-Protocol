import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// Design System type scale (tailwind.config.js fontSize): without this,
// twMerge reads `text-body-sm` as a text colour and drops it next to `text-brand-*`.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['display', 'title', 'heading', 'subheading', 'body', 'body-sm', 'caption'] }] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
