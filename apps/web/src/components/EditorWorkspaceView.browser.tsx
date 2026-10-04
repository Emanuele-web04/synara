// FILE: EditorWorkspaceView.browser.tsx
// Purpose: Preserve explicit Markdown view choices across editor navigation.
// Layer: Component browser regressions

import "../index.css";

import type { NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { EditorWorkspaceView } from "./EditorWorkspaceView";
import { SidebarProvider } from "./ui/sidebar";

const WORKSPACE_ROOT = "/Users/tester/project";
let previousApi: PropertyDescriptor | undefined;

beforeEach(() => {
  previousApi = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      projects: {
        readFile: vi.fn(async ({ relativePath }: { relativePath: string }) => ({
          relativePath,
          contents: "# Markdown document\n",
          truncated: false,
          version: `sha256:${"1".repeat(64)}`,
          encoding: "utf8",
          lineEnding: "lf",
        })),
        searchEntries: vi.fn(async () => ({ entries: [], truncated: false })),
        listDirectories: vi.fn(async () => ({ directories: [] })),
      },
      git: { readWorkingTreeDiff: vi.fn(async () => ({ patch: "", truncated: false })) },
    } as unknown as NativeApi,
  });
});

afterEach(async () => {
  await cleanup();
  if (previousApi) Object.defineProperty(window, "nativeApi", previousApi);
  else Reflect.deleteProperty(window, "nativeApi");
});

function makeView() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    centerMode: "file" | "diff" | "fileEdit" = "file",
    filePath = "README.md",
    workspaceRoot = WORKSPACE_ROOT,
  ) => (
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        <EditorWorkspaceView
          workspaceRoot={workspaceRoot}
          projectName="project"
          selectedFilePath={filePath}
          expandedDirectories={new Set()}
          centerMode={centerMode}
          diffFiles={[]}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff pane</div>}
          chatPanel={<div>Chat pane</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          editFilePath={centerMode === "fileEdit" ? filePath : null}
          editDiffBaseRev={null}
          onEditFile={vi.fn()}
          onCloseEdit={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </SidebarProvider>
    </QueryClientProvider>
  );
}

const source = () => page.getByRole("radio", { name: "Source", exact: true });
const preview = () => page.getByRole("radio", { name: "Preview", exact: true });

it.each(["diff"] as const)("keeps Source after visiting %s", async (mode) => {
  const view = makeView();
  const screen = await render(view());
  await expect.element(preview()).toHaveAttribute("aria-checked", "true");
  await source().click();
  await expect.element(source()).toHaveAttribute("aria-checked", "true");

  await screen.rerender(view(mode));
  await expect.element(source()).not.toBeInTheDocument();
  await screen.rerender(view());
  await expect.element(source()).toHaveAttribute("aria-checked", "true");
});

it("keeps independent choices for multiple files and workspaces", async () => {
  const view = makeView();
  const screen = await render(view());
  await source().click();
  await screen.rerender(view("file", "docs/guide.markdown"));
  await expect.element(preview()).toHaveAttribute("aria-checked", "true");
  await source().click();
  await screen.rerender(view());
  await expect.element(source()).toHaveAttribute("aria-checked", "true");
  await preview().click();
  await screen.rerender(view("file", "docs/guide.markdown"));
  await expect.element(source()).toHaveAttribute("aria-checked", "true");
  await screen.rerender(view("file", "docs/guide.markdown", "/Users/tester/other"));
  await expect.element(preview()).toHaveAttribute("aria-checked", "true");
  await screen.rerender(view("file", "docs/guide.markdown"));
  await expect.element(source()).toHaveAttribute("aria-checked", "true");
});

it("keeps non-Markdown files in Source without a Markdown toggle", async () => {
  const screen = await render(makeView()("file", "src/app.ts"));
  await expect.element(source()).not.toBeInTheDocument();
  await expect.element(preview()).not.toBeInTheDocument();
  await screen.unmount();
});
