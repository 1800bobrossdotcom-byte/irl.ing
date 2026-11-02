// A per-device Ed25519 signing key, kept in IndexedDB. The private key is
// non-extractable: the page can sign with it but cannot read it out.

const DB = "irl-loops-keys";
const STORE = "keys";

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
  });
}

/** The device key pair, created on first use; null where unsupported. */
export async function deviceKey() {
  try {
    const db = await open();
    const existing = await run(db, "readonly", (s) => s.get("device"));
    if (existing) return existing;
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
    await run(db, "readwrite", (s) => s.put(pair, "device"));
    return pair;
  } catch {
    return null;
  }
}
