import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExecutionEnvironmentDescriptor,
  ProjectReadFileResult,
  ProjectWriteFileResult,
} from "@synara/contracts";

const { api, refreshGit } = vi.hoisted(() => ({
  api: { projects: { writeFile: vi.fn(), readFile: vi.fn() } },
  refreshGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => api }));
vi.mock("./gitReactQuery", () => ({ refreshGitAfterFileWrite: refreshGit }));
import {
  flushWorkspaceEditors,
  getWorkspaceEditorSession,
  hasUnsavedWorkspaceEditors,
  recoverWorkspaceEditors,
} from "./workspaceEditorSession";
import { projectQueryKeys } from "./projectReactQuery";
import { initializeExecutionContext } from "./hosts/executionContext";
import {
  addWorkspaceSession,
  prepareWorkspaceSessionRemoval,
  readWorkspaceSessions,
  updateWorkspaceSession,
} from "./hosts/workspaceSessions";

const source = (contents = "original", version = "sha256:initial"): ProjectReadFileResult => ({
  relativePath: "src/file.ts",
  contents,
  version,
  encoding: "utf8-bom",
  lineEnding: "crlf",
  truncated: false,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(
  cwd = "/repo",
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const session = getWorkspaceEditorSession(client, cwd, "src/file.ts");
  const unsubscribe = session.subscribe(() => undefined);
  session.load(source());
  client.setQueryData(projectQueryKeys.readFile(cwd, "src/file.ts"), source());
  return { client, session, unsubscribe };
}

beforeEach(() => {
  vi.useFakeTimers();
  api.projects.writeFile
    .mockReset()
    .mockResolvedValue({ relativePath: "src/file.ts", version: "sha256:saved" });
  api.projects.readFile.mockReset();
  refreshGit.mockClear();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workspace editor autosave", () => {
  it("preserves the draft and resumes autosave when closing the backend connection fails", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    const descriptor = {
      environmentId: "controller",
      capabilities: { remoteConnections: true },
    } as ExecutionEnvironmentDescriptor;
    initializeExecutionContext({ controller: descriptor, execution: descriptor, remote: null });
    const { client, session } = setup("/remote-repo");
    const workspace = addWorkspaceSession({
      hostId: "remote-host",
      hostName: "Remote",
      wsPath: "/ws/remote/remote-host",
      executionScope: {
        environmentId: "remote",
        accountAuthority: "https://account.example",
        userId: "user",
        organizationId: "org",
        channel: "dev",
      },
    });
    updateWorkspaceSession(workspace.host.executionScope.environmentId, {
      navigation: {
        browseFolders: vi.fn(),
        createProject: vi.fn(),
        newChat: vi.fn(),
        createChat: vi.fn(),
        openTerminal: vi.fn(),
        openProject: vi.fn(),
        navigate: vi.fn(),
        recover: () => recoverWorkspaceEditors(client),
      },
    });
    session.change("draft before closing");
    const removal = prepareWorkspaceSessionRemoval("remote-host");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.projects.writeFile).not.toHaveBeenCalled();
    const recovery = [...values].find(([key]) => key.includes(":editor-recovery:"));
    expect(JSON.parse(recovery![1])[0].snapshot.value).toBe("draft before closing");
    await expect(
      removal.close(() => Promise.reject(new Error("The connection could not be closed."))),
    ).rejects.toThrow("The connection could not be closed.");
    expect(readWorkspaceSessions()).toHaveLength(1);
    session.change("continued after failure");
    await vi.advanceTimersByTimeAsync(400);
    expect(api.projects.writeFile).toHaveBeenCalledExactlyOnceWith({
      cwd: "/remote-repo",
      relativePath: "src/file.ts",
      contents: "continued after failure",
      expectedVersion: "sha256:initial",
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });
    expect(session.dirty).toBe(false);
  });

  it("debounces typing and refreshes Git only after the guarded write succeeds", async () => {
    const { session } = setup();
    session.change("first");
    await vi.advanceTimersByTimeAsync(300);
    session.change("latest");
    await vi.advanceTimersByTimeAsync(399);
    expect(api.projects.writeFile).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.projects.writeFile).toHaveBeenCalledExactlyOnceWith({
      cwd: "/repo",
      relativePath: "src/file.ts",
      contents: "latest",
      expectedVersion: "sha256:initial",
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });
    expect(session.dirty).toBe(false);
    expect(refreshGit).toHaveBeenCalledTimes(1);
  });

  it("shares a single writer across surfaces and drains newer edits before a flush completes", async () => {
    const { client, session } = setup();
    const pending = deferred<ProjectWriteFileResult>();
    api.projects.writeFile.mockReturnValueOnce(pending.promise);
    session.change("first");
    const flushed = flushWorkspaceEditors(client, "/repo");
    await vi.advanceTimersByTimeAsync(0);
    const otherSurface = getWorkspaceEditorSession(client, "/repo", "src/file.ts");
    expect(otherSurface).toBe(session);
    otherSurface.change("newest");
    await vi.advanceTimersByTimeAsync(800);
    expect(api.projects.writeFile).toHaveBeenCalledTimes(1);
    pending.resolve({ relativePath: "src/file.ts", version: "sha256:first" });
    expect(await flushed).toBe(true);
    expect(api.projects.writeFile).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ contents: "newest", expectedVersion: "sha256:first" }),
    );
    expect(session.getSnapshot().value).toBe("newest");
    expect(session.dirty).toBe(false);
  });

  it("blocks navigation on conflicts, retains unmounted drafts, and never automatically overwrites", async () => {
    const { client, session, unsubscribe } = setup();
    api.projects.writeFile.mockRejectedValueOnce(
      Object.assign(new Error("Changed on disk"), { code: "WORKSPACE_FILE_CONFLICT" }),
    );
    session.change("mine");
    expect(await flushWorkspaceEditors(client, "/repo")).toBe(false);
    unsubscribe();
    await vi.advanceTimersByTimeAsync(1000);
    const reopened = getWorkspaceEditorSession(client, "/repo", "src/file.ts");
    reopened.load(source("AI edit", "sha256:agent"));
    expect(reopened.getSnapshot().value).toBe("mine");
    reopened.change("mine updated");
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.projects.writeFile).toHaveBeenCalledTimes(1);
    expect(await flushWorkspaceEditors(client, "/repo")).toBe(false);
    reopened.overwrite();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.projects.writeFile).toHaveBeenLastCalledWith({
      cwd: "/repo",
      relativePath: "src/file.ts",
      contents: "mine updated",
      encoding: "utf8-bom",
      lineEnding: "crlf",
    });
    expect(reopened.dirty).toBe(false);
  });

  it("flushes only the sending workspace and treats undo during a write as pending", async () => {
    const { client, session } = setup();
    const other = setup("/other", client).session;
    const pending = deferred<ProjectWriteFileResult>();
    api.projects.writeFile.mockReturnValueOnce(pending.promise);
    other.change("other draft");
    session.change("first");
    const flushed = flushWorkspaceEditors(client, "/repo");
    await vi.advanceTimersByTimeAsync(0);
    session.change("original");
    expect(hasUnsavedWorkspaceEditors(client, "/repo")).toBe(true);
    pending.resolve({ relativePath: "src/file.ts", version: "sha256:first" });
    expect(await flushed).toBe(true);
    expect(api.projects.writeFile.mock.calls.every(([input]) => input.cwd === "/repo")).toBe(true);
    expect(api.projects.writeFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ contents: "original", expectedVersion: "sha256:first" }),
    );
    expect(other.dirty).toBe(true);
  });

  it("does not overwrite input arriving during an explicit reload", async () => {
    const { session } = setup();
    const pending = deferred<ProjectReadFileResult>();
    api.projects.readFile.mockReturnValueOnce(pending.promise);
    const reload = session.reload();
    await vi.advanceTimersByTimeAsync(0);
    session.change("typed meanwhile");
    pending.resolve(source("disk", "sha256:disk"));
    await reload;
    expect(session.getSnapshot().value).toBe("typed meanwhile");
  });

  it("releases clean sessions but preserves dirty buffers when their panel unmounts", async () => {
    const { client, session, unsubscribe } = setup();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(0);
    expect(getWorkspaceEditorSession(client, "/repo", "src/file.ts")).not.toBe(session);
    const mounted = setup("/repo", client);
    mounted.session.change("draft");
    mounted.unsubscribe();
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.projects.writeFile).not.toHaveBeenCalled();
    expect(getWorkspaceEditorSession(client, "/repo", "src/file.ts").getSnapshot().value).toBe(
      "draft",
    );
  });
});
