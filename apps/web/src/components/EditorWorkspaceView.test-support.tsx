import type { NativeApi } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "vitest-browser-react";
import { EditorWorkspaceView } from "./EditorWorkspaceView";
import { SidebarProvider } from "./ui/sidebar";

const WORKSPACE_ROOT = "/Users/tester/project";
let previousApi: PropertyDescriptor | undefined;
let previousAppearance: Map<string, string | null>;

export function installEditorWorkspaceFixture() {
  beforeEach(() => {
    previousAppearance = new Map(
      ["style", "class", "data-window-material", "data-window-translucency"].map((attribute) => [
        attribute,
        document.documentElement.getAttribute(attribute),
      ]),
    );
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
    for (const [attribute, value] of previousAppearance) {
      if (value === null) document.documentElement.removeAttribute(attribute);
      else document.documentElement.setAttribute(attribute, value);
    }
    if (previousApi) Object.defineProperty(window, "nativeApi", previousApi);
    else Reflect.deleteProperty(window, "nativeApi");
  });
}

export function makeView() {
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
