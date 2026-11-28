import "../../index.css";
import type { FilesystemBrowseInput, FilesystemBrowseResult } from "@synara/contracts";
import { page, userEvent } from "vitest/browser";
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
  await page.getByLabelText("Folder path", { exact: true }).fill("/chosen");
  resolveInitial({ parentPath: "/home", entries: [] });
  await expect.element(page.getByText("/home", { exact: true })).toBeVisible();
  await expect.element(page.getByLabelText("Folder path", { exact: true })).toHaveValue("/chosen");
  await expect.element(page.getByRole("button", { name: "Use folder" })).toBeDisabled();
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.getByRole("button", { name: "Use folder" }).click();
  expect(await selected).toBe("/chosen");
});

it("completes a host path, opens it, and creates a child there", async () => {
  let resolveStale!: (listing: FilesystemBrowseResult) => void;
  const stale = new Promise<FilesystemBrowseResult>((resolve) => {
    resolveStale = resolve;
  });
  const browse = vi.fn(async ({ partialPath }: { partialPath: string }) => {
    if (partialPath === "/older") return stale;
    if (partialPath === "/vol/d")
      return { parentPath: "/vol", entries: [{ name: "data", fullPath: "/vol/data" }] };
    return {
      parentPath: partialPath === "~/" ? "/vol" : partialPath.replace(/\/$/, ""),
      entries: [],
    };
  });
  const createFolder = vi.fn(async ({ parentPath, name }: { parentPath: string; name: string }) => {
    if (name === "taken") throw new Error("Folder already exists");
    return parentPath + "/" + name;
  });
  const selected = showExecutionFolderPicker({ label: "Mac mini", browse, createFolder });
  const field = page.getByLabelText("Folder path", { exact: true });
  await expect.element(field).toHaveValue("/vol");
  await field.fill("/older");
  await userEvent.keyboard("{Tab}");
  await vi.waitFor(() =>
    expect(browse).toHaveBeenCalledWith({ partialPath: "/older", cwd: "/vol" }),
  );
  await field.fill("/vol/d");
  await userEvent.keyboard("{Tab}");
  await expect.element(field).toHaveValue("/vol/data/");
  resolveStale({
    parentPath: "/",
    entries: [{ name: "older-result", fullPath: "/older-result" }],
  });
  await expect.element(field).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await page.getByRole("button", { name: "New folder" }).click();
  const name = page.getByLabelText("Folder name");
  await name.fill("taken");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Folder already exists");
  await name.fill("child");
  await userEvent.keyboard("{Enter}");
  await expect.element(field).toHaveValue("/vol/data/child");
  await page.getByRole("button", { name: "Use folder" }).click();
  expect(await selected).toBe("/vol/data/child");
});

it("completes and opens relative paths from the displayed folder", async () => {
  const browse = vi.fn(async ({ partialPath, cwd }: FilesystemBrowseInput) => {
    if (partialPath === "~/") return { parentPath: "/workspace", entries: [] };
    if (cwd === "/workspace" && partialPath === "./chi")
      return {
        parentPath: cwd,
        entries: [{ name: "child", fullPath: "/workspace/child" }],
      };
    if (cwd === "/workspace" && partialPath === "child/")
      return { parentPath: "/workspace/child", entries: [] };
    throw new Error("Folder not found");
  });
  const selected = showExecutionFolderPicker({ label: "Mac mini", browse });
  const field = page.getByLabelText("Folder path");
  await expect.element(field).toHaveValue("/workspace");
  await field.fill("./chi");
  await userEvent.keyboard("{Tab}");
  await expect.element(field).toHaveValue("/workspace/child/");
  await field.fill("child");
  await page.getByRole("button", { name: "Go", exact: true }).click();
  await page.getByRole("button", { name: "Use folder" }).click();
  expect(await selected).toBe("/workspace/child");
});

