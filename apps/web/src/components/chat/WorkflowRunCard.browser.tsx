import { flushSync } from "react-dom";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import { ComposerColumnFrame } from "./ComposerColumnFrame";
import { WorkflowRunCard } from "./WorkflowRunCard";
import type { WorkflowRunState } from "./WorkflowRunCard.logic";

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
});

it("updates live elapsed time locally and stops ticking when the workflow settles", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-09-11T10:00:00.000Z"));
  const workflowRun: WorkflowRunState = {
    workflowTaskId: "workflow-clock",
    name: "Review changes",
    description: null,
    startedAt: new Date().toISOString(),
    status: "running",
    settled: false,
    pausedByUser: false,
    runId: null,
    scriptPath: null,
    phases: null,
    runningCount: 0,
    agents: [],
    taskIds: ["workflow-clock"],
  };
  const onParentRender = vi.fn();
  const onAction = vi.fn();
  function Parent({ run }: { run: WorkflowRunState }) {
    onParentRender();
    return (
      <ComposerColumnFrame>
        <WorkflowRunCard
          workflowRun={run}
          compact={false}
          onCompactChange={onAction}
          onOpenThread={onAction}
          onStop={onAction}
          onPause={onAction}
          onResume={onAction}
          onDismiss={onAction}
        />
      </ComposerColumnFrame>
    );
  }
  const screen = await render(<Parent run={workflowRun} />);
  await expect.element(screen.getByText("0s", { exact: true })).toBeVisible();
  const parentRenderCount = onParentRender.mock.calls.length;

  flushSync(() => vi.advanceTimersByTime(2_000));
  await expect.element(screen.getByText("2s", { exact: true })).toBeVisible();
  expect(onParentRender).toHaveBeenCalledTimes(parentRenderCount);

  await screen.rerender(<Parent run={{ ...workflowRun, status: "completed", settled: true }} />);
  await expect.element(screen.getByText("Completed", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("2s", { exact: true })).not.toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0);

  await screen.rerender(<Parent run={workflowRun} />);
  expect(vi.getTimerCount()).toBe(1);
  await screen.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
