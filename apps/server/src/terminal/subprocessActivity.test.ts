import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as processRunner from "../processRunner";

import {
  captureLinuxProcChildrenMap,
  captureProcessChildrenMap,
  checkLinuxProcSubprocessActivity,
  inspectSubprocessActivity,
} from "./subprocessActivity";
import type { ProcessChildrenMap } from "./processTreeKiller";

function buildChildrenMap(
  entries: Array<{ ppid: number; pid: number; command: string }>,
): ProcessChildrenMap {
  const map: ProcessChildrenMap = new Map();
  for (const { ppid, pid, command } of entries) {
    const siblings = map.get(ppid) ?? [];
    siblings.push({ pid, command });
    map.set(ppid, siblings);
  }
  return map;
}

describe("inspectSubprocessActivity", () => {
  it("reports no activity for an idle shell with no children", () => {
    const map = buildChildrenMap([]);
    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    });
  });

  it("treats nested shell-only descendants as not running", () => {
    const map = buildChildrenMap([
      { ppid: 100, pid: 200, command: "zsh" },
      { ppid: 200, pid: 300, command: "bash" },
    ]);
    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    });
  });

  it("flags a non-provider subprocess as running", () => {
    const map = buildChildrenMap([{ ppid: 100, pid: 200, command: "node build.js" }]);
    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: null,
      hasNonProviderSubprocess: true,
      hasProviderDescendant: false,
      hasRunningSubprocess: true,
    });
  });

  it("detects a provider descendant nested under a wrapper shell", () => {
    const map = buildChildrenMap([
      { ppid: 100, pid: 200, command: "zsh" },
      { ppid: 200, pid: 300, command: "codex" },
    ]);
    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: "codex",
      hasNonProviderSubprocess: false,
      hasProviderDescendant: true,
      hasRunningSubprocess: true,
    });
  });

  it("combines provider and non-provider activity across sibling branches", () => {
    const map = buildChildrenMap([
      { ppid: 100, pid: 200, command: "zsh" },
      { ppid: 200, pid: 300, command: "codex" },
      { ppid: 100, pid: 400, command: "node build.js" },
    ]);

    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: "codex",
      hasNonProviderSubprocess: true,
      hasProviderDescendant: true,
      hasRunningSubprocess: true,
    });
  });

  it("preserves provider and shell semantics for Windows executable names", () => {
    const map = buildChildrenMap([
      {
        ppid: 100,
        pid: 200,
        command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo',
      },
      { ppid: 200, pid: 300, command: "C:\\tools\\codex.exe" },
    ]);

    expect(inspectSubprocessActivity(100, map)).toEqual({
      cliKind: "codex",
      hasNonProviderSubprocess: false,
      hasProviderDescendant: true,
      hasRunningSubprocess: true,
    });
  });

  it("inspects multiple terminals against one shared snapshot", () => {
    // A single captured snapshot must yield independent, correct results per
    // terminal — this is the property the per-cycle batching relies on.
    const map = buildChildrenMap([
      { ppid: 100, pid: 200, command: "codex" },
      { ppid: 400, pid: 500, command: "zsh" },
    ]);

    expect(inspectSubprocessActivity(100, map).hasProviderDescendant).toBe(true);
    expect(inspectSubprocessActivity(100, map).cliKind).toBe("codex");
    expect(inspectSubprocessActivity(400, map)).toEqual({
      cliKind: null,
      hasNonProviderSubprocess: false,
      hasProviderDescendant: false,
      hasRunningSubprocess: false,
    });
  });
});

// Real child output makes the snapshot owner enforce its normal capture budget.
describe("captureProcessChildrenMap", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { bytes: 300_000, complete: true },
    { bytes: 9 * 1024 * 1024, complete: false },
  ])(
    "keeps tail activity only for a complete $bytes-byte process table",
    async ({ bytes, complete }) => {
      const runProcess = processRunner.runProcess;
      vi.spyOn(processRunner, "runProcess").mockImplementation((_command, _args, options) =>
        runProcess(
          process.execPath,
          [
            "-e",
            `const row = '100 1 node unrelated.js\\n'; process.stdout.write(row.repeat(Math.ceil(${bytes} / row.length)) + '300 200 node active-build.js\\n')`,
          ],
          options,
        ),
      );

      const snapshot = await captureProcessChildrenMap();
      if (!complete) {
        expect(snapshot).toBeNull();
        return;
      }
      expect(snapshot).not.toBeNull();
      expect(inspectSubprocessActivity(200, snapshot!)).toMatchObject({
        hasRunningSubprocess: true,
        hasNonProviderSubprocess: true,
      });
    },
  );
});

describe("Linux /proc subprocess inspection", () => {
  async function withFakeProc(
    setup: (procRoot: string) => Promise<void>,
    run: (procRoot: string) => Promise<void>,
  ) {
    const procRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synara-proc-test-"));
    try {
      await setup(procRoot);
      await run(procRoot);
    } finally {
      await fs.rm(procRoot, { recursive: true, force: true });
    }
  }

  it("reads empty and nested process trees directly from /proc without spawning ps", async () => {
    await withFakeProc(
      async (procRoot) => {
        // Idle shell pid 100
        await fs.mkdir(path.join(procRoot, "100", "task", "100"), { recursive: true });
        await fs.writeFile(path.join(procRoot, "100", "task", "100", "children"), "");
        await fs.writeFile(path.join(procRoot, "100", "stat"), "100 (zsh) S 1 100 100");
        await fs.writeFile(path.join(procRoot, "100", "cmdline"), "zsh\u0000-l\u0000");

        // Busy shell pid 200 -> child 201 (node build)
        await fs.mkdir(path.join(procRoot, "200", "task", "200"), { recursive: true });
        await fs.writeFile(path.join(procRoot, "200", "task", "200", "children"), "201 ");
        await fs.writeFile(path.join(procRoot, "200", "stat"), "200 (bash) S 1 200 200");
        await fs.writeFile(path.join(procRoot, "200", "cmdline"), "bash\u0000");

        await fs.mkdir(path.join(procRoot, "201", "task", "201"), { recursive: true });
        await fs.writeFile(path.join(procRoot, "201", "task", "201", "children"), "");
        // Comm with spaces and parentheses must still parse ppid=200 cleanly.
        await fs.writeFile(path.join(procRoot, "201", "stat"), "201 (node (worker)) S 200 200 200");
        await fs.writeFile(path.join(procRoot, "201", "cmdline"), "node\u0000build.js\u0000");
      },
      async (procRoot) => {
        expect(await checkLinuxProcSubprocessActivity(100, procRoot)).toEqual({
          cliKind: null,
          hasNonProviderSubprocess: false,
          hasProviderDescendant: false,
          hasRunningSubprocess: false,
        });

        expect(await checkLinuxProcSubprocessActivity(200, procRoot)).toEqual({
          cliKind: null,
          hasNonProviderSubprocess: true,
          hasProviderDescendant: false,
          hasRunningSubprocess: true,
        });

        const childrenMap = await captureLinuxProcChildrenMap(procRoot);
        expect(childrenMap).not.toBeNull();
        expect(inspectSubprocessActivity(200, childrenMap!)).toMatchObject({
          hasRunningSubprocess: true,
          hasNonProviderSubprocess: true,
        });
      },
    );
  });

  it("returns null when /proc children listing is unavailable", async () => {
    expect(await checkLinuxProcSubprocessActivity(999999, "/nonexistent-proc-root")).toBeNull();
  });
});
