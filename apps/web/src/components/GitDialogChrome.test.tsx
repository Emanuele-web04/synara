import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitDialogContext } from "./GitActionsControl.logic";
import { GitCommitDialog } from "./GitCommitDialog";
import { GitCreatePrDialog } from "./GitCreatePrDialog";

// Render the dialog contents inline: server rendering omits portals.
vi.mock("./ui/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ui/dialog")>()),
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const context: GitDialogContext = {
  gitStatus: {
    branch: "feature/test",
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    upstreamBranch: "origin/feature/test",
    aheadCount: 1,
    behindCount: 0,
    pr: null,
  },
  isBusy: false,
  isDefaultBranch: false,
  hasOriginRemote: true,
  defaultBranchName: "main",
};

afterEach(() => vi.unstubAllGlobals());

function expectPrimaryShortcut(html: string, label: string, hint: string, shortcut: string) {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const primary = buttons.find((button) => button.includes(`>${label}</span>`));
  expect(primary).toBeDefined();
  expect(primary).toContain(`aria-label="${hint}"`);
  expect(primary).toContain(`aria-keyshortcuts="${shortcut}"`);
  expect(html.match(/aria-keyshortcuts=/g)).toHaveLength(1);
}

describe.each([
  { platform: "MacIntel", hint: "⌘↵", shortcut: "Meta+Enter" },
  { platform: "Win32", hint: "Ctrl ↵", shortcut: "Control+Enter" },
])("git dialog submit accessibility on $platform", ({ platform, hint, shortcut }) => {
  it("exposes the commit shortcut only on the primary button", () => {
    vi.stubGlobal("navigator", { platform });
    const html = renderToStaticMarkup(
      <GitCommitDialog
        open
        onOpenChange={vi.fn()}
        context={context}
        defaultAttribution
        onSubmit={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );

    expectPrimaryShortcut(html, "Commit", hint, shortcut);
  });

  it("exposes the create PR shortcut only on the primary button", () => {
    vi.stubGlobal("navigator", { platform });
    const html = renderToStaticMarkup(
      <GitCreatePrDialog
        open
        onOpenChange={vi.fn()}
        context={context}
        defaultAttribution
        onSubmit={vi.fn()}
        onOpenInBrowser={vi.fn()}
      />,
    );

    expectPrimaryShortcut(html, "Create PR", hint, shortcut);
  });
});

const contextWithFiles: GitDialogContext = {
  ...context,
  gitStatus: {
    ...context.gitStatus!,
    workingTree: {
      files: [{ path: "src/a.ts", insertions: 2, deletions: 1 }],
      insertions: 2,
      deletions: 1,
    },
  },
};

/** The checkbox state of the "Add Synara attribution" row, or null when it is not rendered. */
function attributionCheckboxState(html: string): string | null {
  const row = (html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? []).find((label) =>
    label.includes("Add Synara attribution"),
  );
  if (!row) return null;
  return row.match(/aria-checked="(true|false)"/)?.[1] ?? "missing";
}

describe("git dialog attribution option", () => {
  it.each([true, false])("seeds the Create PR checkbox from the setting (%s)", (enabled) => {
    const html = renderToStaticMarkup(
      <GitCreatePrDialog
        open
        onOpenChange={vi.fn()}
        context={context}
        defaultAttribution={enabled}
        onSubmit={vi.fn()}
        onOpenInBrowser={vi.fn()}
      />,
    );
    expect(attributionCheckboxState(html)).toBe(String(enabled));
  });

  it.each([true, false])("seeds the Commit checkbox from the setting (%s)", (enabled) => {
    const html = renderToStaticMarkup(
      <GitCommitDialog
        open
        onOpenChange={vi.fn()}
        context={contextWithFiles}
        defaultAttribution={enabled}
        onSubmit={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );
    expect(attributionCheckboxState(html)).toBe(String(enabled));
  });

  it("hides the Commit checkbox when there is nothing to commit", () => {
    const html = renderToStaticMarkup(
      <GitCommitDialog
        open
        onOpenChange={vi.fn()}
        context={context}
        defaultAttribution
        onSubmit={vi.fn()}
        onOpenFile={vi.fn()}
      />,
    );
    expect(attributionCheckboxState(html)).toBeNull();
  });
});
