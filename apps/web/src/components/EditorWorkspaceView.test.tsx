// FILE: EditorWorkspaceView.test.tsx
// Purpose: Guards the editor-style shell layout around file/diff sidebars.
// Layer: Component rendering tests
// Depends on: EditorWorkspaceView and React server rendering.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { EditorWorkspaceView } from "./EditorWorkspaceView";
import { WorkspaceSearchSidebar } from "./chat/workspaceExplorer";
import { projectQueryKeys } from "../lib/projectReactQuery";
import { SidebarProvider } from "./ui/sidebar";

function renderToStaticMarkup(node: ReactNode) {
  return renderMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
}

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" }),
}));

vi.mock("~/hooks/useDesktopTopBarGutter", () => ({
  useDesktopTopBarTrafficLightGutterClassName: () => "traffic-light-gutter",
  useDesktopTopBarWindowControlsGutterClassName: () => "windows-caption-gutter",
}));

describe("EditorWorkspaceView", () => {
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
          editFilePath={null}
          editDiffBaseRev={null}
          onEditFile={vi.fn()}
          onCloseEdit={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </SidebarProvider>,
    );

    expect(markup).toContain('aria-label="Loading changed files…"');
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
            editFilePath={null}
            editDiffBaseRev={null}
            onEditFile={vi.fn()}
            onCloseEdit={vi.fn()}
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
          editFilePath={null}
          editDiffBaseRev={null}
          onEditFile={vi.fn()}
          onCloseEdit={vi.fn()}
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

  it("renders PDF files through the in-app PDF viewer instead of the text preview", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot="/Users/tester/project"
          projectName="project"
          selectedFilePath="docs/spec.pdf"
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
          editFilePath={null}
          editDiffBaseRev={null}
          onEditFile={vi.fn()}
          onCloseEdit={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    // The custom viewer renders its own surface (here the initial loading state
    // since document fetch runs in an effect) rather than the browser iframe or
    // the text preview.
    expect(markup).toContain('aria-label="Loading PDF…"');
    expect(markup).not.toContain("<iframe");
    expect(markup).not.toContain("editor-file-viewer__plain");
    expect(markup).not.toContain("editor-file-viewer__highlight");
  });

  it("renders scratch-workspace PDF previews without an attached workspace", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot={null}
          projectName="project"
          selectedFilePath="/tmp/synara-codex-workspaces/thread-1/report.pdf"
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
          editFilePath={null}
          editDiffBaseRev={null}
          onEditFile={vi.fn()}
          onCloseEdit={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('aria-label="Loading PDF…"');
    expect(markup).not.toContain("No workspace is attached");
  });

  it("renders scratch-workspace image previews without an attached workspace", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot={null}
          projectName="project"
          selectedFilePath="/tmp/synara-codex-workspaces/thread-1/shot.png"
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
          editFilePath={null}
          editDiffBaseRev={null}
          onEditFile={vi.fn()}
          onCloseEdit={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain("local-image-preview");
    expect(markup).toContain(
      "/api/local-image?path=%2Ftmp%2Fsynara-codex-workspaces%2Fthread-1%2Fshot.png",
    );
    expect(markup).not.toContain("No workspace is attached");
    expect(markup).not.toContain("cwd=");
  });

  it("renders absolute local image previews without an attached workspace", () => {
    const queryClient = new QueryClient();
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <EditorWorkspaceView
          workspaceRoot={null}
          projectName="project"
          selectedFilePath="/Users/tester/Downloads/shot.png"
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
          editFilePath={null}
          editDiffBaseRev={null}
          onEditFile={vi.fn()}
          onCloseEdit={vi.fn()}
          onExitEditorView={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('aria-label="Loading file…"');
    expect(markup).not.toContain("/api/local-image?path=%2FUsers%2Ftester%2FDownloads%2Fshot.png");
    expect(markup).not.toContain("No workspace is attached");
    expect(markup).not.toContain("cwd=");
  });

  it("lists only matching files from the workspace search results", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(
      projectQueryKeys.searchEntries("/Users/tester/project", "editor", 80, "file"),
      {
        entries: [{ path: "apps/web/src/components/EditorWorkspaceView.tsx", kind: "file" }],
        truncated: false,
      },
    );
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkspaceSearchSidebar
          workspaceRoot="/Users/tester/project"
          query="editor"
          onQueryChange={vi.fn()}
          selectedFilePath="apps/web/src/components/EditorWorkspaceView.tsx"
          onSelectFile={vi.fn()}
          onReferenceInChat={undefined}
        />
      </QueryClientProvider>,
    );

    expect(markup).toContain('title="apps/web/src/components/EditorWorkspaceView.tsx"');
    expect(markup).toContain("EditorWorkspaceView.tsx");
    expect(markup).not.toContain("No matching files.");
  });
});
