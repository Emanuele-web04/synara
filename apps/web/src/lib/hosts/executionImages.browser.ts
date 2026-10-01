import { afterAll, expect, it } from "vitest";
import { EnvironmentId } from "@synara/contracts";
import { initializeExecutionContext, executionKey } from "./executionContext";
import { openIndexedDbDatabase, awaitIdbRequest, waitForIdbTransaction } from "../indexedDb";
import {
  migrateLocalComposerImageBlobs,
  persistComposerImageBlob,
  readComposerImageBlob,
  deleteOrphanedComposerImageBlobs,
} from "../composerImageBlobStore";

const legacy = "synara-composer-images";
const environmentId = EnvironmentId.makeUnsafe(`fixture-${crypto.randomUUID()}`);
const descriptor = {
  environmentId,
  label: "Controller",
  platform: { os: "darwin" as const, arch: "arm64" as const },
  serverVersion: "1",
  capabilities: { repositoryIdentity: true },
};
initializeExecutionContext({ controller: descriptor, execution: descriptor, remote: null });
async function database(name: string) {
  return openIndexedDbDatabase({
    name,
    version: 1,
    storeName: "images",
    keyPath: "key",
    label: "fixture images",
  });
}
afterAll(() => {
  indexedDB.deleteDatabase(legacy);
  indexedDB.deleteDatabase(executionKey(legacy));
  localStorage.removeItem(executionKey("composer-image-migration:v1"));
  localStorage.removeItem("synara:legacy-execution-owner:v1");
});

it("copies legacy image bytes without moving them, preserves newer drafts on retry and scopes GC", async () => {
  const db = await database(legacy);
  const key = "same-thread:same-image";
  const original = new Uint8Array([0, 255, 37, 10, 200]);
  const write = db.transaction("images", "readwrite");
  write.objectStore("images").put({
    key,
    blob: new Blob([original], { type: "image/png" }),
    name: "original.png",
    mimeType: "image/png",
    lastModified: 1,
    updatedAt: 0,
  });
  await waitForIdbTransaction(write, "legacy fixture");
  await migrateLocalComposerImageBlobs();
  const copied = await readComposerImageBlob(key);
  expect(new Uint8Array(await copied!.arrayBuffer())).toEqual(original);
  await persistComposerImageBlob({
    threadId: "same-thread",
    imageId: "same-image",
    file: new File([new Uint8Array([7, 8, 9])], "edited.png", { type: "image/png" }),
  });
  localStorage.removeItem(executionKey("composer-image-migration:v1"));
  await migrateLocalComposerImageBlobs();
  expect(new Uint8Array(await (await readComposerImageBlob(key))!.arrayBuffer())).toEqual(
    new Uint8Array([7, 8, 9]),
  );
  expect(
    await deleteOrphanedComposerImageBlobs({
      isReferenced: () => false,
      nowMs: Date.now() + 7_200_000,
    }),
  ).toBe(1);
  expect(await readComposerImageBlob(key)).toBeNull();
  const unchanged = await awaitIdbRequest(
    db.transaction("images", "readonly").objectStore("images").get(key),
    "legacy read",
  );
  expect(new Uint8Array(await unchanged.blob.arrayBuffer())).toEqual(original);
  db.close();
});