it("preserves a Unix folder name ending in a literal backslash", async () => {
  const parent = "/folders/name\\";
  const browse = vi.fn(async ({ partialPath }: { partialPath: string }) =>
    partialPath === "~/"
      ? { parentPath: "/folders", entries: [{ name: "name\\", fullPath: parent }] }
      : { parentPath: parent, entries: [] },
  );
  const selected = showExecutionFolderPicker({ label: "Linux", browse });
  await page.getByRole("button", { name: "name\\", exact: true }).click();
  await expect.element(page.getByLabelText("Folder path")).toHaveValue(parent);
  expect(browse).toHaveBeenCalledWith({ partialPath: parent + "/" });
  await page.getByRole("button", { name: "Use folder" }).click();
  expect(await selected).toBe(parent);
});

it("keeps a pending folder write visible until its outcome can be shown", async () => {
  let finish!: () => void;
  const createFolder = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = () => resolve("/parent/child");
      }),
  );
  const browse = vi.fn(async ({ partialPath }: { partialPath: string }) => ({
    parentPath: partialPath === "~/" ? "/parent" : "/parent/child",
    entries: [],
  }));
  const selected = showExecutionFolderPicker({ label: "Computer", browse, createFolder });
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByLabelText("Folder name").fill("child");
  await page.getByRole("button", { name: "Create folder" }).click();
  await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("heading", { name: "Choose a folder on Computer" }))
    .toBeVisible();
  finish();
  await expect.element(page.getByLabelText("Folder path")).toHaveValue("/parent/child");
  await page.getByRole("button", { name: "Use folder" }).click();
  expect(await selected).toBe("/parent/child");
});

it("shows the host's reason for string defects and errors from a workspace frame", async () => {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const FrameError = (frame.contentWindow as unknown as { Error: ErrorConstructor }).Error;
  const browse = vi.fn(async ({ partialPath }: { partialPath: string }) => {
    if (partialPath === "~/") throw "Expected a string, got a folder name";
    if (partialPath === "/Volumes/SSD/")
      throw new FrameError("EPERM: operation not permitted, scandir '/Volumes/SSD'");
    return { parentPath: "/", entries: [] };
  });
  try {
    const selected = showExecutionFolderPicker({ label: "Mac mini", browse });
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Expected a string, got a folder name");
    await page.getByLabelText("Folder path", { exact: true }).fill("/Volumes/SSD");
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("EPERM: operation not permitted, scandir '/Volumes/SSD'");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await selected).toBeNull();
  } finally {
    frame.remove();
  }
});

it("keeps the last readable folder usable after a folder fails to open", async () => {
  const browse = vi.fn(async ({ partialPath }: { partialPath: string }) => {
    if (partialPath === "/Volumes/SSD/")
      throw new Error("EPERM: operation not permitted, scandir '/Volumes/SSD'");
    if (partialPath === "/Volumes/Backup/")
      return {
        parentPath: "/Volumes/Backup",
        entries: [{ name: "Photos ", fullPath: "/Volumes/Backup/Photos " }],
      };
    if (partialPath === "/Volumes/../") return { parentPath: "/", entries: [] };
    return {
      parentPath: "/Volumes",
      entries: [
        { name: "Backup", fullPath: "/Volumes/Backup" },
        { name: "SSD", fullPath: "/Volumes/SSD" },
      ],
    };
  });
  const selected = showExecutionFolderPicker({ label: "Mac mini", browse });
  await page.getByRole("button", { name: "SSD", exact: true }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("EPERM");
  await expect.element(page.getByText("/Volumes", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Up", exact: true })).toBeEnabled();
  await expect.element(page.getByRole("button", { name: "Use folder" })).toBeEnabled();
  await page.getByRole("button", { name: "Backup", exact: true }).click();
  await expect.element(page.getByRole("button", { name: "Photos", exact: true })).toBeVisible();
  expect(page.getByRole("alert").elements()).toHaveLength(0);
  await page.getByRole("button", { name: "Use folder" }).click();
  expect(await selected).toBe("/Volumes/Backup");
});
