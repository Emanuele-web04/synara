import "../../../index.css";

import type { ResolvedKeybindingsConfig } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  remote: false,
  openInEditor: vi.fn<(...args: unknown[]) => Promise<void>>(),
  toast: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({ shell: { openInEditor: fixture.openInEditor } }),
}));
vi.mock("~/lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: () => ({ remote: fixture.remote ? { environmentId: "remote" } : null }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: fixture.toast } }));

import { EnvironmentEditorSection } from "./EnvironmentEditorSection";
import { useOpenFavoriteEditorShortcut } from "~/hooks/useOpenFavoriteEditorShortcut";

const favoriteShortcut: ResolvedKeybindingsConfig = [
  {
    command: "editor.openFavorite",
    shortcut: {
      key: "o",
      altKey: true,
      shiftKey: true,
      ctrlKey: false,
      metaKey: false,
      modKey: false,
    },
  },
];

function FavoriteEditorShortcut() {
  useOpenFavoriteEditorShortcut({
    keybindings: favoriteShortcut,
    availableEditors: ["cursor", "vscode"],
    openInTarget: "/project",
  });
  return null;
}

beforeEach(() => {
  fixture.remote = false;
  fixture.openInEditor.mockReset().mockResolvedValue(undefined);
  fixture.toast.mockClear();
  localStorage.setItem("synara:last-editor", JSON.stringify("cursor"));
});

function renderSection(onOpenEditorView = vi.fn()) {
  return render(
    <EnvironmentEditorSection
      keybindings={[]}
      availableEditors={["cursor", "vscode"]}
      openInTarget="/project"
      onOpenEditorView={onOpenEditorView}
    />,
  );
}

describe("Environment editor actions", () => {
  it.each([false, true])(
    "handles the favorite-editor shortcut using its execution capability (remote=%s)",
    async (remote) => {
      fixture.remote = remote;
      fixture.openInEditor.mockRejectedValue(new Error("The editor could not be started."));
      await render(<FavoriteEditorShortcut />);
      const event = new KeyboardEvent("keydown", {
        key: "o",
        altKey: true,
        shiftKey: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      if (remote) {
        expect(event.defaultPrevented).toBe(false);
        expect(fixture.openInEditor).not.toHaveBeenCalled();
        expect(fixture.toast).not.toHaveBeenCalled();
      } else {
        expect(event.defaultPrevented).toBe(true);
        await vi.waitFor(() =>
          expect(fixture.toast).toHaveBeenCalledWith({
            type: "error",
            title: "Could not open editor",
            description: "The editor could not be started.",
          }),
        );
        expect(fixture.openInEditor).toHaveBeenCalledWith("/project", "cursor");
      }
    },
  );

  it("keeps the in-app editor available remotely without offering external launchers", async () => {
    fixture.remote = true;
    const openEditorView = vi.fn();
    await renderSection(openEditorView);
    await page.getByRole("button", { name: "Editor view", exact: true }).click();
    expect(openEditorView).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("button", { name: /^Open in / })).not.toBeInTheDocument();
    expect(fixture.openInEditor).not.toHaveBeenCalled();
  });

  it("reports a failed launch and keeps the previous preferred editor", async () => {
    fixture.openInEditor.mockRejectedValue(new Error("The editor could not be started."));
    await renderSection();
    await page.getByRole("button", { name: "Open in Cursor", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "VS Code", exact: true }).click();
    await vi.waitFor(() =>
      expect(fixture.toast).toHaveBeenCalledWith({
        type: "error",
        title: "Could not open editor",
        description: "The editor could not be started.",
      }),
    );
    expect(localStorage.getItem("synara:last-editor")).toBe(JSON.stringify("cursor"));
    await expect
      .element(page.getByRole("button", { name: "Open in Cursor", exact: true }))
      .toBeVisible();
  });

  it("remembers the selected editor after a successful local launch", async () => {
    await renderSection();
    await page.getByRole("button", { name: "Open in Cursor", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "VS Code", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Open in VS Code", exact: true }))
      .toBeVisible();
    expect(fixture.openInEditor).toHaveBeenCalledWith("/project", "vscode");
    expect(fixture.toast).not.toHaveBeenCalled();
  });
});
