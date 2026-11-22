/**
 * Only images the person chose on this device (object URLs from a file picker, or inline data) may render without a
 * click. An admin's link (iconRef/bannerRef) is remote: it goes through AdminImage, click-to-load (GK, 2026-11-22).
 */
export function isLocalPreviewUrl(url: string | null | undefined): url is string {
  return typeof url === 'string' && (url.startsWith('blob:') || url.startsWith('data:image/'))
}
