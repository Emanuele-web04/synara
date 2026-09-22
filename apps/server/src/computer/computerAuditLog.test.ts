import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import {
  COMPUTER_AUDIT_MAX_ENTRIES,
  COMPUTER_AUDIT_MAX_BYTES,
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
  vi.restoreAllMocks();
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
  it("persists reviewed native diagnostics but strips arbitrary native payloads", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "computer-audit.jsonl");
    const log = new ComputerAuditLog(filePath);
    const diagnostics = {
      delivery_path: "ax" as const,
      actuator: "ax_press" as const,
      ax_error: -25202,
      window_title: "private window title",
      message: "private field value",
      text: "private typed content",
    };
    log.record({
      tool: "computer_click",
      effect: "dispatched-unknown",
      code: "cua_action_failed",
      diagnostics,
    });
    await log.flush();
    const saved = await readFile(filePath, "utf8");
    expect(JSON.parse(saved).diagnostics).toEqual({
      delivery_path: "ax",
      actuator: "ax_press",
      ax_error: -25202,
    });
    expect(saved).not.toContain("private");
  });
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

  it("retains a bounded UTF-8 tail of a huge legacy file without reading its prefix", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "computer-audit.jsonl");
    const legacy = await fs.open(filePath, "w", 0o600);
    // Sparse history makes a full-file read materially larger than the allowed
    // evidence tail without allocating that prefix in the fixture itself.
    const prefixBytes = 16 * COMPUTER_AUDIT_MAX_BYTES;
    await legacy.truncate(prefixBytes);
    const tail =
      Array.from({ length: 2_000 }, (_, index) =>
        JSON.stringify({
          ts: "old",
          tool: "computer_click",
          args: { index, label: "界🙂".repeat(100) },
        }),
      ).join("\n") + "\n";
    await legacy.write(tail, prefixBytes, "utf8");
    const handlePrototype: Pick<typeof legacy, "read"> = Object.getPrototypeOf(legacy);
    await legacy.close();
    const reads = vi.spyOn(handlePrototype, "read");
    const wholeFileReads = vi.spyOn(fs, "readFile");
    const log = new ComputerAuditLog(filePath);
    log.record({ tool: "computer_click", args: { index: -1 }, effect: "verified" });
    log.record({ tool: "computer_click", args: { index: -2 }, effect: "verified" });
    await log.flush();
    expect(wholeFileReads).not.toHaveBeenCalled();
    const positionalReads = reads.mock.calls as unknown as readonly (readonly [
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ])[];
    expect(positionalReads.length).toBeGreaterThan(0);
    expect(
      positionalReads.every(
        ([, , length, position]) =>
          length <= COMPUTER_AUDIT_MAX_BYTES && position >= prefixBytes - COMPUTER_AUDIT_MAX_BYTES,
      ),
    ).toBe(true);
    expect(positionalReads.reduce((bytes, [, , length]) => bytes + length, 0)).toBeLessThanOrEqual(
      2 * COMPUTER_AUDIT_MAX_BYTES,
    );
    vi.restoreAllMocks();

    const retained = await readFile(filePath, "utf8");
    const entries = retained
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(COMPUTER_AUDIT_MAX_BYTES);
    expect(entries.length).toBeLessThanOrEqual(COMPUTER_AUDIT_MAX_ENTRIES);
    expect(entries.slice(-2).map((entry) => entry.args.index)).toEqual([-1, -2]);
    const historical = entries.slice(0, -2);
    expect(historical.length).toBeGreaterThan(0);
    expect(historical.at(-1).args.index).toBe(1_999);
    expect(historical.every((entry) => entry.args.label === "界🙂".repeat(100))).toBe(true);
    expect(
      historical.every(
        (entry, index) => index === 0 || entry.args.index === historical[index - 1].args.index + 1,
      ),
    ).toBe(true);
  });

  it("omits oversized or unserializable evidence without poisoning subsequent appends", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "computer-audit.jsonl");
    const log = new ComputerAuditLog(filePath);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() =>
      log.record({ tool: "computer_click", args: circular, effect: "verified" }),
    ).not.toThrow();
    log.record({
      tool: "computer_click",
      args: { label: "界".repeat(COMPUTER_AUDIT_MAX_BYTES) },
      effect: "verified",
    });
    log.record({ tool: "computer_click", gatewayRequestId: "next", effect: "verified" });
    await log.flush();
    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).gatewayRequestId).toBe("next");
  });

  it("separates an interrupted legacy tail from the next complete action", async () => {
    const dir = await tempDir();
    const filePath = join(dir, "computer-audit.jsonl");
    await writeFile(filePath, '{"tool":"computer_click"');
    const log = new ComputerAuditLog(filePath);
    log.record({ tool: "computer_click", gatewayRequestId: "next", effect: "verified" });
    await expect(log.readHistory({})).resolves.toMatchObject({
      entries: [{ gatewayRequestId: "next" }],
      truncated: true,
    });
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
