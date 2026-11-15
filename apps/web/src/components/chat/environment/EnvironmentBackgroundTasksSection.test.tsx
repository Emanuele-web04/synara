import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkLogBackgroundTask } from "../../../workLog";
import { EnvironmentBackgroundTasksSection } from "./EnvironmentBackgroundTasksSection";

const noop = () => undefined;
const task = (taskId: string, status: WorkLogBackgroundTask["status"]): WorkLogBackgroundTask => ({
  taskId,
  taskType: "local_bash",
  description: null,
  command: `bun run ${taskId}`,
  status,
  startedAt: "2026-10-10T00:00:00.000Z",
  completedAt: status === "running" ? null : "2026-10-10T00:00:01.000Z",
  exitCode: status === "failed" ? 1 : null,
});

describe("EnvironmentBackgroundTasksSection", () => {
  it("keeps every task behind one summary line that opens the list", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentBackgroundTasksSection
        tasks={[
          task("a", "running"),
          task("b", "running"),
          task("c", "failed"),
          task("d", "failed"),
          task("e", "finished"),
        ]}
        onOpenList={noop}
      />,
    );

    expect(markup).toContain("Background tasks");
    expect(markup).toContain("Open background tasks: 2 running, 2 failed");
    expect(markup.match(/<button/g)).toHaveLength(1);
    // The panel lists counts, never the tasks themselves.
    expect(markup).not.toContain("bun run");
  });

  it("counts ended tasks once none is running, and hides with no tasks", () => {
    const settled = renderToStaticMarkup(
      <EnvironmentBackgroundTasksSection
        tasks={[task("a", "finished"), task("b", "stopped")]}
        onOpenList={noop}
      />,
    );
    expect(settled).toContain("Open background tasks: 2 done");
    expect(
      renderToStaticMarkup(<EnvironmentBackgroundTasksSection tasks={[]} onOpenList={noop} />),
    ).toBe("");
  });
});
