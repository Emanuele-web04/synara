import { describe, expect, it } from "vitest";

import type { TerminalEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import { terminalActivityFromEvent } from "./terminalActivity";

const snapshot: TerminalSessionSnapshot = {
  threadId: "thread-1",
  terminalId: "default",
  cwd: "/tmp",
  status: "running",
  pid: 1234,
  history: "",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function eventBase() {
  return {
    threadId: "thread-1",
    terminalId: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("terminalActivityFromEvent", () => {
  it("returns lifecycle state for terminal activity events", () => {
    const active = terminalActivityFromEvent({
      ...eventBase(),
      type: "activity",
      cliKind: "codex",
      agentState: "running",
      hasRunningSubprocess: true,
    });
    const attention = terminalActivityFromEvent({
      ...eventBase(),
      type: "activity",
      cliKind: "claude",
      agentState: "attention",
      hasRunningSubprocess: true,
    });

    expect(active).toEqual({
      hasRunningSubprocess: true,
      agentState: "running",
    });
    expect(attention).toEqual({
      hasRunningSubprocess: true,
      agentState: "attention",
    });
  });

  it("clears lifecycle state when a terminal session starts/restarts/exits", () => {
    const events: TerminalEvent[] = [
      { ...eventBase(), type: "started", snapshot },
      { ...eventBase(), type: "restarted", snapshot },
      { ...eventBase(), type: "exited", exitCode: 0, exitSignal: null },
    ];

    for (const event of events) {
      expect(terminalActivityFromEvent(event)).toEqual({
        hasRunningSubprocess: false,
        agentState: null,
      });
    }
  });

  it("ignores non-activity terminal events", () => {
    expect(
      terminalActivityFromEvent({
        ...eventBase(),
        type: "output",
        data: "hello",
      }),
    ).toBeNull();
    expect(
      terminalActivityFromEvent({
        ...eventBase(),
        type: "error",
        message: "oops",
      }),
    ).toBeNull();
  });
});
