import "../../../index.css";

import type { LibraryEntry } from "@synara/contracts";
import { ProjectId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  rootEntries: [] as LibraryEntry[],
  listCalls: [] as Array<string | undefined>,
  uploaded: [] as string[],
  fetchImpl: undefined as
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>)
    | undefined,
  api: {
    projectAgent: {
      library: {
        list: vi.fn(),
        mkdir: vi.fn(),
        rename: vi.fn(),
        delete: vi.fn(),
        history: vi.fn(async () => ({ root: "/library", commits: [] })),
        restore: vi.fn(),
        status: vi.fn(async () => ({
          root: "/library",
          remoteConfigured: false,
          lastPushAt: null,
          lastPushError: null,
        })),
      },
    },
    contextMenu: {
      show: vi.fn(async () => null),
    },
  },
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: () => harness.api,
  ensureNativeApi: () => harness.api,
}));

import { LibraryPanel } from "./LibraryPanel";

const projectId = ProjectId.makeUnsafe("group-1");

const fileEntry = (name: string, relativePath = name): LibraryEntry => ({
  name,
  relativePath,
  kind: "file",
  sizeBytes: 10,
  modifiedAt: "2026-01-01T00:00:00Z",
});

const dirEntry = (name: string): LibraryEntry => ({
  name,
  relativePath: name,
  kind: "directory",
  sizeBytes: 0,
  modifiedAt: "2026-01-01T00:00:00Z",
});

beforeEach(() => {
  harness.rootEntries = [];
  harness.listCalls = [];
  harness.uploaded = [];
  harness.api.projectAgent.library.list.mockImplementation(
    async (input: { relativePath?: string }) => {
      harness.listCalls.push(input.relativePath);
      return {
        root: "/library",
        entries: input.relativePath ? [] : harness.rootEntries,
      };
    },
  );
  harness.api.projectAgent.library.mkdir.mockResolvedValue({ commitSha: "a" });
  harness.api.projectAgent.library.rename.mockResolvedValue({ commitSha: "b" });
  harness.api.projectAgent.library.delete.mockResolvedValue({ commitSha: "c" });
  harness.api.projectAgent.library.restore.mockResolvedValue({ commitSha: "d" });
  harness.api.contextMenu.show.mockResolvedValue(null);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (harness.fetchImpl) return harness.fetchImpl(input, init);
    return Promise.reject(new Error("unexpected fetch"));
  });
});

function renderPanel() {
  return render(
    <div style={{ position: "relative", width: 480, height: 640 }}>
      <LibraryPanel open variant="docked" projectId={projectId} onClose={() => {}} />
    </div>,
  );
}

describe("LibraryPanel", () => {
  it("shows the empty state when the library has no files", async () => {
    await renderPanel();
    await expect
      .element(page.getByText("No files yet. Add documents or artifacts for this group."))
      .toBeVisible();
  });

  it("lists entries and toggles between list and grid views", async () => {
    harness.rootEntries = [dirEntry("Artifacts"), fileEntry("note.md")];
    const { container } = await renderPanel();

    await expect.element(page.getByText("Artifacts", { exact: true })).toBeVisible();
    await expect.element(page.getByText("note.md", { exact: true })).toBeVisible();
    expect(container.querySelector('[data-library-view="list"]')).not.toBeNull();

    await page.getByRole("radio", { name: "Grid" }).click();
    expect(container.querySelector('[data-library-view="grid"]')).not.toBeNull();

    await page.getByRole("radio", { name: "List" }).click();
    expect(container.querySelector('[data-library-view="list"]')).not.toBeNull();
  });

  it("uploads a file through the hidden input and refetches", async () => {
    harness.rootEntries = [dirEntry("Artifacts")];
    harness.fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/library/upload") {
        const name = url.searchParams.get("name");
        if (name) harness.uploaded.push(name);
        harness.rootEntries = [dirEntry("Artifacts"), fileEntry("note.md")];
        return new Response(JSON.stringify(fileEntry("note.md")), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };
    const { container } = await renderPanel();

    await page.getByRole("button", { name: /Add/ }).click();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const transfer = new DataTransfer();
    transfer.items.add(new File(["hello"], "note.md", { type: "text/markdown" }));
    input!.files = transfer.files;
    input!.dispatchEvent(new Event("change", { bubbles: true }));

    await expect.element(page.getByText("note.md", { exact: true })).toBeVisible();
    expect(harness.uploaded).toEqual(["note.md"]);
  });
});
