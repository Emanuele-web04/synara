// Private, expendable transcript cache. Each record owns detail and its fence.
import { OrchestrationThreadDetailSnapshot, type ThreadId } from "@synara/contracts";
import { Schema } from "effect";
import { awaitIdbRequest, openIndexedDbDatabase, waitForIdbTransaction } from "./indexedDb";

export interface ThreadDetailCacheNamespace {
  origin: string;
  serverInstanceId: string;
}
const DATABASE_NAME = "synara-thread-detail-cache";
const STORE = "details";
const SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 4_000_000;
const MAX_TOTAL_BYTES = 16_000_000;
const MAX_RECORDS = 32;
const MAX_TOMBSTONES = 512;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
interface RecordEntry {
  key: string;
  namespace: string;
  version: number;
  updatedAt: number;
  bytes: number;
  sequence: number;
  payload: string | null;
}
const decode = Schema.decodeUnknownSync(OrchestrationThreadDetailSnapshot);
const namespaceKey = (namespace: ThreadDetailCacheNamespace) =>
  JSON.stringify([namespace.origin, namespace.serverInstanceId]);
const recordKey = (namespace: ThreadDetailCacheNamespace, id: ThreadId) =>
  JSON.stringify([namespace.origin, namespace.serverInstanceId, id]);
const open = () =>
  openIndexedDbDatabase({
    name: DATABASE_NAME,
    version: 1,
    storeName: STORE,
    keyPath: "key",
    label: "conversation cache",
  });

export async function readThreadDetailCache(
  namespace: ThreadDetailCacheNamespace,
  id: ThreadId,
): Promise<OrchestrationThreadDetailSnapshot | null> {
  let database: IDBDatabase | undefined;
  try {
    database = await open();
    const transaction = database.transaction(STORE, "readonly");
    const completion = waitForIdbTransaction(transaction, "Conversation cache read");
    void completion.catch(() => undefined);
    const record = (await awaitIdbRequest(
      transaction.objectStore(STORE).get(recordKey(namespace, id)),
      "Could not read conversation cache",
    )) as RecordEntry | undefined;
    await completion;
    if (
      !record?.payload ||
      record.version !== SCHEMA_VERSION ||
      record.namespace !== namespaceKey(namespace) ||
      record.bytes < 0 ||
      record.bytes > MAX_RECORD_BYTES ||
      new TextEncoder().encode(record.payload).byteLength > MAX_RECORD_BYTES ||
      record.updatedAt + MAX_AGE_MS < Date.now()
    )
      return null;
    const snapshot = decode(JSON.parse(record.payload));
    return snapshot.thread.id === id && snapshot.snapshotSequence === record.sequence
      ? snapshot
      : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export async function writeThreadDetailCache(
  namespace: ThreadDetailCacheNamespace,
  snapshot: OrchestrationThreadDetailSnapshot,
): Promise<void> {
  let database: IDBDatabase | undefined;
  try {
    const payload = JSON.stringify(decode(snapshot));
    const bytes = new TextEncoder().encode(payload).byteLength;
    if (bytes > MAX_RECORD_BYTES) return;
    database = await open();
    const transaction = database.transaction(STORE, "readwrite");
    const completion = waitForIdbTransaction(transaction, "Conversation cache write");
    const store = transaction.objectStore(STORE);
    const key = recordKey(namespace, snapshot.thread.id);
    // Read and compare in the write transaction: a slow tab cannot overwrite a
    // newer coherent detail/fence or resurrect a deleted thread.
    const request = store.getAll();
    request.addEventListener("success", () => {
      try {
        const records = request.result as RecordEntry[];
        const previous = records.find((record) => record.key === key);
        if (previous && (!previous.payload || previous.sequence > snapshot.snapshotSequence))
          return;
        if (previous?.sequence === snapshot.snapshotSequence && previous.payload) {
          try {
            const detail = decode(JSON.parse(previous.payload));
            if (
              detail.thread.messages.length > snapshot.thread.messages.length ||
              detail.thread.activities.length > snapshot.thread.activities.length
            )
              return;
          } catch {
            /* Replace incompatible cache. */
          }
        }
        const entry: RecordEntry = {
          key,
          namespace: namespaceKey(namespace),
          version: SCHEMA_VERSION,
          updatedAt: Date.now(),
          bytes,
          sequence: snapshot.snapshotSequence,
          payload,
        };
        store.put(entry);
        const details = [
          entry,
          ...records.filter((record) => record.key !== key && record.payload !== null),
        ].sort((a, b) => b.updatedAt - a.updatedAt);
        let used = 0;
        details.forEach((record, index) => {
          used += record.bytes;
          if (
            index >= MAX_RECORDS ||
            used > MAX_TOTAL_BYTES ||
            record.updatedAt + MAX_AGE_MS < Date.now()
          )
            store.delete(record.key);
        });
        records
          .filter((record) => record.payload === null)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .slice(MAX_TOMBSTONES)
          .forEach((record) => store.delete(record.key));
      } catch {
        transaction.abort();
      }
    });
    await completion;
  } catch {
    /* Storage denial/quota must never break the live conversation. */
  } finally {
    database?.close();
  }
}

export async function deleteThreadDetailCache(
  namespace: ThreadDetailCacheNamespace,
  id: ThreadId,
): Promise<void> {
  let database: IDBDatabase | undefined;
  try {
    database = await open();
    const transaction = database.transaction(STORE, "readwrite");
    transaction
      .objectStore(STORE)
      .put({
        key: recordKey(namespace, id),
        namespace: namespaceKey(namespace),
        version: SCHEMA_VERSION,
        updatedAt: Date.now(),
        bytes: 0,
        sequence: Number.MAX_SAFE_INTEGER,
        payload: null,
      } satisfies RecordEntry);
    await waitForIdbTransaction(transaction, "Conversation cache deletion");
  } catch {
    /* Optional cache. */
  } finally {
    database?.close();
  }
}

export async function clearThreadDetailCache(): Promise<void> {
  let database: IDBDatabase | undefined;
  try {
    database = await open();
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).clear();
    await waitForIdbTransaction(transaction, "Conversation cache clear");
  } catch {
    /* Optional cache. */
  } finally {
    database?.close();
  }
}
