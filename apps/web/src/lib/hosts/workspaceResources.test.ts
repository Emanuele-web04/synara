import {
  EnvironmentId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type RemoteResource,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { createWorkspaceResourceRequester } from "./workspaceResources";

const environmentId = EnvironmentId.makeUnsafe("owner-mini");
const image: RemoteResource = {
  kind: "attachment-upload",
  threadId: "thread-fixture",
  type: "image",
  name: "screen.png",
  mimeType: "image/png",
};

function owner() {
  const frameLifetime = new AbortController();
  let available = true;
  let listener = () => {};
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
  const resourceUrl = vi.fn(() => "synara-resource://owned/handle");
  const request = createWorkspaceResourceRequester({
    environmentId,
    isAvailable: () => available,
    subscribe: (next) => {
      listener = next;
      return () => {};
    },
    resourceUrl,
    fetch,
    signal: frameLifetime.signal,
  });
  return {
    request,
    fetch,
    resourceUrl,
    frameLifetime,
    remove: () => {
      available = false;
      listener();
    },
  };
}

describe("controller-owned workspace resources", () => {
  it("derives method, MIME and destination from the captured owner and typed manifest", async () => {
    const fixture = owner();
    const body = new Blob(["fixture"], { type: "image/png" });
    await fixture.request(image, { body });
    expect(fixture.resourceUrl).toHaveBeenCalledWith({ environmentId, resource: image });
    expect(fixture.fetch).toHaveBeenCalledWith(
      "synara-resource://owned/handle",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "image/png" },
        body,
      }),
    );
    await fixture.request({ kind: "attachment-cancel" }, { body: '{"attachmentId":"owned"}' });
    expect(fixture.fetch).toHaveBeenLastCalledWith(
      "synara-resource://owned/handle",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );
    fixture.frameLifetime.abort();
  });

  it("refuses oversized, malformed, or bodyless uploads before minting a broker handle", async () => {
    const fixture = owner();
    await expect(
      fixture.request(image, { body: new Uint8Array(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1) }),
    ).rejects.toThrow("permitted size");
    await expect(fixture.request(image)).rejects.toThrow("permitted size");
    await expect(
      fixture.request({ kind: "attachment", attachmentId: "owned" }, { body: "unexpected" }),
    ).rejects.toThrow("does not accept");
    await expect(fixture.request({ ...image, name: "" })).rejects.toBeDefined();
    expect(fixture.resourceUrl).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
    fixture.frameLifetime.abort();
  });

  it.each(["replacement", "unmount", "caller"])(
    "aborts an in-flight request on %s and never switches hosts",
    async (reason) => {
      const fixture = owner();
      const caller = new AbortController();
      fixture.fetch.mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          }),
      );
      const pending = fixture.request(image, {
        body: new Blob(["fixture"]),
        signal: caller.signal,
      });
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      if (reason === "replacement") fixture.remove();
      else if (reason === "unmount") fixture.frameLifetime.abort();
      else caller.abort();
      await rejected;
      expect(fixture.fetch).toHaveBeenCalledOnce();
      if (reason !== "caller") {
        await expect(
          fixture.request({ kind: "attachment-cancel" }, { body: "{}" }),
        ).rejects.toMatchObject({ name: "AbortError" });
        expect(fixture.fetch).toHaveBeenCalledOnce();
      }
      fixture.frameLifetime.abort();
    },
  );

  it("rejects a completed response if the original frame became unavailable", async () => {
    const fixture = owner();
    fixture.fetch.mockImplementationOnce(async () => {
      fixture.remove();
      return new Response("late");
    });
    await expect(
      fixture.request({ kind: "attachment", attachmentId: "owned" }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
