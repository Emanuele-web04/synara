import { describe, expect, it } from "vitest";

import { decodeRemoteResourceReference, remoteResourceRoute } from "./remoteResources";

const reference = (resource: Record<string, unknown>) =>
  JSON.stringify({ environmentId: "remote:environment", resource });

describe("decodeRemoteResourceReference", () => {
  it("accepts thread ids created on iOS for uploads, exports and voice", () => {
    const threadId = "ios:78B2F93C-528C-4AC3-A6E3-FD448E82695C:thread";
    const upload = decodeRemoteResourceReference(
      reference({
        kind: "attachment-upload",
        threadId,
        type: "image",
        name: "Image.jpg",
        mimeType: "image/jpeg",
      }),
    );
    expect(upload.resource).toMatchObject({ threadId });
    expect(remoteResourceRoute(upload.resource).path).toContain(
      `threadId=${encodeURIComponent(threadId)}`,
    );
    expect(
      decodeRemoteResourceReference(reference({ kind: "thread-export", threadId })).resource,
    ).toMatchObject({ threadId });
    expect(
      decodeRemoteResourceReference(
        reference({
          kind: "voice-upload",
          provider: "openai",
          cwd: "/workspace",
          threadId,
          mimeType: "audio/wav",
          sampleRateHz: 24000,
          durationMs: 1200,
        }),
      ).resource,
    ).toMatchObject({ threadId });
  });

  it("still rejects blank thread ids and unsafe attachment ids", () => {
    expect(() =>
      decodeRemoteResourceReference(reference({ kind: "thread-export", threadId: " " })),
    ).toThrow();
    expect(() =>
      decodeRemoteResourceReference(reference({ kind: "attachment", attachmentId: "../secret" })),
    ).toThrow();
  });
});
