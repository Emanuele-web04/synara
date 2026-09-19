import "../index.css";

import { ProjectId, ThreadId, type ListProjectImportsResult } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({
  listProjectImports: vi.fn(),
  importProject: vi.fn(),
  getShellSnapshot: vi.fn(),
  syncSnapshot: vi.fn(),
}));
vi.mock("../nativeApi", () => ({ ensureNativeApi: () => ({ orchestration: api }) }));
vi.mock("../store", () => ({
  useStore: (select: (state: { syncServerShellSnapshot: typeof api.syncSnapshot }) => unknown) =>
    select({ syncServerShellSnapshot: api.syncSnapshot }),
}));

import { ProjectImportPanel } from "../projectImport/ProjectImportPanel";

const catalog: ListProjectImportsResult = {
  sources: [
    { provider: "codex", error: null },
    { provider: "claudeAgent", error: null },
  ],
  projects: [
    {
      key: "project",
      title: "Synara",
      workspaceRoot: "/code/synara",
      directoryExists: true,
      existingProjectId: ProjectId.makeUnsafe("synara"),
      providers: ["codex", "claudeAgent"],
      threads: [
        {
          key: "first",
          title: "First conversation",
          provider: "codex",
          cwd: "/code/synara",
          archived: false,
          alreadyImported: false,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          key: "second",
          title: "Second conversation",
          provider: "claudeAgent",
          cwd: "/code/synara",
          archived: false,
          alreadyImported: false,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
        {
          key: "existing",
          title: "Existing conversation",
          provider: "codex",
          cwd: "/code/synara",
          archived: false,
          alreadyImported: true,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      ],
    },
  ],
};
const imported = {
  projectId: ProjectId.makeUnsafe("synara"),
  threadId: ThreadId.makeUnsafe("copy"),
  status: "imported",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listProjectImports.mockResolvedValue(catalog);
  api.importProject.mockReset().mockResolvedValue(imported);
  api.getShellSnapshot.mockResolvedValue({});
});

describe("project import panel", () => {
  it("discovers only on request and retries only failures without reimporting successful or existing conversations", async () => {
    const onResult = vi.fn();
    await render(<ProjectImportPanel onBusyChange={vi.fn()} onResult={onResult} />);
    expect(api.listProjectImports).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Find projects" }).click();
    expect(api.listProjectImports).toHaveBeenCalledWith({ providers: ["codex", "claudeAgent"] });
    await page.getByRole("checkbox", { name: "Select Synara" }).click();
    api.importProject
      .mockResolvedValueOnce(imported)
      .mockRejectedValueOnce(new Error("Temporary provider failure"));
    await page.getByRole("button", { name: "Import selected" }).click();
    await expect.element(page.getByRole("button", { name: "Retry failed (1)" })).toBeVisible();
    expect(api.importProject.mock.calls.map(([input]) => input.threadKey)).toEqual([
      "first",
      "second",
    ]);
    await page.getByRole("button", { name: "Retry failed (1)" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("2 imported or already present");
    expect(api.importProject.mock.calls.map(([input]) => input.threadKey)).toEqual([
      "first",
      "second",
      "second",
    ]);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("finishes the in-flight request before stopping and resumes remaining selections", async () => {
    let finishImport: ((value: typeof imported) => void) | undefined;
    api.importProject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        }),
    );
    const onBusyChange = vi.fn();
    await render(<ProjectImportPanel onBusyChange={onBusyChange} />);
    await page.getByRole("button", { name: "Find projects" }).click();
    await page.getByRole("checkbox", { name: "Select Synara" }).click();
    await page.getByRole("button", { name: "Import selected" }).click();
    await page.getByRole("button", { name: "Stop after current" }).click();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    finishImport?.(imported);
    await expect.element(page.getByRole("status")).toHaveTextContent("Import stopped");
    expect(api.importProject).toHaveBeenCalledTimes(1);
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    await page.getByRole("button", { name: "Import remaining" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("2 imported or already present");
    expect(api.importProject.mock.calls.map(([input]) => input.threadKey)).toEqual([
      "first",
      "second",
    ]);
  });

  it("submits a relink path while preserving the original project identity", async () => {
    api.listProjectImports.mockResolvedValue({
      ...catalog,
      projects: [{ ...catalog.projects[0], directoryExists: false }],
    });
    await render(<ProjectImportPanel onBusyChange={vi.fn()} />);
    await page.getByRole("button", { name: "Find projects" }).click();
    await page.getByRole("checkbox", { name: "Select Synara" }).click();
    await page.getByLabelText("New folder for Synara").fill("/code/moved");
    await page.getByRole("button", { name: "Import selected" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("2 imported or already present");
    expect(api.importProject.mock.calls.map(([input]) => input)).toEqual([
      { projectKey: "project", threadKey: "first", workspaceRoot: "/code/moved", spaceId: null },
      { projectKey: "project", threadKey: "second", workspaceRoot: "/code/moved", spaceId: null },
    ]);
  });
});

describe("project import dialog dismissal", () => {
  it("keeps the dialog open during a durable import and permits closing afterwards", async () => {
    const { ProjectImportDialog } = await import("../projectImport/ProjectImportDialog");
    const { useProjectImportDialogStore } =
      await import("../projectImport/projectImportDialogStore");
    let finishImport: ((value: typeof imported) => void) | undefined;
    api.importProject.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        }),
    );
    useProjectImportDialogStore.getState().openDialog();
    await page.viewport(1100, 850);
    await render(<ProjectImportDialog />);
    await page.getByRole("button", { name: "Find projects" }).click();
    await page.getByRole("checkbox", { name: "Select Synara" }).click();
    await page.getByRole("button", { name: "Conversations in Synara" }).click();
    await page.getByRole("button", { name: "Import selected" }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(useProjectImportDialogStore.getState().isOpen).toBe(true);
    finishImport?.(imported);
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("2 imported or already present");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(useProjectImportDialogStore.getState().isOpen).toBe(false);
  });
});
