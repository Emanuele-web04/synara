// FILE: composerImageBlobStore.ts
// Purpose: Persists large composer image blobs outside localStorage.
// Layer: Browser storage adapter
// Depends on: IndexedDB structured-clone support for Blob values.

const DATABASE_NAME = "synara-composer-images";
const DATABASE_VERSION = 1;
const IMAGE_STORE_NAME = "images";

interface StoredComposerImageBlob {
  key: string;
  blob: Blob;
  name: string;
  mimeType: string;
  lastModified: number;
}

function openComposerImageDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB is unavailable."));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(IMAGE_STORE_NAME)) {
        database.createObjectStore(IMAGE_STORE_NAME, { keyPath: "key" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () =>
      reject(request.error ?? new Error("Could not open the composer image database.")),
    );
    request.addEventListener("blocked", () =>
      reject(new Error("The composer image database upgrade was blocked.")),
    );
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () =>
      reject(transaction.error ?? new Error("Composer image storage was aborted.")),
    );
    transaction.addEventListener("error", () =>
      reject(transaction.error ?? new Error("Composer image storage failed.")),
    );
  });
}

export function composerImageBlobKey(threadId: string, imageId: string): string {
  return `${threadId}:${imageId}`;
}

export async function persistComposerImageBlob(input: {
  threadId: string;
  imageId: string;
  file: File;
}): Promise<string> {
  const key = composerImageBlobKey(input.threadId, input.imageId);
  const database = await openComposerImageDatabase();
  try {
    const transaction = database.transaction(IMAGE_STORE_NAME, "readwrite");
    transaction.objectStore(IMAGE_STORE_NAME).put({
      key,
      blob: input.file,
      name: input.file.name,
      mimeType: input.file.type,
      lastModified: input.file.lastModified,
    } satisfies StoredComposerImageBlob);
    await waitForTransaction(transaction);
    return key;
  } finally {
    database.close();
  }
}

export async function readComposerImageBlob(key: string): Promise<File | null> {
  if (key.length === 0) return null;
  const database = await openComposerImageDatabase();
  try {
    const transaction = database.transaction(IMAGE_STORE_NAME, "readonly");
    const completion = waitForTransaction(transaction);
    const request = transaction.objectStore(IMAGE_STORE_NAME).get(key);
    const stored = await new Promise<StoredComposerImageBlob | undefined>((resolve, reject) => {
      request.addEventListener("success", () =>
        resolve(request.result as StoredComposerImageBlob | undefined),
      );
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("Could not read the composer image.")),
      );
    });
    await completion;
    if (!stored?.blob) return null;
    return new File([stored.blob], stored.name, {
      type: stored.mimeType || stored.blob.type,
      lastModified: stored.lastModified,
    });
  } finally {
    database.close();
  }
}

export async function deleteComposerImageBlob(key: string): Promise<void> {
  if (key.length === 0 || typeof indexedDB === "undefined") return;
  const database = await openComposerImageDatabase();
  try {
    const transaction = database.transaction(IMAGE_STORE_NAME, "readwrite");
    transaction.objectStore(IMAGE_STORE_NAME).delete(key);
    await waitForTransaction(transaction);
  } finally {
    database.close();
  }
}
