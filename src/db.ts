// Tiny IndexedDB wrapper: a key/value store for the board and a blob store for images.
type StoreName = 'kv' | 'blobs';

let dbp: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('brainboard', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
      req.result.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kvGet = <T>(key: string) => run<T>('kv', 'readonly', (s) => s.get(key));
export const kvSet = (key: string, value: unknown) => run('kv', 'readwrite', (s) => s.put(value, key));
export const blobGet = (key: string) => run<Blob | undefined>('blobs', 'readonly', (s) => s.get(key));
export const blobSet = (key: string, blob: Blob) => run('blobs', 'readwrite', (s) => s.put(blob, key));
export const blobDel = (key: string) => run('blobs', 'readwrite', (s) => s.delete(key));
export const blobKeys = () => run<IDBValidKey[]>('blobs', 'readonly', (s) => s.getAllKeys());
