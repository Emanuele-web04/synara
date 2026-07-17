import { describe, expect, it } from "vitest";

import {
  composerImageBlobKey,
  selectOrphanedComposerImageBlobKeys,
} from "./composerImageBlobStore";

describe("composerImageBlobKey", () => {
  it("scopes an attachment blob to its thread and image", () => {
    expect(composerImageBlobKey("thread-1", "image-1")).toBe("thread-1:image-1");
    expect(composerImageBlobKey("thread-2", "image-1")).not.toBe(
      composerImageBlobKey("thread-1", "image-1"),
    );
  });
});

describe("selectOrphanedComposerImageBlobKeys", () => {
  const hourMs = 60 * 60 * 1000;
  const nowMs = 10 * hourMs;

  it("keeps referenced blobs regardless of age", () => {
    const keys = selectOrphanedComposerImageBlobKeys(
      [
        { key: "thread-1:image-1", updatedAt: 0 },
        { key: "thread-1:image-2", updatedAt: 0 },
      ],
      { isReferenced: (key) => key === "thread-1:image-1", nowMs },
    );

    expect(keys).toEqual(["thread-1:image-2"]);
  });

  it("keeps unreferenced blobs written within the minimum age window", () => {
    const keys = selectOrphanedComposerImageBlobKeys(
      [
        { key: "thread-1:image-1", updatedAt: nowMs - hourMs / 2 },
        { key: "thread-1:image-2", updatedAt: nowMs - 2 * hourMs },
      ],
      { isReferenced: () => false, nowMs },
    );

    expect(keys).toEqual(["thread-1:image-2"]);
  });

  it("honors an explicit minimum age", () => {
    const keys = selectOrphanedComposerImageBlobKeys(
      [{ key: "thread-1:image-1", updatedAt: nowMs - hourMs / 2 }],
      { isReferenced: () => false, nowMs, minAgeMs: hourMs / 4 },
    );

    expect(keys).toEqual(["thread-1:image-1"]);
  });

  it("treats records without a write time as old", () => {
    const keys = selectOrphanedComposerImageBlobKeys([{ key: "thread-1:image-1" }], {
      isReferenced: () => false,
      nowMs,
    });

    expect(keys).toEqual(["thread-1:image-1"]);
  });
});
