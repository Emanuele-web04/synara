import { describe, expect, it, vi } from "vitest";

import { runProjectCommandInTerminal } from "./projectTerminalRunner";

describe("runProjectCommandInTerminal", () => {
  it("opens a terminal with project env and writes the command", async () => {
    const open = vi.fn().mockResolvedValue({
      threadId: "thread-1",
      terminalId: "terminal-1",
      cwd: "/repo/apps/web",
      status: "running",
      pid: 1234,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const write = vi.fn().mockResolvedValue(undefined);

    const result = await runProjectCommandInTerminal({
      api: {
        terminal: {
          open,
          write,
        },
      } as never,
      threadId: "thread-1" as never,
      terminalId: "terminal-1",
      project: { cwd: "/repo" },
      cwd: "/repo/apps/web",
      command: "pnpm run dev",
      worktreePath: "/repo-worktree",
      env: { EXTRA: "1" },
    });

    expect(open).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "terminal-1",
      cwd: "/repo/apps/web",
      env: {
        SYNARA_PROJECT_ROOT: "/repo",
        SYNARA_WORKTREE_PATH: "/repo-worktree",
        EXTRA: "1",
      },
      cols: 120,
      rows: 30,
    });
    expect(write).toHaveBeenCalledWith({
      threadId: "thread-1",
      terminalId: "terminal-1",
      data: "pnpm run dev\r",
    });
    expect(result.snapshot.pid).toBe(1234);
  });
});
