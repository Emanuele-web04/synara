// Focused real-preview regressions for scoped shortcuts and rendered find ranges.
import "../index.css";

import type {
  NativeApi,
  ProjectReadFileResult,
  ResolvedKeybindingsConfig,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

const syntaxGate = vi.hoisted(() => ({
  ready: null as Promise<void> | null,
  pending: new Map<string, Promise<unknown>>(),
}));

vi.mock("../lib/syntaxHighlighting", async (original) => {
  const actual = await original<typeof import("../lib/syntaxHighlighting")>();
  return {
    ...actual,
    getSyntaxHighlighterPromise(language: string) {
      if (!syntaxGate.ready) return actual.getSyntaxHighlighterPromise(language);
      let pending = syntaxGate.pending.get(language);
      if (!pending) {
        pending = Promise.all([
          actual.getSyntaxHighlighterPromise(language),
          syntaxGate.ready,
        ]).then(([highlighter]) => highlighter);
        syntaxGate.pending.set(language, pending);
      }
      return pending;
    },
  };
});

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

const WORKSPACE_ROOT = "/workspace/file-find-fixture";
const FILE_PATH = "src/find.ts";
const PRIMARY_MODIFIER = /Mac/.test(navigator.platform) ? "Meta" : "Control";

function loadedFile(contents: string): ProjectReadFileResult {
  return {
    relativePath: FILE_PATH,
    contents,
    truncated: false,
    version: `sha256:${"1".repeat(64)}`,
    encoding: "utf8",
    lineEnding: "lf",
  };
}

function installNativeApi(api: NativeApi): () => void {
  const previous = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", { configurable: true, value: api });
  return () => {
    if (previous) Object.defineProperty(window, "nativeApi", previous);
    else Reflect.deleteProperty(window, "nativeApi");
  };
}

function findRange(): Range | undefined {
  const registry = (CSS as typeof CSS & { highlights: Map<string, Iterable<Range>> }).highlights;
  const active = Array.from(registry).find(([name]) => name.startsWith("synara-file-find-active-"));
  return active ? Array.from(active[1])[0] : undefined;
}

async function mountPreview(
  contents: string,
  keybindings: ResolvedKeybindingsConfig = [],
  width = 760,
) {
  const readFile = vi.fn().mockResolvedValue(loadedFile(contents));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["server", "config"], { keybindings });
  const restore = installNativeApi({
    projects: { readFile, onFileChange: () => () => undefined },
    git: { readWorkingTreeDiff: async () => ({ patch: "", truncated: false }) },
  } as unknown as NativeApi);
  try {
    const view = await render(
      <QueryClientProvider client={client}>
        <div style={{ height: 340, width, display: "flex" }}>
          <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_PATH} />
        </div>
      </QueryClientProvider>,
    );
    await expect
      .element(page.getByRole("button", { name: "Find in file", exact: true }))
      .toBeVisible();
    return {
      readFile,
      async dispose() {
        try {
          await view.unmount();
        } finally {
          client.clear();
          restore();
        }
      },
    };
  } catch (error) {
    client.clear();
    restore();
    throw error;
  }
}

async function openFind(query: string) {
  await page.getByRole("button", { name: "Find in file", exact: true }).click();
  await page.getByRole("textbox", { name: "Find in file" }).fill(query);
}

afterEach(async () => {
  syntaxGate.ready = null;
  syntaxGate.pending.clear();
  vi.unstubAllGlobals();
  await cleanup();
});

