import "../index.css";

import { page } from "vitest/browser";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const nativeApi = vi.hoisted(() => ({
  onProvisionProgress: vi.fn(() => () => undefined),
}));

vi.mock("../nativeApi", () => ({
  readNativeApi: () => ({
    projects: {
      onProvisionProgress: nativeApi.onProvisionProgress,
    },
  }),
}));

import { CreateProjectDialog } from "./CreateProjectDialog";

describe("CreateProjectDialog GitHub source", () => {
  afterEach(() => {
    nativeApi.onProvisionProgress.mockClear();
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
    await addFolder("/repos/api");
    await addFolder("/repos/shared");

    await expect.element(page.getByText("Primary", { exact: true })).toBeInTheDocument();
    expect(document.body.textContent).toContain("run in Local mode with Codex or Claude");

    await page.getByRole("button", { name: "Create project" }).click();
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      source: "local",
      workspaceRoot: "/repos/web",
      additionalFolders: ["/repos/api", "/repos/shared"],
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
