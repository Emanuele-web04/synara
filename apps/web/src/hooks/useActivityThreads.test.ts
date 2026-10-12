import { ProjectId, ThreadId, type ProjectAgentSummary } from "@synara/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "../store";
import type { SidebarThreadSummary } from "../types";

const harness = vi.hoisted(() => ({
  state: {} as AppState,
  coordinatorIds: new Set<string>(),
  summaries: new Map<ProjectId, Pick<ProjectAgentSummary, "memberThreadIds">>(),
}));

// Exercise the hook's real selectors and derivation without mounting unrelated UI.
vi.mock("react", async () => ({
  ...(await vi.importActual<typeof import("react")>("react")),
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../store", () => ({
  useStore: (selector: (state: AppState) => unknown) => selector(harness.state),
}));
vi.mock("../workspacePathsStore", () => ({
  useWorkspacePathsStore: (selector: (state: Record<string, string | null>) => unknown) =>
    selector({
      homeDir: "/tmp/snooze-test",
      chatWorkspaceRoot: null,
      studioWorkspaceRoot: null,
      groupsWorkspaceRoot: null,
    }),
}));
vi.mock("../components/chat/project/useProjectAgentSummaries", () => ({
  useCoordinatorThreadIds: () => harness.coordinatorIds,
  useProjectAgentSummariesStore: (selector: (state: unknown) => unknown) =>
    selector({ summariesByProjectId: harness.summaries }),
}));

vi.mock("../betaFeatures", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../betaFeatures")>()),
  GROUPS_ON: true,
}));

import { useActivityThreads } from "./useActivityThreads";

function makeThread(
  id: string,
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(id),
    projectId: ProjectId.makeUnsafe("project"),
    title: id,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-10-02T10:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  };
}

function setThreads(threads: SidebarThreadSummary[]) {
  harness.state = {
    threadIds: threads.map((thread) => thread.id),
    sidebarThreadSummaryById: Object.fromEntries(threads.map((thread) => [thread.id, thread])),
    projects: [],
  } as unknown as AppState;
}

beforeEach(() => {
  harness.coordinatorIds = new Set();
  harness.summaries = new Map();
});

describe("useActivityThreads snooze visibility", () => {
  it("retains an overdue snoozed pin for its section while excluding it from ordinary lists", () => {
    setThreads([
      makeThread("normal"),
      makeThread("snoozed", { snoozedUntil: "2026-10-01T08:00:00.000Z", isPinned: true }),
    ]);
    const result = useActivityThreads({ hideAutomationRunThreads: true });
    expect(result.activityNonGroupThreads.map((thread) => thread.id)).toEqual([
      "normal",
      "snoozed",
    ]);
    expect(result.visibleNonGroupThreads.map((thread) => thread.id)).toEqual(["normal"]);
    expect(useActivityThreads({ hideAutomationRunThreads: true })).toBe(result);
  });

  it("keeps hidden coordinators and sidechats hidden and restores a server-cleared snooze", () => {
    harness.coordinatorIds = new Set(["coordinator"]);
    const snoozedUntil = "2026-10-02T12:00:00.000Z";
    setThreads([
      makeThread("coordinator", { snoozedUntil }),
      makeThread("sidechat", {
        snoozedUntil,
        sidechatSourceThreadId: ThreadId.makeUnsafe("normal"),
      }),
      makeThread("returned", { snoozedUntil: null, snoozeReminderAt: "2026-10-02T11:00:00.000Z" }),
    ]);
    const result = useActivityThreads({ hideAutomationRunThreads: true });
    expect(result.activityNonGroupThreads.map((thread) => thread.id)).toEqual(["returned"]);
    expect(result.visibleNonGroupThreads.map((thread) => thread.id)).toEqual(["returned"]);
  });
});

it("updates Home candidates when a repository thread becomes a hub member", () => {
  const hubId = ProjectId.makeUnsafe("hub");
  const worker = makeThread("worker");
  const ordinary = makeThread("ordinary");
  setThreads([worker, ordinary]);
  harness.state.projects = [{ id: hubId, kind: "group", cwd: "/tmp/hub" }] as AppState["projects"];
  const before = useActivityThreads({ hideAutomationRunThreads: true });
  expect(before.visibleNonGroupThreads).toEqual([worker, ordinary]);
  harness.summaries = new Map([[hubId, { memberThreadIds: [worker.id] }]]);
  const after = useActivityThreads({ hideAutomationRunThreads: true });
  expect(after.visibleNonGroupThreads).toEqual([ordinary]);
  expect(after.activityNonGroupThreads).toEqual([ordinary]);
  expect(after.groupThreads).toEqual([worker]);
});
