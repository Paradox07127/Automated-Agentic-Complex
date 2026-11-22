export const MAX_SCOPE_FILES = 16;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const imageExtensions: ReadonlyMap<string, string> = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']]);

export function pastedImages(items: unknown): { type: string; data: ArrayBuffer }[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_SCOPE_FILES).filter(item => item && imageExtensions.has(item.type) &&
    item.data instanceof ArrayBuffer && item.data.byteLength > 0 && item.data.byteLength <= MAX_IMAGE_BYTES);
}
