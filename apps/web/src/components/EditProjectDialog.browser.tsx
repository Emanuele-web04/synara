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
