import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { EditProjectDialog, type EditProjectValue } from "./EditProjectDialog";

function renderDialog(onSave: (value: EditProjectValue) => void) {
  return render(
    <EditProjectDialog
      open
      cwd="/tmp/ws-alpha"
      folderName="ws-alpha"
      initialValue={{ name: "", appearance: null }}
      onOpenChange={() => {}}
      onSave={onSave}
    />,
  );
}

function renderFoldersDialog(
  onSave: (value: EditProjectValue) => void | Promise<void>,
  onOpenChange: (open: boolean) => void = () => {},
) {
  return render(
    <EditProjectDialog
      open
      cwd="/tmp/ws-alpha"
      folderName="ws-alpha"
      initialValue={{ name: "", appearance: null, additionalFolders: ["/tmp/ws-api"] }}
      editFolders
      onOpenChange={onOpenChange}
      onSave={onSave}
    />,
  );
}

describe("EditProjectDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("saves the typed name with the icon and color chosen in the picker", async () => {
    const onSave = vi.fn();
    const screen = await renderDialog(onSave);
    try {
      await page.getByRole("textbox", { name: "Project name" }).fill("Alpha");
      await page.getByRole("button", { name: "Choose icon" }).click();
      await page.getByRole("radio", { name: "Blue" }).click();
      await page.getByRole("radio", { name: "Launch" }).click();
      await page.getByRole("button", { name: "Save" }).click();

      expect(onSave).toHaveBeenCalledWith({
        name: "Alpha",
        appearance: { kind: "icon", icon: "rocket", color: "blue" },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("adds and removes extra folders while the primary folder stays fixed", async () => {
    const onSave = vi.fn();
    const screen = await renderFoldersDialog(onSave);
    try {
      await expect
        .element(page.getByRole("button", { name: "Remove ws-alpha" }))
        .not.toBeInTheDocument();
      await page.getByRole("textbox", { name: "Additional folder path" }).fill("/tmp/ws-docs");
      await page.getByRole("button", { name: "Add folder" }).click();
      await page.getByRole("button", { name: "Remove ws-api" }).click();
      await page.getByRole("button", { name: "Save" }).click();

      expect(onSave).toHaveBeenCalledWith({
        name: "",
        appearance: null,
        additionalFolders: ["/tmp/ws-docs"],
      });
    } finally {
      await screen.unmount();
    }
  });

  it("refuses a folder nested inside the primary folder", async () => {
    const onSave = vi.fn();
    const screen = await renderFoldersDialog(onSave);
    try {
      await page.getByRole("textbox", { name: "Additional folder path" }).fill("/tmp/ws-alpha/src");
      await page.getByRole("button", { name: "Add folder" }).click();

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("src is inside ws-alpha. Add only one of them.");
      await expect
        .element(page.getByRole("textbox", { name: "Additional folder path" }))
        .toHaveValue("/tmp/ws-alpha/src");
    } finally {
      await screen.unmount();
    }
  });

  it("stays open and shows why a save was refused", async () => {
    const onOpenChange = vi.fn();
    const screen = await renderFoldersDialog(
      () => Promise.reject(new Error("Project directory does not exist: /tmp/ws-api")),
      onOpenChange,
    );
    try {
      await page.getByRole("button", { name: "Save" }).click();

      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Project directory does not exist: /tmp/ws-api");
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
    } finally {
      await screen.unmount();
    }
  });

  it("keeps focus in the picker when its empty space is clicked", async () => {
    const screen = await renderDialog(() => {});
    try {
      await page.getByRole("button", { name: "Choose icon" }).click();
      const search = page.getByRole("searchbox", { name: "Search icons" });
      await expect.element(search).toHaveFocus();

      // The right end of the tab row is picker background, not a control.
      const tabs = page.getByRole("tablist", { name: "Project icon type" });
      const { width, height } = tabs.element().getBoundingClientRect();
      await tabs.click({ position: { x: width - 8, y: height / 2 } });

      await expect.element(page.getByRole("textbox", { name: "Project name" })).not.toHaveFocus();
      await expect.element(search).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
