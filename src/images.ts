import { blobDel, blobGet, blobKeys } from './db';
import { requestRender } from './state';
import type { Item } from './types';

const urls = new Map<string, string>();
const pending = new Set<string>();

/** Returns an object URL for a stored image, loading it lazily from IndexedDB. */
export function imageUrl(id: string): string | undefined {
  const u = urls.get(id);
  if (u) return u;
  if (!pending.has(id)) {
    pending.add(id);
    blobGet(id)
      .then((b) => {
        if (b) {
          urls.set(id, URL.createObjectURL(b));
          requestRender();
        }
      })
      .catch(() => {});
  }
  return undefined;
}

export const registerUrl = (id: string, url: string) => urls.set(id, url);

/** Drop stored images no item references any more (runs once at startup). */
export async function gcBlobs(items: Item[]) {
  try {
    const used = new Set(items.flatMap((i) => (i.type === 'image' ? [i.blob] : [])));
    for (const k of await blobKeys()) if (!used.has(String(k))) await blobDel(String(k));
  } catch {
    /* non-critical */
  }
}
