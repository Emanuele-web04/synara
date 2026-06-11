// FILE: EditorWorkspaceView.test.tsx
// Purpose: Guards the editor-style shell layout around file/diff sidebars.
// Layer: Component rendering tests
// Depends on: EditorWorkspaceView and React server rendering.

import type { FileDiffMetadata } from "@pierre/diffs/react";
import { ProjectId } from "@t3tools/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { EditorWorkspaceView } from "./EditorWorkspaceView";

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("~/hooks/useDesktopTopBarGutter", () => ({
  useDesktopTopBarWindowControlsGutterClassName: () => "windows-caption-gutter",
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
  it("renders a project switcher arrow beside the project title", () => {
    const markup = renderToStaticMarkup(
      <EditorWorkspaceView
        workspaceRoot="/Users/tester/project"
        projectName="project"
        currentProjectId={ProjectId.makeUnsafe("project-current")}
        projectOptions={[
          {
            id: ProjectId.makeUnsafe("project-current"),
            name: "project",
            folderName: "project",
            localName: null,
            cwd: "/Users/tester/project",
          },
        ]}
        selectedFilePath={null}
        expandedDirectories={new Set()}
        centerMode="diff"
        diffFiles={[]}
        selectedDiffFilePath={null}
        diffPanel={<div>Diff panel</div>}
        chatPanel={<div>Chat panel</div>}
        onSelectFile={vi.fn()}
        onSelectDiffFile={vi.fn()}
        onToggleDirectory={vi.fn()}
        onCenterModeChange={vi.fn()}
        onExitEditorView={vi.fn()}
        onSelectProject={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Switch project"');
    expect(markup).toContain("project");
  });

  it("reserves a top-bar gutter for Windows caption controls", () => {
    const markup = renderToStaticMarkup(
      <EditorWorkspaceView
        workspaceRoot="/Users/tester/project"
        projectName="project"
        selectedFilePath={null}
        expandedDirectories={new Set()}
        centerMode="diff"
        diffFiles={[]}
        selectedDiffFilePath={null}
        diffPanel={<div>Diff panel</div>}
        chatPanel={<div>Chat panel</div>}
        onSelectFile={vi.fn()}
        onSelectDiffFile={vi.fn()}
        onToggleDirectory={vi.fn()}
        onCenterModeChange={vi.fn()}
        onExitEditorView={vi.fn()}
      />,
    );

    expect(markup).toContain("windows-caption-gutter");
  });

  it("renders diff options beside the changed-file line totals", () => {
    const markup = renderToStaticMarkup(
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
      />,
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
      />,
    );

    expect(markup).toContain('aria-label="Loading changed files..."');
    expect(markup).not.toContain("No files in this diff.");
  });

  it("keeps the diff panel mounted but hidden while browsing files", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
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
      </QueryClientProvider>,
    );

    expect(markup).toContain("Diff panel body");
    const diffWrapperIndex = markup.indexOf("Diff panel body");
    const hiddenIndex = markup.lastIndexOf("hidden", diffWrapperIndex);
    expect(hiddenIndex).toBeGreaterThan(-1);
  });

  it("renders image files through the local image preview instead of text preview", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath="assets/screenshot.png"
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
      </QueryClientProvider>,
    );

    expect(markup).toContain("local-image-preview");
    expect(markup).toContain(
      "/api/local-image?path=assets%2Fscreenshot.png&amp;cwd=%2FUsers%2Ftester%2Fproject",
    );
    expect(markup).not.toContain("editor-file-viewer__plain");
    expect(markup).not.toContain("editor-file-viewer__highlight");
  });

  it("shows a Markdown preview toggle for Markdown files", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath="README.md"
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
      </QueryClientProvider>,
    );

    expect(markup).toContain('aria-label="Show Markdown preview"');
    expect(markup).toContain('aria-pressed="false"');
  });

  it("shows pointer cursor on activity buttons that switch files and diff", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
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
      </QueryClientProvider>,
    );

    // Files is the active mode with a visible sidebar, so its button reads as
    // a sidebar collapse toggle; Diff stays a plain mode switch.
    expect(markup).toContain('aria-label="Hide files sidebar"');
    expect(markup).toContain('aria-label="Diff"');
    expect(markup.match(/cursor-pointer/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
