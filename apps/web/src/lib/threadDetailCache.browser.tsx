import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadId } from "@synara/contracts";
import { makeReadModelThread, makeState, makeThread } from "../storeTestFixtures";
import {
  readThreadDetailCache,
  writeThreadDetailCache,
  deleteThreadDetailCache,
  clearThreadDetailCache,
} from "./threadDetailCache";
const namespace = { origin: "https://cache.test", serverInstanceId: "verified-journal-a" };
const id = ThreadId.makeUnsafe("thread-1");
const snapshot = (sequence: number, text: string) => ({
  snapshotSequence: sequence,
  thread: makeReadModelThread({ title: text }),
});
import { useStore } from "../store";
import { initialState } from "../storeState";
import { isThreadDetailAwaitingVerification } from "../threadDetailAuthority";
import { adoptVerifiedThreadCacheIdentity } from "../threadDetailCacheIdentity";
import {
  hydrateCachedThreadDetail,
  snapshotAppliedThreadDetail,
  startThreadDetailCachePersistence,
} from "../threadDetailCache";
import {
  advanceThreadDetailResumeCursor,
  getThreadDetailResumeCursor,
  resetThreadDetailResumeCursors,
} from "../threadDetailResumeCursors";
import { openIndexedDbDatabase, waitForIdbTransaction } from "./indexedDb";
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await clearThreadDetailCache();
  useStore.setState(initialState);
  resetThreadDetailResumeCursors();
});
describe("durable coherent thread detail", () => {
  it("reloads detail and cursor together and rejects an older cross-tab write", async () => {
    await writeThreadDetailCache(namespace, snapshot(12, "newer"));
    await writeThreadDetailCache(namespace, snapshot(11, "older"));
    const restored = await readThreadDetailCache(namespace, id);
    expect(restored?.snapshotSequence).toBe(12);
    expect(restored?.thread.title).toBe("newer");
    expect(
      await readThreadDetailCache({ ...namespace, serverInstanceId: "new-instance" }, id),
    ).toBeNull();
  });
  it("keeps a tombstone ahead of delayed writes and handles clearing", async () => {
    await writeThreadDetailCache(namespace, snapshot(12, "present"));
    await deleteThreadDetailCache(namespace, id);
    await writeThreadDetailCache(namespace, snapshot(13, "late"));
    expect(await readThreadDetailCache(namespace, id)).toBeNull();
    await clearThreadDetailCache();
    expect(await readThreadDetailCache(namespace, id)).toBeNull();
  });
  it("refuses invalid schema and over-budget entries", async () => {
    await writeThreadDetailCache(namespace, { ...snapshot(12, "valid"), snapshotSequence: -1 });
    expect(await readThreadDetailCache(namespace, id)).toBeNull();
    await writeThreadDetailCache(namespace, snapshot(12, "x".repeat(4_000_000)));
    expect(await readThreadDetailCache(namespace, id)).toBeNull();
  });
});

it("bounds durable entries and treats corrupt schema, quota and disabled storage as cache misses", async () => {
  for (let index = 0; index < 34; index++)
    await writeThreadDetailCache(namespace, {
      ...snapshot(index, `entry ${index}`),
      thread: makeReadModelThread({ id: ThreadId.makeUnsafe(`bounded-${index}`) }),
    });
  expect(await readThreadDetailCache(namespace, ThreadId.makeUnsafe("bounded-0"))).toBeNull();
  expect(await readThreadDetailCache(namespace, ThreadId.makeUnsafe("bounded-33"))).not.toBeNull();
  const database = await openIndexedDbDatabase({
    name: "synara-thread-detail-cache",
    version: 1,
    storeName: "details",
    keyPath: "key",
    label: "test cache",
  });
  const transaction = database.transaction("details", "readwrite");
  transaction.objectStore("details").put({
    key: JSON.stringify([namespace.origin, namespace.serverInstanceId, id]),
    namespace: JSON.stringify([namespace.origin, namespace.serverInstanceId]),
    version: 999,
    updatedAt: Date.now(),
    bytes: 1,
    sequence: 12,
    payload: "{}",
  });
  await waitForIdbTransaction(transaction, "test corruption");
  database.close();
  expect(await readThreadDetailCache(namespace, id)).toBeNull();
  const put = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(() => {
    throw new DOMException("Quota exceeded", "QuotaExceededError");
  });
  await expect(writeThreadDetailCache(namespace, snapshot(13, "quota"))).resolves.toBeUndefined();
  put.mockRestore();
  expect(await readThreadDetailCache(namespace, id)).toBeNull();
  vi.stubGlobal("indexedDB", undefined);
  expect(await readThreadDetailCache(namespace, id)).toBeNull();
  await expect(
    writeThreadDetailCache(namespace, snapshot(14, "disabled")),
  ).resolves.toBeUndefined();
});

