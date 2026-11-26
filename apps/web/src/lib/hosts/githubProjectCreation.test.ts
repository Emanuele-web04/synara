import {
  ProjectId,
  type GitHubProjectProvisionInput,
  type GitHubProjectProvisionProgressEvent,
  type NativeApi,
  type OrchestrationShellSnapshot,
} from "@synara/contracts";
import { afterEach, expect, it, vi } from "vitest";
import { provisionGitHubProjectOnHost } from "./githubProjectCreation";

const now = "2026-11-26T17:00:00.000Z";
const input = {
  operationId: "clone-operation",
  repository: "owner/repo",
  destinationParent: "~/Projects",
  directoryName: "repo",
};
function snapshot(projectId?: ProjectId): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    updatedAt: now,
    spaces: [],
    threads: [],
    projects: projectId
      ? [
          {
            id: projectId,
            kind: "project",
            title: "repo",
            workspaceRoot: "/host/home/Projects/repo",
            defaultModelSelection: { provider: "codex", model: "gpt-5" },
            scripts: [],
            createdAt: now,
            updatedAt: now,
          },
        ]
      : [],
  };
}
function harness() {
  const abort = new AbortController();
  let requested: GitHubProjectProvisionInput | undefined;
  let emit = (_event: GitHubProjectProvisionProgressEvent) => {};
  const unsubscribe = vi.fn();
  const provision = vi.fn<NativeApi["projects"]["provisionFromGitHub"]>(async (value) => {
    requested = value;
    return {
      operationId: value.operationId,
      repository: value.repository,
      projectId: value.projectId,
      workspaceRoot: "/host/home/Projects/repo",
      checkout: "created",
    };
  });
  const load = vi.fn(async () => snapshot(requested?.projectId));
  const available = vi.fn(() => true);
  const progress = vi.fn();
  const syncSnapshot = vi.fn();
  const openProject = vi.fn(async (_projectId: ProjectId, _signal: AbortSignal) => "/host-chat");
  const run = () =>
    provisionGitHubProjectOnHost({
      api: {
        projects: {
          provisionFromGitHub: provision,
          onProvisionProgress: (callback) => {
            emit = callback;
            return unsubscribe;
          },
        },
        orchestration: { getShellSnapshot: load },
      },
      input,
      signal: abort.signal,
      onProgress: progress,
      available,
      syncSnapshot,
      openProject,
    });
  return {
    abort,
    provision,
    load,
    available,
    progress,
    syncSnapshot,
    openProject,
    unsubscribe,
    run,
    emit: (event: GitHubProjectProvisionProgressEvent) => emit(event),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("uses the host API and signal, filters progress, and recognizes a new registration", async () => {
  const h = harness();
  h.provision.mockImplementationOnce(async (value, options) => {
    expect(options?.signal).toBe(h.abort.signal);
    h.emit({ operationId: "other", kind: "phase", phase: "cloning", message: "Other clone" });
    h.emit({
      operationId: value.operationId,
      kind: "phase",
      phase: "cloning",
      message: "Host clone",
    });
    h.load.mockResolvedValue(snapshot(value.projectId));
    return {
      operationId: value.operationId,
      repository: value.repository,
      projectId: value.projectId,
      workspaceRoot: "/host/home/Projects/repo",
      checkout: "created",
    };
  });
  const result = await h.run();
  expect(result.created).toBe(true);
  expect(h.provision.mock.calls[0]?.[0]).toMatchObject({ ...input, newProjectSpaceId: null });
  expect(h.progress.mock.calls.map(([event]) => event.message)).toEqual(["Host clone"]);
  expect(h.unsubscribe).toHaveBeenCalledOnce();
});

it("does not recover an unrelated existing project by destination path after cancellation", async () => {
  vi.useFakeTimers();
  const h = harness();
  const existing = ProjectId.makeUnsafe("existing-project");
  h.provision.mockImplementationOnce(async () => {
    h.abort.abort();
    throw new Error("cancelled");
  });
  h.load.mockResolvedValue(snapshot(existing));
  const outcome = h.run().then(
    () => null,
    (error: unknown) => error,
  );
  await vi.runAllTimersAsync();
  expect(await outcome).toMatchObject({ message: "cancelled" });
  expect(h.openProject).not.toHaveBeenCalled();
  expect(h.unsubscribe).toHaveBeenCalledOnce();
});

it("syncs a recovered registration but never opens or navigates it after cancellation", async () => {
  const h = harness();
  h.provision.mockImplementationOnce(async (value) => {
    h.load.mockResolvedValue(snapshot(value.projectId));
    h.abort.abort(new Error("user cancelled"));
    throw new Error("cancelled");
  });
  await expect(h.run()).rejects.toThrow("user cancelled");
  expect(h.syncSnapshot).toHaveBeenCalledOnce();
  expect(h.openProject).not.toHaveBeenCalled();
  expect(h.unsubscribe).toHaveBeenCalledOnce();
});

it("passes cancellation through project opening and rejects a late completed navigation", async () => {
  const h = harness();
  let complete!: (path: string) => void;
  h.openProject.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        complete = resolve;
      }),
  );
  const outcome = h.run().then(
    () => null,
    (error: unknown) => error,
  );
  await vi.waitFor(() => expect(h.openProject).toHaveBeenCalledOnce());
  expect(h.openProject.mock.calls[0]?.[1]).toBe(h.abort.signal);
  h.abort.abort(new Error("cancelled while opening"));
  complete("/late-chat");
  expect(await outcome).toMatchObject({ message: "cancelled while opening" });
  expect(h.syncSnapshot).toHaveBeenCalledOnce();
  expect(h.unsubscribe).toHaveBeenCalledOnce();
});

it("bounds cancellation recovery even when the snapshot request never settles", async () => {
  vi.useFakeTimers();
  const h = harness();
  h.provision.mockImplementationOnce(async () => {
    h.abort.abort();
    throw new Error("cancelled");
  });
  h.load.mockImplementationOnce(() => new Promise(() => {}));
  const outcome = expect(h.run()).rejects.toThrow("cancelled");
  await vi.advanceTimersByTimeAsync(5_000);
  await outcome;
  expect(h.unsubscribe).toHaveBeenCalledOnce();
  expect(h.load).toHaveBeenCalledOnce();
});

it("refuses a replaced host before cloning or consuming its result", async () => {
  const h = harness();
  h.available.mockReturnValue(false);
  await expect(h.run()).rejects.toThrow("no longer available");
  expect(h.provision).not.toHaveBeenCalled();
  h.available.mockReturnValue(true);
  h.provision.mockImplementationOnce(async (value) => {
    h.available.mockReturnValue(false);
    return {
      operationId: value.operationId,
      repository: value.repository,
      projectId: value.projectId,
      workspaceRoot: "/host/home/Projects/repo",
      checkout: "created",
    };
  });
  vi.useFakeTimers();
  const outcome = expect(h.run()).rejects.toThrow("connection changed");
  await vi.runAllTimersAsync();
  await outcome;
  expect(h.load).not.toHaveBeenCalled();
  expect(h.unsubscribe).toHaveBeenCalledOnce();
});
