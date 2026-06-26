// FILE: browserDownload.test.ts
// Purpose: Verifies blob-backed downloads do not fall back to top-level navigation on failures.
// Layer: Web utility tests
// Depends on: browserDownload helpers with mocked Fetch and DOM anchor APIs.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadUrlAsBlob } from "./browserDownload";

describe("browserDownload", () => {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  let click: ReturnType<typeof vi.fn>;
  let appended: unknown[] = [];
  let link: {
    href: string;
    download: string;
    click: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    click = vi.fn();
    appended = [];
    link = {
      href: "",
      download: "",
      click,
      remove: vi.fn(),
    };
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: vi.fn((tagName: string) => {
          if (tagName !== "a") throw new Error(`Unexpected element ${tagName}`);
          return link;
        }),
        body: {
          appendChild: vi.fn((node: unknown) => {
            appended.push(node);
            return node;
          }),
        },
      },
    });
    URL.createObjectURL = vi.fn(() => "blob:download");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
  });

  it("saves a fetched response through a blob URL", async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response("<svg />", { status: 200 })));

    await downloadUrlAsBlob({
      url: "http://127.0.0.1:5733/api/local-image?download=1",
      filename: "favicon.svg",
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:5733/api/local-image?download=1",
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(link.href).toBe("blob:download");
    expect(link.download).toBe("favicon.svg");
    expect(appended).toEqual([link]);
    expect(click).toHaveBeenCalledTimes(1);
    expect(link.remove).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it("throws before creating a download when the server rejects the file", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" })),
    );

    await expect(
      downloadUrlAsBlob({
        url: "http://127.0.0.1:5733/api/local-image?download=1",
        filename: "favicon.ico",
      }),
    ).rejects.toThrow("Download failed with HTTP 404 Not Found.");

    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
  });
});
