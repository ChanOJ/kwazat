/**
 * The device wrapping key, kept in this browser's IndexedDB as a non-extractable CryptoKey: the
 * browser can use it, but its bytes cannot be read by scripts nor sent anywhere. Browser only.
 */
const DB_NAME = "kwazat-red-lines";
const STORE = "device-keys";

export type DeviceKey = { wrapId: string; key: CryptoKey };

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openStore();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = op(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function getDeviceKey(userId: string): Promise<DeviceKey | null> {
  const value = (await run("readonly", (s) => s.get(userId))) as DeviceKey | undefined;
  return value && value.key instanceof CryptoKey && typeof value.wrapId === "string" ? value : null;
}

export async function putDeviceKey(userId: string, value: DeviceKey): Promise<void> {
  await run("readwrite", (s) => s.put(value, userId));
}

export async function deleteDeviceKey(userId: string): Promise<void> {
  await run("readwrite", (s) => s.delete(userId));
}
