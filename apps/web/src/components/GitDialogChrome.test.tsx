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
  { platform: "Linux x86_64", hint: "Ctrl ↵", shortcut: "Control+Enter" },
])("git dialog submit accessibility on $platform", ({ platform, hint, shortcut }) => {
  it("exposes the commit shortcut only on the primary button", () => {
    vi.stubGlobal("navigator", { platform });
    const html = renderToStaticMarkup(
      <GitCommitDialog
        open
        onOpenChange={vi.fn()}
        context={context}
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
        onSubmit={vi.fn()}
        onOpenInBrowser={vi.fn()}
      />,
    );

    expectPrimaryShortcut(html, "Create PR", hint, shortcut);
  });
});
