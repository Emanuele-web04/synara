// FILE: processTreeKiller.test.ts
// Purpose: Verifies PTY process-tree capture and safe descendant signaling.
// Layer: Terminal infrastructure tests
// Depends on: Vitest and injectable processTreeKiller dependencies.
import { describe, expect, it } from "vitest";

import {
  collectDescendantProcesses,
  createProcessTreeKiller,
  parseProcessCommandMap,
  type CapturedProcessTree,
  type ProcessChildrenMap,
  type TerminalKillSignal,
} from "./processTreeKiller";

describe("processTreeKiller", () => {
  it("collects nested process-tree descendants in parent-first order", () => {
    const childrenByParentPid: ProcessChildrenMap = new Map([
      [
        100,
        [
          { pid: 101, command: "zsh" },
          { pid: 102, command: "bun run dev" },
        ],
      ],
      [102, [{ pid: 103, command: "tsdown --watch" }]],
    ]);

    expect(collectDescendantProcesses(100, childrenByParentPid)).toEqual([
      { pid: 101, command: "zsh" },
      { pid: 102, command: "bun run dev" },
      { pid: 103, command: "tsdown --watch" },
    ]);
  });

  it("parses current command snapshots with command arguments intact", () => {
    expect(
      parseProcessCommandMap(`
        102 bun run dev -- --watch
        103 /bin/zsh -l
      `),
    ).toEqual(
      new Map([
        [102, "bun run dev -- --watch"],
        [103, "/bin/zsh -l"],
      ]),
    );
  });

  it("retries a transient capture failure and tracks descendants", () => {
    let captureAttempts = 0;
    const killer = createProcessTreeKiller({
      captureChildrenMap: () => {
        captureAttempts += 1;
        return captureAttempts === 1
          ? null
          : new Map([[100, [{ pid: 101, command: "provider-child" }]]]);
      },
    });

    expect(killer.capture(100)).toEqual({
      descendants: [{ pid: 101, command: "provider-child" }],
      captureComplete: true,
    });
    expect(captureAttempts).toBe(2);
  });

  it("fails closed when every capture attempt fails", () => {
    let captureAttempts = 0;
    const killer = createProcessTreeKiller({
      captureChildrenMap: () => {
        captureAttempts += 1;
        return null;
      },
    });

    expect(killer.capture(100)).toEqual({ descendants: [], captureComplete: false });
    expect(captureAttempts).toBe(2);
  });

  it("validates captured child identities before delayed SIGKILL", () => {
    const signaledPids: Array<{ pid: number; signal: TerminalKillSignal }> = [];
    const treeSignals: Array<{ rootPid: number; signal: TerminalKillSignal }> = [];
    const rowReadCalls: number[] = [];
    const tree: CapturedProcessTree = {
      descendants: [
        { pid: 102, ppid: 100, command: "bun run dev" },
        { pid: 103, ppid: 100, command: "tsdown --watch" },
      ],
    };
    const killer = createProcessTreeKiller({
      readLiveProcessRow: (pid) => {
        rowReadCalls.push(pid);
        return new Map([
          [102, { ppid: 100, command: "bun run dev" }],
          [103, { ppid: 100, command: "node unrelated-process.js" }],
        ]).get(pid);
      },
      signalPid: (pid, signal) => {
        signaledPids.push({ pid, signal });
        return null;
      },
      signalTree: (rootPid, signal, callback) => {
        treeSignals.push({ rootPid, signal });
        callback(null);
      },
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      tree,
      includeRootTree: false,
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([{ pid: 102, signal: "SIGKILL" }]);
    expect(rowReadCalls).toEqual([102, 103]);
    expect(treeSignals).toEqual([]);
  });

  it("still verifies captured child identities before initial SIGTERM", () => {
    const signaledPids: number[] = [];
    const killer = createProcessTreeKiller({
      readLiveProcessRow: (pid) =>
        pid === 103 ? { ppid: 100, command: "tsdown --watch" } : undefined,
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (_rootPid, _signal, callback) => callback(null),
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGTERM",
      includeRootTree: false,
      tree: {
        descendants: [
          { pid: 102, ppid: 100, command: "bun run dev" },
          { pid: 103, ppid: 100, command: "tsdown --watch" },
        ],
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([103]);
  });

  it("can skip root tree signaling while still signaling captured children", () => {
    const signaledPids: number[] = [];
    const treeSignals: number[] = [];
    const killer = createProcessTreeKiller({
      readLiveProcessRow: (pid) =>
        pid === 103 ? { ppid: 100, command: "tsdown --watch" } : undefined,
      signalPid: (pid) => {
        signaledPids.push(pid);
        return null;
      },
      signalTree: (rootPid, _signal, callback) => {
        treeSignals.push(rootPid);
        callback(null);
      },
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      includeRootTree: false,
      tree: {
        descendants: [{ pid: 103, ppid: 100, command: "tsdown --watch" }],
      },
      onError: () => undefined,
    });

    expect(signaledPids).toEqual([103]);
    expect(treeSignals).toEqual([]);
  });
});
