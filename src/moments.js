const DB_NAME = "irling-moments";
const STORE = "moments";
const LEGACY_KEY = "irling.moments.v1";
const samplePaths = [
  "/assets/flower.svg",
  "/assets/cherries.svg",
  "/assets/mushroom.svg",
];
let database;

export function isValidMoment(item) {
  const safeImage = (value) =>
    typeof value === "string" &&
    (/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) ||
      samplePaths.includes(value));
  return Boolean(
    item &&
      typeof item.id === "string" &&
      typeof item.name === "string" &&
      safeImage(item.data) &&
      (!item.source || safeImage(item.source)) &&
      (!item.mask || safeImage(item.mask)),
  );
}

function openDatabase() {
  if (!database)
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore(STORE, { keyPath: "id" });
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          database = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        database = null;
        reject(request.error);
      };
      request.onblocked = () => {
        database = null;
        reject(new Error("Close other irl.ing tabs and try again."));
      };
    });
  return database;
}

async function transaction(mode, operation) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = operation(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error || request.error);
    tx.onabort = () =>
      reject(tx.error || new Error("The save was interrupted."));
  });
}

export async function saveMoment(item) {
  if (!isValidMoment(item)) throw new Error("That moment could not be saved.");
  await transaction("readwrite", (store) =>
    store.put({ ...item, savedAt: item.savedAt || Date.now() }),
  );
}
export async function deleteMoment(id) {
  await transaction("readwrite", (store) => store.delete(id));
}
export async function loadMoments() {
  // Copy legacy entries first. Only remove the old store after every record has
  // committed, so a quota error or interrupted migration cannot lose user data.
  let legacy;
  try {
    legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
  } catch {
    /* Unavailable legacy storage. */
  }
  if (Array.isArray(legacy)) {
    for (const item of legacy.filter(isValidMoment)) await saveMoment(item);
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* Keep the backup if storage is restricted. */
    }
  }
  const rows = await transaction("readonly", (store) => store.getAll());
  return rows
    .filter(isValidMoment)
    .sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
}
