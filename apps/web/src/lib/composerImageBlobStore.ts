// FILE: composerImageBlobStore.ts
// Purpose: Persists large composer image blobs outside localStorage.
// Layer: Browser storage adapter
// Depends on: IndexedDB structured-clone support for Blob values.

import { awaitIdbRequest, openIndexedDbDatabase, waitForIdbTransaction } from "./indexedDb";

const DATABASE_NAME = "synara-composer-images";
const DATABASE_VERSION = 1;
const IMAGE_STORE_NAME = "images";
const ORPHANED_BLOB_MIN_AGE_MS = 60 * 60 * 1000;

interface StoredComposerImageBlob {
  key: string;
  blob: Blob;
  name: string;
  mimeType: string;
  lastModified: number;
  // Write time. Records created before this field existed omit it and count as old.
  updatedAt?: number;
}

function openComposerImageDatabase(): Promise<IDBDatabase> {
  return openIndexedDbDatabase({
    name: DATABASE_NAME,
    version: DATABASE_VERSION,
    storeName: IMAGE_STORE_NAME,
    keyPath: "key",
    label: "composer image database",
  });
}

function waitForTransaction(transaction: IDBTransaction): Promise<void> {
  return waitForIdbTransaction(transaction, "Composer image storage");
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
      updatedAt: Date.now(),
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
    const stored = (await awaitIdbRequest(
      transaction.objectStore(IMAGE_STORE_NAME).get(key),
      "Could not read the composer image.",
    )) as StoredComposerImageBlob | undefined;
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

export interface OrphanedComposerImageBlobInput {
  isReferenced: (key: string) => boolean;
  nowMs: number;
  minAgeMs?: number;
}

export function selectOrphanedComposerImageBlobKeys(
  records: ReadonlyArray<{ key: string; updatedAt?: number | undefined }>,
  input: OrphanedComposerImageBlobInput,
): string[] {
  const minAgeMs = input.minAgeMs ?? ORPHANED_BLOB_MIN_AGE_MS;
  return records
    .filter(
      (record) =>
        !input.isReferenced(record.key) && (record.updatedAt ?? 0) + minAgeMs <= input.nowMs,
    )
    .map((record) => record.key);
}

export async function deleteOrphanedComposerImageBlobs(input: {
  isReferenced: (key: string) => boolean;
  nowMs?: number;
}): Promise<number> {
  if (typeof indexedDB === "undefined") return 0;
  const selectionInput: OrphanedComposerImageBlobInput = {
    isReferenced: input.isReferenced,
    nowMs: input.nowMs ?? Date.now(),
  };
  const database = await openComposerImageDatabase();
  try {
    const keysTransaction = database.transaction(IMAGE_STORE_NAME, "readonly");
    const keysCompletion = waitForTransaction(keysTransaction);
    const keys = await awaitIdbRequest(
      keysTransaction.objectStore(IMAGE_STORE_NAME).getAllKeys(),
      "Could not list the composer images.",
    );
    await keysCompletion;

    const candidateKeys = keys.filter(
      (key): key is string => typeof key === "string" && !selectionInput.isReferenced(key),
    );
    if (candidateKeys.length === 0) return 0;

    // Age is checked inside the get handlers so the delete lands in the same
    // transaction, before another session can refresh the record.
    const transaction = database.transaction(IMAGE_STORE_NAME, "readwrite");
    const store = transaction.objectStore(IMAGE_STORE_NAME);
    let deleted = 0;
    for (const key of candidateKeys) {
      const request = store.get(key);
      request.addEventListener("success", () => {
        const record = request.result as StoredComposerImageBlob | undefined;
        if (!record) return;
        if (selectOrphanedComposerImageBlobKeys([record], selectionInput).length === 0) return;
        store.delete(key);
        deleted += 1;
      });
    }
    await waitForTransaction(transaction);
    return deleted;
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