it("captures applied detail rather than an enqueued cursor, restores privately, and resets on a genuine server change", async () => {
  const owner = { origin: location.origin, serverInstanceId: "manager-journal" };
  adoptVerifiedThreadCacheIdentity(owner.serverInstanceId);
  useStore.setState(makeState(makeThread()));
  const stop = startThreadDetailCachePersistence();
  try {
    useStore
      .getState()
      .syncServerThreadDetailHotPath(makeReadModelThread({ title: "applied" }), 12, {
        totalMessageCount: 0,
        olderCursor: null,
      });
    advanceThreadDetailResumeCursor(id, 15); // Root has queued events not yet reduced.
    expect(snapshotAppliedThreadDetail(useStore.getState(), id)?.snapshotSequence).toBe(12);
    window.dispatchEvent(new Event("pagehide"));
    await expect
      .poll(async () => (await readThreadDetailCache(owner, id))?.snapshotSequence)
      .toBe(12);
    useStore.getState().evictThreadDetails([id]);
    expect(getThreadDetailResumeCursor(id)).toBeUndefined();
    await hydrateCachedThreadDetail(id);
    expect(useStore.getState().threadDetailSyncById?.[id]).toBe("cached");
    expect(getThreadDetailResumeCursor(id)).toBe(12);
    expect(snapshotAppliedThreadDetail(useStore.getState(), id)).toBeNull();
    adoptVerifiedThreadCacheIdentity("fresh-process-journal");
    expect(getThreadDetailResumeCursor(id)).toBeUndefined();
    expect(useStore.getState().threadDetailSyncById?.[id]).toBe("cached");
    expect(isThreadDetailAwaitingVerification(id)).toBe(true);
    await hydrateCachedThreadDetail(id);
    expect(useStore.getState().threadDetailSyncById?.[id]).toBe("cached");
    useStore
      .getState()
      .syncServerThreadDetailHotPath(makeReadModelThread({ title: "new process" }), 1);
    expect(isThreadDetailAwaitingVerification(id)).toBe(false);
  } finally {
    stop();
  }
});

it("bounds tombstones even when deletion is the only durable activity", async () => {
  for (let index = 0; index < 514; index++)
    await deleteThreadDetailCache(namespace, ThreadId.makeUnsafe(`deleted-${index}`));
  const database = await openIndexedDbDatabase({
    name: "synara-thread-detail-cache",
    version: 1,
    storeName: "details",
    keyPath: "key",
    label: "test cache",
  });
  const transaction = database.transaction("details", "readonly");
  const request = transaction.objectStore("details").count();
  await waitForIdbTransaction(transaction, "test count");
  expect(request.result).toBe(512);
  database.close();
  await writeThreadDetailCache(namespace, {
    ...snapshot(12, "late"),
    thread: makeReadModelThread({ id: ThreadId.makeUnsafe("deleted-513") }),
  });
  expect(await readThreadDetailCache(namespace, ThreadId.makeUnsafe("deleted-513"))).toBeNull();
});
