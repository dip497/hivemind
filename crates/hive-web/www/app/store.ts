// What this browser keeps, in IndexedDB: its device key, sealed; what pairing gave; the last
// overview, shown at once on the next open, before anything is reached. iroh signs with the key's
// bytes, so a non-extractable WebCrypto key cannot be the device key itself: the seed is kept
// sealed under one (AES-GCM), so a copy of the browser's storage alone does not carry the key.

const STORE = "kept";
let opened: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  return (opened ??= new Promise((resolve, reject) => {
    const open = indexedDB.open("hive-web", 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  }));
}

async function kept<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const store = (await db()).transaction(STORE, mode).objectStore(STORE);
  return new Promise((resolve, reject) => {
    const req = op(store);
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
  });
}

export const get = <T>(key: string) => kept<T | undefined>("readonly", (s) => s.get(key));
export const put = (key: string, value: unknown) => kept<void>("readwrite", (s) => s.put(value, key));
export const remove = (key: string) => kept<void>("readwrite", (s) => s.delete(key));

/** One of this browser's device keys, its 32-byte seed, kept sealed under `name`: made the first
 *  time it is asked for. Each account pairs with keys of its own ("device" is the first one made). */
export async function deviceKey(name: string): Promise<Uint8Array> {
  const sealed = await get<{ iv: Uint8Array<ArrayBuffer>; key: ArrayBuffer }>(name);
  let sealing = await get<CryptoKey>("sealing");
  if (sealing && sealed) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, sealing, sealed.key));
  }
  if (!sealing) {
    sealing = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await put("sealing", sealing);
  }
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  await put(name, { iv, key: await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sealing, seed) });
  return seed;
}
