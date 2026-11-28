import "../index.css";

import { page, userEvent } from "vitest/browser";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProjectId,
  type FilesystemBrowseInput,
  type FilesystemBrowseResult,
} from "@synara/contracts";
import { render } from "vitest-browser-react";

const nativeApi = vi.hoisted(() => ({
  onProvisionProgress: vi.fn(() => () => undefined),
  browse: vi.fn<(input: FilesystemBrowseInput) => Promise<FilesystemBrowseResult>>(async () => ({
    parentPath: "/workspace",
    entries: [],
  })),
}));

vi.mock("../nativeApi", () => {
  const api = {
    filesystem: { browse: nativeApi.browse },
    projects: { onProvisionProgress: nativeApi.onProvisionProgress },
  };
  return {
    readNativeApi: () => api,
    ensureNativeApi: () => api,
    readNativeApiServerCapability: () => false,
  };
});

vi.mock("../appNavigation", async (importOriginal) => {
  const original = await importOriginal<typeof import("../appNavigation")>();
  const { createMemoryHistory } = await import("@tanstack/react-router");
  return { ...original, appHistory: createMemoryHistory({ initialEntries: ["/"] }) };
});

import { appHistory } from "../appNavigation";
import { CreateProjectDialog } from "./CreateProjectDialog";
import type { WorkspaceNavigation } from "../lib/hosts/workspaceFrame";
import {
  addWorkspaceSession,
  removeWorkspaceSession,
  updateWorkspaceSession,
} from "../lib/hosts/workspaceSessions";

vi.mock("../lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hosts/executionContext")>()),
  readExecutionContext: () => ({
    controller: { environmentId: "local", capabilities: { remoteConnections: true } },
    execution: { environmentId: "local", capabilities: { remoteConnections: true } },
    remote: null,
  }),
}));

beforeEach(() => {
  nativeApi.onProvisionProgress.mockClear();
  nativeApi.browse.mockReset().mockResolvedValue({ parentPath: "/workspace", entries: [] });
});
afterEach(() => {
  removeWorkspaceSession("clone-host");
  sessionStorage.clear();
  appHistory.replace("/");
  vi.restoreAllMocks();
});

