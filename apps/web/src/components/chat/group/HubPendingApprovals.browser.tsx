import { ApprovalRequestId, ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useStore } from "../../../store";
import { makeActivity, makeState, makeThread } from "../../../storeTestFixtures";
import { resetRetainedThreadDetailSubscriptionsForTests } from "../../../threadDetailSubscriptionRetention";

const harness = vi.hoisted(() => ({ respond: vi.fn(async () => undefined) }));
vi.mock("../respondToThreadApproval", () => ({ respondToThreadApproval: harness.respond }));
import { HubPendingApprovals } from "./HubPendingApprovals";

const workerId = ThreadId.makeUnsafe("hub-worker");
const requestId = ApprovalRequestId.makeUnsafe("hub-request");
const worker = makeThread({
  id: workerId,
  title: "Test worker",
  runtimeMode: "approval-required",
  hasPendingApprovals: true,
  activities: [
    makeActivity({
      kind: "approval.requested",
      payload: {
        requestId,
        requestKind: "command",
        lifecycleGeneration: "generation-1",
        detail: 'Bash: {"command":"pwd"}',
      },
    }),
  ],
});

describe("HubPendingApprovals", () => {
  beforeEach(() => {
    harness.respond.mockReset();
    harness.respond.mockResolvedValue(undefined);
    resetRetainedThreadDetailSubscriptionsForTests();
    useStore.setState(makeState(worker));
  });

  it.each([
    ["Approve once", "accept"],
    ["Always allow this session", "acceptForSession"],
    ["Decline", "decline"],
    ["Cancel turn", "cancel"],
  ])("sends %s to the worker, only after a user action", async (label, decision) => {
    const open = vi.fn();
    const screen = await render(<HubPendingApprovals threadIds={[workerId]} onOpenThread={open} />);
    try {
      await expect.element(page.getByText("pwd", { exact: true })).toBeInTheDocument();
      expect(harness.respond).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Test worker", exact: true }).click();
      expect(open).toHaveBeenCalledWith(workerId);
      await page.getByRole("button", { name: new RegExp(label) }).click();
      expect(harness.respond).toHaveBeenCalledWith({
        threadId: workerId,
        requestId,
        decision,
        lifecycleGeneration: "generation-1",
        requestKind: "command",
        runtimeMode: "approval-required",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("keeps separate workers actionable and removes a request resolved in its thread", async () => {
    const secondId = ThreadId.makeUnsafe("second-worker");
    const other = makeThread({ ...worker, id: secondId, title: "Second worker" });
    const state = makeState(worker);
    const secondState = makeState(other);
    useStore.setState({
      ...state,
      threadIds: [workerId, secondId],
      threadShellById: { ...state.threadShellById, ...secondState.threadShellById },
      activityIdsByThreadId: {
        ...state.activityIdsByThreadId,
        ...secondState.activityIdsByThreadId,
      },
      activityByThreadId: { ...state.activityByThreadId, ...secondState.activityByThreadId },
    });
    const screen = await render(
      <HubPendingApprovals threadIds={[workerId, secondId, workerId]} onOpenThread={vi.fn()} />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: /Approve once/ }).nth(1))
        .toBeInTheDocument();
      useStore.setState((current) => ({
        threadShellById: {
          ...current.threadShellById,
          [workerId]: { ...current.threadShellById![workerId]!, hasPendingApprovals: false },
        },
      }));
      await expect
        .element(page.getByRole("button", { name: "Test worker", exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("button", { name: /Approve once/ }).click();
      expect(harness.respond).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: secondId, requestId }),
      );
    } finally {
      await screen.unmount();
    }
  });

  it("includes a new thread in the hub before the member index refreshes", async () => {
    const screen = await render(
      <HubPendingApprovals
        threadIds={[]}
        hubProjectId={worker.projectId}
        coordinatorThreadId={ThreadId.makeUnsafe("coordinator")}
        onOpenThread={vi.fn()}
      />,
    );
    try {
      await expect.element(page.getByText("pwd", { exact: true })).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
