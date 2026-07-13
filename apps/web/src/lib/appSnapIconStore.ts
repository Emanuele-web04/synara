// FILE: appSnapIconStore.ts
// Purpose: Deduplicates native AppSnap icons outside localStorage.
// Layer: Browser storage adapter
// Depends on: IndexedDB structured-clone support.

const DATABASE_NAME = "synara-appsnap-icons";
const DATABASE_VERSION = 1;
const ICON_STORE_NAME = "icons";
const MAX_BUNDLE_IDENTIFIER_LENGTH = 512;
const MAX_ICON_DATA_URL_LENGTH = 256_000;
const MAX_STORED_APP_ICONS = 100;

interface StoredAppSnapIcon {
  bundleIdentifier: string;
  dataUrl: string;
  updatedAt: number;
}

export function selectAppSnapIconEvictionKeys(
  entries: ReadonlyArray<Pick<StoredAppSnapIcon, "bundleIdentifier" | "updatedAt">>,
  maximumEntries = MAX_STORED_APP_ICONS,
): string[] {
  const overflow = Math.max(0, entries.length - Math.max(0, maximumEntries));
  if (overflow === 0) return [];
  return [...entries]
    .sort(
      (left, right) =>
        left.updatedAt - right.updatedAt ||
        left.bundleIdentifier.localeCompare(right.bundleIdentifier),
    )
    .slice(0, overflow)
    .map((entry) => entry.bundleIdentifier);
}

function normalizeBundleIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_BUNDLE_IDENTIFIER_LENGTH
    ? normalized
    : null;
}

function normalizeIconDataUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_ICON_DATA_URL_LENGTH) return null;
  return /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null;
}

function openAppSnapIconDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ICON_STORE_NAME)) {
        database.createObjectStore(ICON_STORE_NAME, { keyPath: "bundleIdentifier" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Could not open the AppSnap icon cache.")),
    );
    request.addEventListener("blocked", () =>
      reject(new Error("The AppSnap icon cache upgrade was blocked.")),
    );
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("AppSnap icon storage was aborted.")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("AppSnap icon storage failed.")),
    );
  });
}

export async function persistAppSnapIcon(input: {
  bundleIdentifier: string;
  dataUrl: string;
}): Promise<void> {
  const bundleIdentifier = normalizeBundleIdentifier(input.bundleIdentifier);
  const dataUrl = normalizeIconDataUrl(input.dataUrl);
  if (!bundleIdentifier || !dataUrl) return;

  const database = await openAppSnapIconDatabase();
  try {
    const transaction = database.transaction(ICON_STORE_NAME, "readwrite");
    const store = transaction.objectStore(ICON_STORE_NAME);
    store.put({
      bundleIdentifier,
      dataUrl,
      updatedAt: Date.now(),
    } satisfies StoredAppSnapIcon);
    const entriesRequest = store.getAll();
    entriesRequest.addEventListener("success", () => {
      const entries = entriesRequest.result as StoredAppSnapIcon[];
      for (const key of selectAppSnapIconEvictionKeys(entries)) {
        store.delete(key);
      }
    });
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}

export async function readAppSnapIcon(bundleIdentifier: string): Promise<string | null> {
  const normalizedBundleIdentifier = normalizeBundleIdentifier(bundleIdentifier);
  if (!normalizedBundleIdentifier) return null;

  const database = await openAppSnapIconDatabase();
  try {
    const transaction = database.transaction(ICON_STORE_NAME, "readonly");
    const completion = waitForTransaction(transaction);
    const request = transaction.objectStore(ICON_STORE_NAME).get(normalizedBundleIdentifier);
    const stored = await new Promise<StoredAppSnapIcon | undefined>((resolve, reject) => {
      request.addEventListener("success", () =>
        resolve(request.result as StoredAppSnapIcon | undefined),
      );
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("Could not read the AppSnap icon cache.")),
      );
    });
    await completion;
    return normalizeIconDataUrl(stored?.dataUrl);
  } finally {
    database.close();
  }
}