describe("CreateProjectDialog GitHub source", () => {
  it("browses local folders after leaving a remote chat and preserves an explicit name", async () => {
    appHistory.replace("/local-thread?environment=remote-computer&path=%2Fremote-thread");
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await render(
      <CreateProjectDialog
        open
        githubProvisioningAvailable
        spaces={[]}
        activeSpaceId={null}
        defaultCloneParent="/workspace"
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    expect(
      (
        page
          .getByRole("button", { name: "Source folder", exact: true })
          .element() as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    await page.getByLabelText("Project name", { exact: true }).fill("My workspace");
    await page.getByRole("button", { name: "Source folder", exact: true }).click();
    await expect
      .element(page.getByRole("heading", { name: "Choose a folder on This computer" }))
      .toBeVisible();
    await page.getByRole("button", { name: "Use folder" }).click();
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      source: "local",
      name: "My workspace",
      workspaceRoot: "/workspace",
      additionalFolders: [],
      createIfMissing: false,
      spaceId: null,
    });
  });

  it("does not create a trimmed sibling of an existing folder selected in Browse", async () => {
    nativeApi.browse.mockImplementation(async ({ partialPath }) =>
      partialPath === "~/"
        ? {
            parentPath: "/workspace",
            entries: [{ name: "Photos ", fullPath: "/workspace/Photos " }],
          }
        : { parentPath: "/workspace/Photos ", entries: [] },
    );
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await render(
      <CreateProjectDialog
        open
        githubProvisioningAvailable={false}
        spaces={[]}
        activeSpaceId={null}
        defaultCloneParent="/workspace"
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    await page.getByRole("button", { name: "Source folder", exact: true }).click();
    await page.getByRole("button", { name: "Photos", exact: true }).click();
    await page.getByRole("button", { name: "Use folder" }).click();
    await expect
      .element(page.getByLabelText("Project folder path"))
      .toHaveValue("/workspace/Photos ");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    expect(onSubmit).not.toHaveBeenCalled();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("starts or ends with whitespace");
  });

  it("suggests matching folders and completes a common prefix without trapping backward focus", async () => {
    nativeApi.browse.mockResolvedValueOnce({
      parentPath: "/workspace",
      entries: [
        { name: "project-one", fullPath: "/workspace/project-one" },
        { name: "project-two", fullPath: "/workspace/project-two" },
      ],
    });
    await render(
      <CreateProjectDialog
        open
        githubProvisioningAvailable={false}
        spaces={[]}
        activeSpaceId={null}
        defaultCloneParent="/workspace"
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const path = page.getByLabelText("Project folder path");
    await path.fill("~/pro");
    await expect
      .element(page.getByRole("option", { name: "/workspace/project-two/" }))
      .toBeVisible();
    await userEvent.keyboard("{Tab}");
    await expect.element(path).toHaveValue("/workspace/project-");
    await expect.element(page.getByLabelText("Project name")).toHaveValue("project-");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(path).not.toHaveFocus();
  });

  it("disables GitHub when the server does not advertise provisioning", async () => {
    await render(
      <CreateProjectDialog
        open
        githubProvisioningAvailable={false}
        spaces={[]}
        activeSpaceId={null}
        defaultCloneParent="/Users/test/Developer"
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(
      (page.getByRole("radio", { name: "GitHub" }).element() as HTMLButtonElement).disabled,
    ).toBe(true);
    await expect.element(page.getByRole("status")).toHaveTextContent("Update the Synara server");
  });

  it("derives the clone folder from owner/repository and submits a parent directory", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    await render(
      <CreateProjectDialog
        open
        githubProvisioningAvailable
        spaces={[]}
        activeSpaceId={null}
        defaultCloneParent="/Users/test/Developer"
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
      />,
    );

    await page.getByRole("radio", { name: "GitHub" }).click();
    expect(document.body.textContent).toContain("What you need");
    expect(document.body.textContent).toContain("Private access");
    await page.getByLabelText("Repository").fill("openai/codex");

    expect((page.getByLabelText("Folder name").element() as HTMLInputElement).value).toBe("codex");
    expect(document.body.textContent).toContain("Final location: /Users/test/Developer/codex");

    await page.getByRole("button", { name: "Clone and add" }).click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const [value, options] = onSubmit.mock.calls[0] ?? [];
    expect(value).toMatchObject({
      source: "github",
      repository: "openai/codex",
      destinationParent: "/Users/test/Developer",
      directoryName: "codex",
      spaceId: null,
    });
    expect(value.operationId).toEqual(expect.any(String));
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects invalid clone folder names before provisioning", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    await render(
      <CreateProjectDialog
        open
        githubProvisioningAvailable
        spaces={[]}
        activeSpaceId={null}
        defaultCloneParent="/Users/test/Developer"
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );

    await page.getByRole("radio", { name: "GitHub" }).click();
    await page.getByLabelText("Repository").fill("openai/codex");
    await page.getByLabelText("Folder name").fill("CON");
    await page.getByRole("button", { name: "Clone and add" }).click();

    await expect.element(page.getByRole("alert")).toHaveTextContent("Choose a valid folder name");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("aborts the active clone when the dialog is closed", async () => {
    const submittedSignals: AbortSignal[] = [];
    const onSubmit = vi.fn(
      (_value: unknown, options: { signal: AbortSignal }) =>
        new Promise<void>((_resolve, reject) => {
          submittedSignals.push(options.signal);
          options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    const onOpenChange = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <CreateProjectDialog
          open={open}
          githubProvisioningAvailable
          spaces={[]}
          activeSpaceId={null}
          defaultCloneParent="/Users/test"
          onOpenChange={(nextOpen) => {
            onOpenChange(nextOpen);
            setOpen(nextOpen);
          }}
          onSubmit={onSubmit}
        />
      );
    }
    await render(<Harness />);

    await page.getByRole("radio", { name: "GitHub" }).click();
    await page.getByLabelText("Repository").fill("openai/codex");
    await page.getByRole("button", { name: "Clone and add" }).click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await page.getByRole("button", { name: "Cancel clone" }).click();

    expect(submittedSignals[0]?.aborted).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

describe("CreateProjectDialog connected-computer cloning", () => {
  const projectId = ProjectId.makeUnsafe("remote-clone-project");
  async function renderRemote(
    cloneGitHubProject?: WorkspaceNavigation["cloneGitHubProject"],
    browseFolders: WorkspaceNavigation["browseFolders"] = async () => ({
      parentPath: "/remote",
      entries: [],
    }),
  ) {
    addWorkspaceSession({
      hostId: "clone-host",
      hostName: "Build computer",
      wsPath: "/ws/remote/clone-host",
      executionScope: {
        environmentId: "clone-computer",
        accountAuthority: "https://account.example",
        userId: "alice",
        organizationId: "org",
        channel: "dev",
      },
    });
    updateWorkspaceSession("clone-computer", {
      navigation: {
        browseFolders,
        createProject: vi.fn(),
        navigate: vi.fn(),
        newChat: vi.fn(),
        createChat: vi.fn(),
        openTerminal: vi.fn(),
        openProject: vi.fn(),
        recover: vi.fn(),
        ...(cloneGitHubProject ? { cloneGitHubProject } : {}),
      },
      summary: { state: "open", path: "/", projects: [], threads: [] },
    });
    appHistory.replace("/remote?environment=clone-computer&path=%2F");
    const onSubmit = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(true)}>Reopen project dialog</button>
          <CreateProjectDialog
            open={open}
            githubProvisioningAvailable={false}
            spaces={[]}
            activeSpaceId={null}
            defaultCloneParent="/local-only/path"
            onOpenChange={setOpen}
            onSubmit={onSubmit}
          />
        </>
      );
    }
    await render(<Harness />);
    return onSubmit;
  }

  it("clones on the selected computer, streams its progress and opens its project", async () => {
    let complete!: (value: { projectId: ProjectId; path: string; created: boolean }) => void;
    const clone = vi.fn<NonNullable<WorkspaceNavigation["cloneGitHubProject"]>>(
      (input, options) => {
        options.onProgress({
          operationId: input.operationId,
          kind: "phase",
          phase: "cloning",
          message: "Cloning on Build computer",
        });
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    );
    const onSubmit = await renderRemote(clone, async () => ({
      parentPath: "/remote",
      entries: [{ name: "projects", fullPath: "/remote/projects" }],
    }));
    await page.getByRole("radio", { name: "GitHub" }).click();
    const destination = page.getByLabelText("Clone into");
    await expect.element(destination).toHaveValue("~/");
    await expect
      .element(page.getByText(/Private repositories use GitHub access configured on that computer/))
      .toBeVisible();
    const repository = page.getByLabelText("Repository");
    await repository.fill("openai/codex");
    await destination.fill("/remote/proj");
    await userEvent.keyboard("{Tab}");
    await expect.element(destination).toHaveValue("/remote/projects/");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(repository).toHaveFocus();
    await page.getByRole("button", { name: "Clone and add" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("Cloning on Build computer");
    expect(clone.mock.calls[0]?.[0]).toMatchObject({
      repository: "openai/codex",
      destinationParent: "/remote/projects/",
      directoryName: "codex",
    });
    complete({ projectId, path: "/remote-chat", created: true });
    await expect
      .poll(() => appHistory.location.href)
      .toBe("/remote?environment=clone-computer&path=%2Fremote-chat");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])(
    "keeps a reopened dialog intact after an older clone's %s",
    async (outcome) => {
      let settle!: () => void;
      const clone = vi.fn<NonNullable<WorkspaceNavigation["cloneGitHubProject"]>>(
        () =>
          new Promise((resolve, reject) => {
            settle = () =>
              outcome === "success"
                ? resolve({ projectId, path: "/old-clone", created: true })
                : reject(new Error("Old clone failed"));
          }),
      );
      await renderRemote(clone);
      await page.getByRole("radio", { name: "GitHub" }).click();
      await page.getByLabelText("Repository").fill("owner/first");
      await page.getByRole("button", { name: "Clone and add" }).click();
      await expect.poll(() => clone.mock.calls.length).toBe(1);
      await page.getByRole("button", { name: "Cancel clone" }).click();
      await page.getByRole("button", { name: "Reopen project dialog" }).click();
      await page.getByRole("radio", { name: "GitHub" }).click();
      await page.getByLabelText("Repository").fill("owner/second");
      settle();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await expect.element(page.getByLabelText("Repository")).toHaveValue("owner/second");
      expect(page.getByRole("alert").query()).toBeNull();
      expect(appHistory.location.href).not.toContain("old-clone");
    },
  );

  it("keeps Cancel clone available when the selected computer disconnects", async () => {
    const clone = vi.fn<NonNullable<WorkspaceNavigation["cloneGitHubProject"]>>(
      (_input, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
            once: true,
          });
        }),
    );
    await renderRemote(clone);
    await page.getByRole("radio", { name: "GitHub" }).click();
    await page.getByLabelText("Repository").fill("owner/repo");
    await page.getByRole("button", { name: "Clone and add" }).click();
    await expect.poll(() => clone.mock.calls.length).toBe(1);
    updateWorkspaceSession("clone-computer", {
      navigation: undefined,
      summary: { state: "connecting", path: "/", projects: [], threads: [] },
    });
    await expect.element(page.getByRole("button", { name: "Cancel clone" })).toBeEnabled();
    await page.getByRole("button", { name: "Cancel clone" }).click();
    expect(clone.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it("explains an older connected computer's missing clone support", async () => {
    await renderRemote();
    await expect.element(page.getByRole("radio", { name: "GitHub" })).toBeDisabled();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Update Synara on the selected computer");
  });

  it("reports remote clone errors and lets the user retry", async () => {
    const clone = vi.fn<NonNullable<WorkspaceNavigation["cloneGitHubProject"]>>(async () => {
      throw "GitHub access is not configured on Build computer";
    });
    await renderRemote(clone);
    await page.getByRole("radio", { name: "GitHub" }).click();
    await page.getByLabelText("Repository").fill("owner/private-repo");
    await page.getByRole("button", { name: "Clone and add" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("GitHub access is not configured on Build computer");
    clone.mockResolvedValue({ projectId, path: "/retried-clone", created: true });
    await page.getByRole("button", { name: "Clone and add" }).click();
    await expect
      .poll(() => appHistory.location.href)
      .toBe("/remote?environment=clone-computer&path=%2Fretried-clone");
  });
});

describe("CreateProjectDialog multi-folder projects", () => {
  async function renderLocalDialog(onSubmit = vi.fn().mockResolvedValue(undefined)) {
    await render(
      <CreateProjectDialog
        open
        githubProvisioningAvailable={false}
        spaces={[]}
        activeSpaceId={null}
        defaultCloneParent="/Users/test/Developer"
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    return onSubmit;
  }

  async function addFolder(path: string) {
    await page.getByLabelText("Additional folder path").fill(path);
    await page.getByRole("button", { name: "Add folder" }).click();
  }

  it("submits the extra folders after the primary one", async () => {
    const onSubmit = await renderLocalDialog();
    await page.getByLabelText("Project folder path").fill("/repos/web");
    nativeApi.browse.mockResolvedValue({
      parentPath: "/repos",
      entries: [{ name: "api", fullPath: "/repos/api" }],
    });
    const additional = page.getByLabelText("Additional folder path");
    await additional.fill("/repos/ap");
    await userEvent.keyboard("{Tab}");
    await expect.element(additional).toHaveValue("/repos/api/");
    await userEvent.keyboard("{Enter}");
    await addFolder("/repos/shared");

    await expect.element(page.getByText("Primary", { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).toContain("A worktree isolates only the primary folder");

    await page.getByRole("button", { name: "Create project" }).click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      source: "local",
      workspaceRoot: "/repos/web",
      additionalFolders: ["/repos/api/", "/repos/shared"],
      createIfMissing: true,
    });
  });

  it("moves a folder to primary and removes folders", async () => {
    const onSubmit = await renderLocalDialog();
    await page.getByLabelText("Project folder path").fill("/repos/web");
    await addFolder("/repos/api");
    await addFolder("/repos/shared");

    await page.getByRole("button", { name: "Make api primary" }).click();
    expect((page.getByLabelText("Project folder path").element() as HTMLInputElement).value).toBe(
      "/repos/api",
    );
    await page.getByRole("button", { name: "Remove shared" }).click();

    await page.getByRole("button", { name: "Create project" }).click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      workspaceRoot: "/repos/api",
      additionalFolders: ["/repos/web"],
      // The new primary was already checked when it was added, so it is never created.
      createIfMissing: false,
    });
  });

  it("keeps creating a typed primary folder after an extra folder is removed", async () => {
    const onSubmit = await renderLocalDialog();
    await page.getByLabelText("Project folder path").fill("/repos/new-app");
    await addFolder("/repos/api");
    await page.getByRole("button", { name: "Remove api" }).click();

    await page.getByRole("button", { name: "Create project" }).click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      workspaceRoot: "/repos/new-app",
      additionalFolders: [],
      createIfMissing: true,
    });
  });

  it("refuses a folder nested inside another one", async () => {
    const onSubmit = await renderLocalDialog();
    await page.getByLabelText("Project folder path").fill("/repos/web");
    await addFolder("/repos/web/packages");

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("packages is inside web. Add only one of them.");
    expect(page.getByRole("button", { name: "Remove packages" }).query()).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
