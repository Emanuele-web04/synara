import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import {
  COMPUTER_AUDIT_MAX_ENTRIES,
  ComputerAuditLog,
  summarizeComputerAuditArgs,
} from "./computerAuditLog.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "computer-audit-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("summarizeComputerAuditArgs", () => {
  it("records typed text as a character count, never the payload", () => {
    const summary = summarizeComputerAuditArgs({
      text: "hunter2 -- a typed secret",
      x: 10,
      y: 20,
    });
    expect(summary).toEqual({ text: { chars: 25 }, x: 10, y: 20 });
    expect(JSON.stringify(summary)).not.toContain("hunter2");
  });

  it("records clipboard and file payloads as counts only", () => {
    const summary = summarizeComputerAuditArgs({
      contents: "clipboard payload with a token",
      value: "set_value payload",
      arguments: ["--password=s3cret"],
      files: ["/tmp/a", "/tmp/b"],
      label: "OK",
    });
    expect(JSON.stringify(summary)).not.toContain("s3cret");
    expect(JSON.stringify(summary)).not.toContain("token");
    expect(JSON.stringify(summary)).not.toContain("/tmp/a");
    expect(summary.contents).toEqual({ chars: 30 });
    expect(summary.value).toEqual({ chars: 17 });
    expect(summary.arguments).toEqual({ items: 1 });
    expect(summary.files).toEqual({ items: 2 });
    expect(summary.label).toBe("OK");
  });

  it("keeps a computer_run's step shape without the step payloads", () => {
    const summary = summarizeComputerAuditArgs({
      steps: [
        { type: "click", x: 1, y: 2 },
        { type: "type", text: "password" },
      ],
    });
    expect(summary.steps).toEqual({ count: 2, types: ["click", "type"] });
    expect(JSON.stringify(summary)).not.toContain("password");
  });

  it("sanitizes sensitive keys nested inside a target object", () => {
    const summary = summarizeComputerAuditArgs({
      target: { windowId: "w1", value: "field payload", x: 5 },
    });
    const target = summary.target as Record<string, unknown>;
    expect(target.value).toEqual({ chars: 13 });
    expect(target.windowId).toBe("w1");
    expect(JSON.stringify(summary)).not.toContain("field payload");
  });
});

describe("ComputerAuditLog", () => {
  it("appends one JSON object per line with timestamp, target, and effect", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "computer-audit.jsonl");
    const log = new ComputerAuditLog(filePath);
    log.record({
      tool: "computer_click",
      threadId: "thread-1",
      turnId: "turn-1",
      target: { windowId: "w1", pid: 42, app: "Finder" },
      args: { x: 10, y: 20 },
      effect: "verified",
    });
    log.record({
      tool: "computer_type_text",
      threadId: "thread-1",
      target: { windowId: "w1" },
      args: { text: { chars: 12 } },
      effect: "refused",
      code: "computer_denylist_refused",
    });
    await log.flush();
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!);
    expect(first.tool).toBe("computer_click");
    expect(first.threadId).toBe("thread-1");
    expect(first.turnId).toBe("turn-1");
    expect(first.target).toEqual({ windowId: "w1", pid: 42, app: "Finder" });
    expect(first.effect).toBe("verified");
    expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const second = JSON.parse(lines[1]!);
    expect(second.effect).toBe("refused");
    expect(second.code).toBe("computer_denylist_refused");
    const fileStat = await stat(filePath);
    expect((fileStat.mode & 0o777).toString(8)).toBe("600");
  });

  it("serializes concurrent appends into intact ordered lines", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "computer-audit.jsonl");
    const log = new ComputerAuditLog(filePath);
    for (let index = 0; index < 100; index += 1) {
      log.record({
        tool: "computer_click",
        threadId: "thread",
        args: { index },
        effect: "dispatched-unknown",
      });
    }
    await log.flush();
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(100);
    for (const [index, line] of lines.entries()) {
      expect(JSON.parse(line).args).toEqual({ index });
    }
  });

  it("counts a pre-existing log toward the entry cap and compacts to a bounded tail", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "computer-audit.jsonl");
    const seeded = Array.from(
      { length: COMPUTER_AUDIT_MAX_ENTRIES },
      (_, index) => `${JSON.stringify({ ts: "old", tool: "computer_click", args: { index } })}\n`,
    ).join("");
    await writeFile(filePath, seeded, { mode: 0o600 });
    const log = new ComputerAuditLog(filePath);
    log.record({ tool: "computer_click", args: { index: -1 }, effect: "verified" });
    await log.flush();
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    // Compaction keeps a bounded newest tail ending in the record just written.
    expect(lines.length).toBeLessThan(COMPUTER_AUDIT_MAX_ENTRIES);
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.parse(lines.at(-1)!).args).toEqual({ index: -1 });
  });

  it("swallows write failures instead of failing the recorded action", async () => {
    const dir = await tempDir();
    // A path whose parent is a file can never be opened.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x");
    const log = new ComputerAuditLog(join(blocker, "computer-audit.jsonl"));
    expect(() => log.record({ tool: "computer_click", effect: "verified" })).not.toThrow();
    await log.flush();
  });
});

describe("ComputerManager audit seam", () => {
  it("a thread whose control is off records nothing, even for the refusal that stopped it", async () => {
    const dir = await tempDir();
    const auditLogPath = join(dir, "computer-audit.jsonl");
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, auditLogPath, actionSettleMs: 0 });
    const threadId = "disabled-thread";
    await manager.setControlEnabled(threadId, false);
    manager.recordComputerAudit({
      tool: "computer_click",
      threadId,
      args: { x: 1, y: 1 },
      effect: "refused",
      code: "computer_control_revoked",
    });
    await manager.dispose();
    await expect(readFile(auditLogPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a disabled thread records nothing at all — no lifecycle row survives the drop", async () => {
    const dir = await tempDir();
    const auditLogPath = join(dir, "computer-audit.jsonl");
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, auditLogPath, actionSettleMs: 0 });
    const threadId = "disabled-thread";
    await manager.setControlEnabled(threadId, false);
    // A refused input attempt on a disabled thread still drops.
    manager.recordComputerAudit({
      tool: "computer_click",
      threadId,
      args: { x: 1, y: 1 },
      effect: "refused",
      code: "computer_control_revoked",
    });
    await manager.dispose();
    await expect(readFile(auditLogPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records through the manager once control is enabled", async () => {
    const dir = await tempDir();
    const auditLogPath = join(dir, "computer-audit.jsonl");
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, auditLogPath, actionSettleMs: 0 });
    manager.recordComputerAudit({
      tool: "computer_click",
      threadId: "enabled-thread",
      effect: "verified",
    });
    await manager.dispose();
    const lines = (await readFile(auditLogPath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).effect).toBe("verified");
  });
});