describe("WorkspaceFilePreview find ownership", () => {
  it("honors a remapped file.find chord without capturing the old default", async () => {
    const mounted = await mountPreview("const mappedNeedle = 1;\n", [
      {
        command: "file.find",
        shortcut: {
          key: "k",
          modKey: true,
          metaKey: false,
          ctrlKey: false,
          altKey: false,
          shiftKey: false,
        },
        whenAst: { type: "identifier", name: "filePreviewFocus" },
      },
    ]);
    try {
      const button = page.getByRole("button", { name: "Find in file", exact: true });
      (button.element() as HTMLElement).focus();
      const oldChord = new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: PRIMARY_MODIFIER === "Control",
        metaKey: PRIMARY_MODIFIER === "Meta",
        bubbles: true,
        cancelable: true,
      });
      button.element().dispatchEvent(oldChord);
      expect(oldChord.defaultPrevented).toBe(false);
      await expect.element(page.getByTestId("workspace-file-find-bar")).not.toBeInTheDocument();
      await userEvent.keyboard(`{${PRIMARY_MODIFIER}>}k{/${PRIMARY_MODIFIER}}`);
      await expect.element(page.getByRole("textbox", { name: "Find in file" })).toHaveFocus();
    } finally {
      await mounted.dispose();
    }
  });

  it("keeps keyboard find scoped after clicking source and closing with Escape", async () => {
    const mounted = await mountPreview("const scopedNeedle = 1;\n");
    try {
      await expect
        .poll(() => document.querySelector('[data-syntax-highlighted="true"]'))
        .not.toBeNull();
      await page.getByText("scopedNeedle", { exact: true }).click();
      const preview = document.querySelector<HTMLElement>("[data-workspace-file-preview]")!;
      expect(preview.contains(document.activeElement)).toBe(true);
      await userEvent.keyboard(`{${PRIMARY_MODIFIER}>}f{/${PRIMARY_MODIFIER}}`);
      await expect.element(page.getByRole("textbox", { name: "Find in file" })).toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByTestId("workspace-file-find-bar")).not.toBeInTheDocument();
      expect(preview.contains(document.activeElement)).toBe(true);
      await userEvent.keyboard(`{${PRIMARY_MODIFIER}>}f{/${PRIMARY_MODIFIER}}`);
      await expect.element(page.getByRole("textbox", { name: "Find in file" })).toHaveFocus();
    } finally {
      await mounted.dispose();
    }
  });

  it("scrolls a match spanning syntax tokens into the file viewport without rewriting its markup", async () => {
    const mounted = await mountPreview(
      `const needle = 0;\n${"// another source line\n".repeat(120)}const needle = 1;\n`,
    );
    try {
      await expect
        .poll(() => document.querySelector('[data-syntax-highlighted="true"]'))
        .not.toBeNull();
      const contents = document.querySelector<HTMLElement>(".editor-file-viewer")!;
      const highlighted = contents.querySelector<HTMLElement>(".editor-file-viewer__highlight")!;
      const markup = highlighted.innerHTML;
      await openFind("const needle");
      await expect.element(page.getByText("1 / 2", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Next match (Enter)" }).click();
      await expect.element(page.getByText("2 / 2", { exact: true })).toBeVisible();
      await expect
        .poll(() => {
          const range = findRange();
          if (!range) return false;
          const match = range.getBoundingClientRect();
          const viewport = contents.getBoundingClientRect();
          return match.top >= viewport.top - 1 && match.bottom <= viewport.bottom + 1;
        })
        .toBe(true);
      expect(findRange()?.toString()).toBe("const needle");
      expect(highlighted.innerHTML).toBe(markup);
    } finally {
      await mounted.dispose();
    }
  });

  it("anchors the active match by offset when an earlier hit disappears on reload", async () => {
    const contents = `// needle first\n// ${"x".repeat(100)}\n// needle stable\n// needle tail\n`;
    const mounted = await mountPreview(contents, [], 320);
    try {
      await openFind("needle");
      await expect.element(page.getByText("1 / 3", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Next match (Enter)" }).click();
      await expect.element(page.getByText("2 / 3", { exact: true })).toBeVisible();
      const preview = document.querySelector<HTMLElement>("[data-workspace-file-preview]")!;
      const bar = page.getByTestId("workspace-file-find-bar").element().getBoundingClientRect();
      const bounds = preview.getBoundingClientRect();
      expect(bar.left).toBeGreaterThanOrEqual(bounds.left);
      expect(bar.right).toBeLessThanOrEqual(bounds.right);
      mounted.readFile.mockResolvedValue(
        loadedFile(contents.replace("needle first", "absent first")),
      );
      await page.getByRole("button", { name: "Reload file from disk" }).click();
      await expect.element(page.getByText("1 / 2", { exact: true })).toBeVisible();
      expect(findRange()?.startContainer.parentElement?.textContent).toContain("needle stable");
      expect(mounted.readFile).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.dispose();
    }
  });

  it("starts a changed query at its first hit after navigating to a later hit", async () => {
    const mounted = await mountPreview(
      "// needle alpha\n// needle beta\n// needle gamma\n// other alpha\n",
    );
    try {
      await openFind("needle");
      await expect.element(page.getByText("1 / 3", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Next match (Enter)" }).click();
      await page.getByRole("button", { name: "Next match (Enter)" }).click();
      await expect.element(page.getByText("3 / 3", { exact: true })).toBeVisible();
      await page.getByRole("textbox", { name: "Find in file" }).fill("alpha");
      await expect.element(page.getByText("1 / 2", { exact: true })).toBeVisible();
      expect(findRange()?.startContainer.parentElement?.textContent).toContain("needle alpha");
    } finally {
      await mounted.dispose();
    }
  });

  it("can navigate back to a single active hit after manually scrolling away", async () => {
    const mounted = await mountPreview(
      `${"// another source line\n".repeat(120)}const singleHitNeedle = 1;\n`,
    );
    try {
      await expect
        .poll(() => document.querySelector('[data-syntax-highlighted="true"]'))
        .not.toBeNull();
      await openFind("singleHitNeedle");
      await expect.element(page.getByText("1 / 1", { exact: true })).toBeVisible();
      const viewport = document.querySelector<HTMLElement>(".editor-file-viewer")!;
      await expect.poll(() => viewport.scrollTop).toBeGreaterThan(0);
      viewport.scrollTop = 0;
      await page.getByRole("button", { name: "Next match (Enter)" }).click();
      await expect.poll(() => viewport.scrollTop).toBeGreaterThan(0);
      const match = findRange()!.getBoundingClientRect();
      const visible = viewport.getBoundingClientRect();
      expect(match.top).toBeGreaterThanOrEqual(visible.top - 1);
      expect(match.bottom).toBeLessThanOrEqual(visible.bottom + 1);
    } finally {
      await mounted.dispose();
    }
  });

  it("rebinds active ranges when delayed Shiki replaces the already searched plain fallback", async () => {
    let release!: () => void;
    syntaxGate.ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mounted = await mountPreview("const pendingPaintNeedle = 1655;\n");
    try {
      await expect.poll(() => document.querySelector(".editor-file-viewer__plain")).not.toBeNull();
      await openFind("pendingPaintNeedle");
      await expect.element(page.getByText("1 / 1", { exact: true })).toBeVisible();
      expect(findRange()?.toString()).toBe("pendingPaintNeedle");
      release();
      await expect
        .poll(() => document.querySelector('[data-syntax-highlighted="true"]'))
        .not.toBeNull();
      await expect.poll(() => findRange()?.toString()).toBe("pendingPaintNeedle");
      const highlighted = document.querySelector('[data-syntax-highlighted="true"]')!;
      expect(highlighted.contains(findRange()?.startContainer ?? null)).toBe(true);
    } finally {
      release();
      await mounted.dispose();
    }
  });

  it("paints and cleans a line fallback when CSS Custom Highlight is unavailable", async () => {
    vi.stubGlobal("Highlight", undefined);
    const mounted = await mountPreview("// an unmatched line\n// fallbackNeedle\n");
    try {
      await expect
        .poll(() => document.querySelector('[data-syntax-highlighted="true"]'))
        .not.toBeNull();
      const lines = document.querySelectorAll<HTMLElement>(".editor-file-viewer .line");
      const normal = getComputedStyle(lines[0]!).backgroundColor;
      const originalMatch = getComputedStyle(lines[1]!).backgroundColor;
      await openFind("fallbackNeedle");
      await expect.element(page.getByText("1 / 1", { exact: true })).toBeVisible();
      expect(getComputedStyle(lines[0]!).backgroundColor).toBe(normal);
      expect(getComputedStyle(lines[1]!).backgroundColor).not.toBe(originalMatch);
      await page.getByRole("button", { name: "Close find (Esc)" }).click();
      expect(getComputedStyle(lines[1]!).backgroundColor).toBe(originalMatch);
    } finally {
      await mounted.dispose();
    }
  });
});
