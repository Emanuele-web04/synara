import "../../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LibraryEntry } from "@synara/contracts";
import { ProjectId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  rootEntries: [] as LibraryEntry[],
  dirEntries: {} as Record<string, LibraryEntry[]>,
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
    projects: {
      readFile: vi.fn(async () => ({
        relativePath: "note.md",
        contents: "# note\n",
        truncated: false,
        version: null,
        encoding: "utf8",
        lineEnding: "lf",
      })),
      onFileChange: vi.fn(() => () => undefined),
    },
    git: {
      readWorkingTreeDiff: vi.fn(async () => ({ patch: "", truncated: false })),
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
  harness.dirEntries = {};
  harness.listCalls = [];
  harness.uploaded = [];
  harness.api.projectAgent.library.list.mockImplementation(
    async (input: { relativePath?: string }) => {
      harness.listCalls.push(input.relativePath);
      return {
        root: "/library",
        entries: input.relativePath
          ? (harness.dirEntries[input.relativePath] ?? [])
          : harness.rootEntries,
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
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <div style={{ position: "relative", width: 480, height: 640 }}>
        <LibraryPanel open variant="docked" projectId={projectId} onClose={() => {}} />
      </div>
    </QueryClientProvider>,
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

  it("refreshes in place on focus without wiping expanded subfolders", async () => {
    harness.rootEntries = [dirEntry("Artifacts")];
    harness.dirEntries = {
      Artifacts: [
        {
          name: "deep",
          relativePath: "Artifacts/deep",
          kind: "directory",
          sizeBytes: 0,
          modifiedAt: "2026-01-01T00:00:00Z",
        },
      ],
      "Artifacts/deep": [fileEntry("inner.md", "Artifacts/deep/inner.md")],
    };
    await renderPanel();

    // Artifacts is seeded expanded; deepen the tree once its children render.
    await expect.element(page.getByRole("button", { name: "deep" })).toBeVisible();
    await page.getByRole("button", { name: "deep" }).click();
    await expect.element(page.getByText("inner.md", { exact: true })).toBeVisible();

    const callsBeforeFocus = harness.listCalls.length;
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(harness.listCalls.length).toBeGreaterThanOrEqual(callsBeforeFocus + 3),
    );

    // The root plus every already-loaded directory is re-listed — the deep
    // listing is replaced in place, never cleared first.
    const refreshCalls = harness.listCalls.slice(callsBeforeFocus);
    expect(refreshCalls).toContain(undefined);
    expect(refreshCalls).toContain("Artifacts");
    expect(refreshCalls).toContain("Artifacts/deep");
    await expect.element(page.getByText("inner.md", { exact: true })).toBeVisible();
  });

  it("coalesces a focus burst into at most one follow-up refresh", async () => {
    harness.rootEntries = [dirEntry("Artifacts")];
    harness.dirEntries = { Artifacts: [] };
    await renderPanel();
    await expect.element(page.getByText("Artifacts", { exact: true })).toBeVisible();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const immediateList = harness.api.projectAgent.library.list.getMockImplementation()!;
    harness.api.projectAgent.library.list.mockImplementation(
      async (input: { relativePath?: string }) => {
        await gate;
        return immediateList(input);
      },
    );

    const callsBeforeFocus = harness.listCalls.length;
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));
    release();

    await vi.waitFor(() => expect(harness.listCalls.length).toBe(callsBeforeFocus + 4));
  });

  it("goes back to the file list through the preview breadcrumb button", async () => {
    harness.rootEntries = [fileEntry("note.md")];
    const { container } = await renderPanel();

    await page.getByRole("button", { name: "note.md" }).click();
    const back = page.getByRole("button", { name: "Back to library from note.md" });
    await expect.element(back).toBeVisible();
    // The file name itself is part of the single back button.
    await expect.element(back).toHaveTextContent("note.md");

    await back.click();
    await expect.element(page.getByRole("button", { name: "note.md" })).toBeVisible();
    expect(container.querySelector('[aria-label^="Back to library"]')).toBeNull();
  });

  it("grows to the overlay's full height on expand and restores on collapse", async () => {
    harness.rootEntries = Array.from({ length: 40 }, (_, index) => fileEntry(`note-${index}.md`));
    const { container } = await renderPanel();

    const surface = () =>
      container.querySelector<HTMLElement>("[data-environment-panel-variant] > div")!;
    await expect.element(page.getByRole("button", { name: "note-0.md" })).toBeVisible();

    const collapsedHeight = surface().getBoundingClientRect().height;
    await page.getByRole("button", { name: "Expand to full height" }).click();
    await vi.waitFor(() => {
      expect(surface().getBoundingClientRect().height).toBeGreaterThan(collapsedHeight);
    });
    const expandedHeight = surface().getBoundingClientRect().height;

    await page.getByRole("button", { name: "Collapse panel" }).click();
    await vi.waitFor(() => {
      expect(surface().getBoundingClientRect().height).toBeLessThan(expandedHeight);
    });
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
