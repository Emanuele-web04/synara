// FILE: EditorWorkspaceView.test.tsx
// Purpose: Guards the editor-style shell layout around file/diff sidebars.
// Layer: Component rendering tests
// Depends on: EditorWorkspaceView and React server rendering.

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EditorWorkspaceView } from "./EditorWorkspaceView";
import { SidebarProvider } from "./ui/sidebar";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

function createFileDiff(path: string, additions: number, deletions: number): FileDiffMetadata {
  return {
    cacheKey: path,
    name: path,
    prevName: path,
    hunks: [
      {
        additionLines: additions,
        deletionLines: deletions,
      },
    ],
  } as FileDiffMetadata;
}

describe("EditorWorkspaceView", () => {
  it("renders diff options beside the changed-file line totals", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath={null}
          expandedDirectories={new Set()}
          centerMode="diff"
          diffFiles={[createFileDiff("apps/web/src/components/EditorWorkspaceView.tsx", 3, 1)]}
          selectedDiffFilePath={null}
          diffOptionsControl={
            <button type="button" aria-label="Diff options">
              Options
            </button>
          }
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain("Changed files");
    expect(markup).toContain("+3");
    expect(markup).toContain("-1");
    expect(markup).toContain('aria-label="Diff options"');

    // Options sit in the "Changed files" header row; the +/- totals render in
    // the stats row below it.
    const changedFilesIndex = markup.indexOf("Changed files");
    const optionsIndex = markup.indexOf('aria-label="Diff options"', changedFilesIndex);
    const additionsIndex = markup.indexOf(">+3<", optionsIndex);
    const deletionsIndex = markup.indexOf(">-1<", additionsIndex);

    expect(optionsIndex).toBeGreaterThan(changedFilesIndex);
    expect(additionsIndex).toBeGreaterThan(optionsIndex);
    expect(deletionsIndex).toBeGreaterThan(additionsIndex);
  });

  it("shows skeleton rows instead of the empty message while the diff loads", () => {
    const markup = renderToStaticMarkup(
      <SidebarProvider>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath={null}
          expandedDirectories={new Set()}
          centerMode="diff"
          diffFiles={[]}
          diffFilesLoading={true}
          selectedDiffFilePath={null}
          diffPanel={<div>Diff panel</div>}
          chatPanel={<div>Chat panel</div>}
          onSelectFile={vi.fn()}
          onSelectDiffFile={vi.fn()}
          onToggleDirectory={vi.fn()}
          onCenterModeChange={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain('aria-label="Loading changed files..."');
    expect(markup).not.toContain("No files in this diff.");
  });

  it("keeps the diff panel mounted but hidden while browsing files", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <EditorWorkspaceView
            workspaceRoot={null}
            projectName="project"
            selectedFilePath={null}
            expandedDirectories={new Set()}
            centerMode="file"
            diffFiles={[]}
            selectedDiffFilePath={null}
            diffPanel={<div>Diff panel body</div>}
            chatPanel={<div>Chat panel</div>}
            onSelectFile={vi.fn()}
            onSelectDiffFile={vi.fn()}
            onToggleDirectory={vi.fn()}
            onCenterModeChange={vi.fn()}
            onExitEditorView={vi.fn()}
          />
        </SidebarProvider>
      </QueryClientProvider>,
    );

    expect(markup).toContain("Diff panel body");
    const diffWrapperIndex = markup.indexOf("Diff panel body");
    const hiddenIndex = markup.lastIndexOf("hidden", diffWrapperIndex);
    expect(hiddenIndex).toBeGreaterThan(-1);
  });

  it("shows pointer cursor on activity buttons that switch files and diff", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <SidebarProvider>
          <EditorWorkspaceView
            workspaceRoot="/Users/tester/project"
            projectName="project"
            selectedFilePath={null}
            expandedDirectories={new Set()}
            centerMode="file"
            diffFiles={[]}
            selectedDiffFilePath={null}
            diffPanel={<div>Diff panel</div>}
            chatPanel={<div>Chat panel</div>}
            onSelectFile={vi.fn()}
            onSelectDiffFile={vi.fn()}
            onToggleDirectory={vi.fn()}
            onCenterModeChange={vi.fn()}
            onExitEditorView={vi.fn()}
          />
        </SidebarProvider>
      </QueryClientProvider>,
    );

    // Files is the active mode with a visible sidebar, so its button reads as
    // a sidebar collapse toggle; Diff stays a plain mode switch.
    expect(markup).toContain('aria-label="Hide files sidebar"');
    expect(markup).toContain('aria-label="Diff"');
    expect(markup.match(/cursor-pointer/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
