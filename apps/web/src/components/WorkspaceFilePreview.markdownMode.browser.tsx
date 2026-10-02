// FILE: WorkspaceFilePreview.markdownMode.browser.tsx
// Purpose: Browser regression for per-file markdown view-mode memory — each
//          file keeps its own Source/Preview choice when switching files.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi, ProjectReadFileResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

const WORKSPACE_ROOT = "/Users/tester/project";
const FILE_A = "docs/alpha.md";
const FILE_B = "docs/beta.md";
const FILE_CONTENTS: Record<string, string> = {
  [FILE_A]: "# Alpha\n\nFirst file body\n",
  [FILE_B]: "# Beta\n\nSecond file body\n",
};

function installNativeApi(api: NativeApi): () => void {
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: api,
  });
  return () => {
    if (previousDescriptor) {
      Object.defineProperty(window, "nativeApi", previousDescriptor);
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
  };
}

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function loadedMarkdown(relativePath: string): ProjectReadFileResult {
  const contents = FILE_CONTENTS[relativePath];
  if (contents === undefined) {
    throw new Error(`Unexpected file read: ${relativePath}`);
  }
  return {
    relativePath,
    contents,
    truncated: false,
    version: `sha256:${"1".repeat(64)}`,
    encoding: "utf8",
    lineEnding: "lf",
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("remembers each file's markdown view mode when switching between files", async () => {
  const readFile = vi.fn(async (input: { relativePath: string }) =>
    loadedMarkdown(input.relativePath),
  );
  const restoreNativeApi = installNativeApi({ projects: { readFile } } as unknown as NativeApi);
  const queryClient = makeQueryClient();
  const previewRadio = () => page.getByRole("radio", { name: "Preview" });
  const sourceRadio = () => page.getByRole("radio", { name: "Source" });

  try {
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_A} />
      </QueryClientProvider>,
    );

    // Explorer-style surfaces are source-first by default.
    await expect.element(sourceRadio()).toHaveAttribute("aria-checked", "true");

    await previewRadio().click();
    await expect.element(page.getByRole("heading", { name: "Alpha" })).toBeVisible();

    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_B} />
      </QueryClientProvider>,
    );

    // File B has no remembered choice yet, so it opens in the source default.
    await expect.element(sourceRadio()).toHaveAttribute("aria-checked", "true");

    await previewRadio().click();
    await expect.element(page.getByRole("heading", { name: "Beta" })).toBeVisible();

    // Returning to file A restores its own Preview choice instead of dropping
    // back to the default.
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_A} />
      </QueryClientProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
    await expect.element(previewRadio()).toHaveAttribute("aria-checked", "true");

    // File B's choice is independent of file A's.
    await screen.rerender(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot={WORKSPACE_ROOT} filePath={FILE_B} />
      </QueryClientProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "Beta" })).toBeVisible();
    await expect.element(previewRadio()).toHaveAttribute("aria-checked", "true");
  } finally {
    restoreNativeApi();
  }
});
