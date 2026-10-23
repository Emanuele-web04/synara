import "../../index.css";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { showExecutionFolderPicker } from "./ExecutionFolderPicker";

afterEach(async () => {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[role=dialog] button"))
    if (button.textContent === "Cancel") button.click();
  await Promise.resolve();
  document.documentElement.classList.remove("dark");
});
it.each(["light", "dark"])(
  "chooses a directory from the execution host, retries failure and cancels safely (%s)",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.viewport(1100, 760);
    let failed = true;
    const browse = vi.fn(async ({ partialPath }: { partialPath: string }) => {
      if (partialPath === "~/" && failed) {
        failed = false;
        throw new Error("Mac mini is reconnecting. Try again.");
      }
      if (partialPath === "/Users/mini/Developer/")
        return {
          parentPath: "/Users/mini/Developer",
          entries: [
            { name: "Synara", fullPath: "/Users/mini/Developer/synara" },
            { name: "Remodex", fullPath: "/Users/mini/Developer/remodex" },
          ],
        };
      return {
        parentPath: "/Users/mini",
        entries: [{ name: "Developer", fullPath: "/Users/mini/Developer" }],
      };
    });
    const selected = showExecutionFolderPicker({ label: "Mac mini", browse });
    await expect.element(page.getByRole("alert")).toHaveTextContent("Mac mini is reconnecting");
    await expect.element(page.getByRole("button", { name: "Use folder" })).toBeDisabled();
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await page.getByRole("button", { name: "Developer", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Synara", exact: true })).toBeVisible();
    await page.screenshot({ path: `./__screenshots__/folder-picker-${theme}.png` });
    await page.getByRole("button", { name: "Use folder" }).click();
    expect(await selected).toBe("/Users/mini/Developer");
    const cancelled = showExecutionFolderPicker({ label: "Mac mini", browse });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await cancelled).toBeNull();
  },
);

it("preserves a typed destination while the initial folder listing is still loading", async () => {
  let resolveInitial!: (value: { parentPath: string; entries: [] }) => void;
  const initial = new Promise<{ parentPath: string; entries: [] }>((resolve) => {
    resolveInitial = resolve;
  });
  const browse = vi.fn(async ({ partialPath }: { partialPath: string }) =>
    partialPath === "~/" ? initial : { parentPath: "/chosen", entries: [] },
  );
  const selected = showExecutionFolderPicker({ label: "Mac mini", browse });
  await page.getByRole("textbox", { name: "Folder path", exact: true }).fill("/chosen");
  resolveInitial({ parentPath: "/home", entries: [] });
  await expect.element(page.getByText("/home", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("textbox", { name: "Folder path", exact: true }))
    .toHaveValue("/chosen");
  await expect.element(page.getByRole("button", { name: "Use folder" })).toBeDisabled();
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.getByRole("button", { name: "Use folder" }).click();
  expect(await selected).toBe("/chosen");
});
