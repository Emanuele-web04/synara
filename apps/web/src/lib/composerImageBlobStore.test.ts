import { describe, expect, it } from "vitest";

import { composerImageBlobKey } from "./composerImageBlobStore";

describe("composerImageBlobKey", () => {
  it("scopes an attachment blob to its thread and image", () => {
    expect(composerImageBlobKey("thread-1", "image-1")).toBe("thread-1:image-1");
    expect(composerImageBlobKey("thread-2", "image-1")).not.toBe(
      composerImageBlobKey("thread-1", "image-1"),
    );
  });
});
