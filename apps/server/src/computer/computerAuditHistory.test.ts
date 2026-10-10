import { appendFile, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ComputerGetAuditHistoryResult } from "@synara/contracts";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMPUTER_AUDIT_HISTORY_MAX_BYTES,
  COMPUTER_AUDIT_HISTORY_MAX_ROWS,
  readComputerAuditHistory,
} from "./computerAuditHistory.ts";
import { ComputerAuditLog, computerAuditGatewayRequestId } from "./computerAuditLog.ts";

const directories: string[] = [];

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "synara-computer-history-"));
  directories.push(dir);
  return join(dir, "computer-audit.jsonl");
}

function line(index: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    ts: "2026-09-20T12:00:00.000Z",
    tool: "computer_click",
    effect: "dispatched-unknown",
    gatewayRequestId: String(index),
    ...extra,
  })}\n`;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Computer audit history", () => {
  it("distinguishes absent logging, no history, and an empty retained log", async () => {
    const path = await fixture();
    await expect(readComputerAuditHistory(undefined, {})).resolves.toMatchObject({
      status: "disabled",
      entries: [],
    });
    await expect(readComputerAuditHistory(path, {})).resolves.toMatchObject({ status: "missing" });
    await writeFile(path, "");
    await expect(readComputerAuditHistory(path, {})).resolves.toEqual({
      status: "available",
      entries: [],
      nextCursor: null,
      truncated: false,
    });
  });

  it("projects only bounded identifiers and typed outcomes, never payloads or paths", async () => {
    const path = await fixture();
    await writeFile(
      path,
      line(1, {
        threadId: "thread-1",
        turnId: "turn-1",
        effect: "refused",
        code: "computer_control_revoked",
        args: { text: "secret", url: "https://private.test/?token=secret" },
        target: { app: "secret", windowId: "secret", path: "/private/secret" },
        result: "secret",
        password: "secret",
      }) +
        line(2, {
          threadId: "/private/secret",
          code: "secret\ncredential",
          turnId: "x".repeat(129),
        }),
    );
    const result = await readComputerAuditHistory(path, {});
    expect(Schema.decodeUnknownSync(ComputerGetAuditHistoryResult)(result)).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.entries[1]).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-1",
      gatewayRequestId: "1",
      code: "computer_control_revoked",
      effect: "refused",
    });
    expect(Object.keys(result.entries[0]!)).toEqual([
      "id",
      "ts",
      "tool",
      "effect",
      "gatewayRequestId",
    ]);
  });

  it("keeps append-order pagination stable when newer actions arrive", async () => {
    const path = await fixture();
    await writeFile(path, [1, 2, 3, 4].map((n) => line(n)).join(""));
    const first = await readComputerAuditHistory(path, { limit: 2 });
    expect(first.entries.map((entry) => entry.gatewayRequestId)).toEqual(["4", "3"]);
    await appendFile(path, line(5));
    const second = await readComputerAuditHistory(path, { limit: 2, before: first.nextCursor! });
    expect(second.entries.map((entry) => entry.gatewayRequestId)).toEqual(["2", "1"]);
    expect(second.nextCursor).toBeNull();
    expect(second.truncated).toBe(false);
  });

  it("reads known rotations and preserves distinct identical records", async () => {
    const path = await fixture();
    await writeFile(path, line(1) + line(1) + line(2));
    const first = await readComputerAuditHistory(path, { limit: 2 });
    await rename(path, `${path}.1`);
    await writeFile(path, line(3));
    await writeFile(`${path}.2`, line(0));
    const second = await readComputerAuditHistory(path, { before: first.nextCursor! });
    expect(second.entries.map((entry) => entry.gatewayRequestId)).toEqual(["1", "0"]);
    expect(second.entries[0]!.id).not.toEqual(first.entries[1]!.id);
    expect(second.truncated).toBe(false);
  });

  it("recovers a uniquely retained cursor after compaction and marks expired cursors", async () => {
    const path = await fixture();
    await writeFile(path, [1, 2, 3, 4].map((n) => line(n)).join(""));
    const first = await readComputerAuditHistory(path, { limit: 2 });
    await writeFile(`${path}.tmp`, [2, 3, 4, 5].map((n) => line(n)).join(""));
    await rename(`${path}.tmp`, path);
    const retained = await readComputerAuditHistory(path, { before: first.nextCursor! });
    expect(retained.entries.map((entry) => entry.gatewayRequestId)).toEqual(["2"]);
    await writeFile(`${path}.tmp`, line(5));
    await rename(`${path}.tmp`, path);
    await expect(readComputerAuditHistory(path, { before: first.nextCursor! })).resolves.toEqual({
      entries: [],
      nextCursor: null,
      truncated: true,
      status: "available",
    });
  });

  it("does not guess an ambiguous duplicate cursor after compaction", async () => {
    const path = await fixture();
    await writeFile(path, line(1) + line(1));
    const first = await readComputerAuditHistory(path, { limit: 1 });
    await writeFile(`${path}.tmp`, line(1) + line(1) + line(2));
    await rename(`${path}.tmp`, path);
    await expect(
      readComputerAuditHistory(path, { before: first.nextCursor! }),
    ).resolves.toMatchObject({
      entries: [],
      nextCursor: null,
      truncated: true,
    });
  });

  it("bounds bytes and skips oversized, malformed and incomplete records", async () => {
    const path = await fixture();
    await writeFile(
      path,
      "x".repeat(COMPUTER_AUDIT_HISTORY_MAX_BYTES + 1) + "\n{invalid}\n" + line(1) + '{"secret":',
    );
    const result = await readComputerAuditHistory(path, { limit: 100 });
    expect(result.entries.map((entry) => entry.gatewayRequestId)).toEqual(["1"]);
    expect(result.truncated).toBe(true);
  });

  it("bounds scanned rows and results, including when an old cursor is outside the tail", async () => {
    const path = await fixture();
    await writeFile(path, line(1) + line(2));
    const initial = await readComputerAuditHistory(path, { limit: 1 });
    await appendFile(path, line(3).repeat(COMPUTER_AUDIT_HISTORY_MAX_ROWS + 1));
    const result = await readComputerAuditHistory(path, { limit: 100 });
    expect(result.entries).toHaveLength(100);
    expect(result.truncated).toBe(true);
    await expect(
      readComputerAuditHistory(path, { before: initial.nextCursor! }),
    ).resolves.toMatchObject({
      entries: [],
      truncated: true,
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses symbolic links instead of following arbitrary paths",
    async () => {
      const path = await fixture();
      await writeFile(`${path}.private`, line(1));
      await symlink(`${path}.private`, path);
      await expect(readComputerAuditHistory(path, {})).rejects.toThrow(
        "Could not read Computer activity history.",
      );
    },
  );

  it("rejects invalid limits and cursor formats without treating them as filesystem paths", async () => {
    const path = await fixture();
    await expect(readComputerAuditHistory(path, { limit: 101 })).rejects.toThrow(
      "between 1 and 100",
    );
    await expect(readComputerAuditHistory(path, { before: "../../private" })).rejects.toThrow(
      "Invalid Computer activity cursor",
    );
    await expect(readComputerAuditHistory(path, { before: "e30" })).rejects.toThrow(
      "Invalid Computer activity cursor",
    );
  });

  it("waits for queued evidence before reading through the log owner", async () => {
    const path = await fixture();
    const log = new ComputerAuditLog(path);
    log.record({ tool: "computer_click", effect: "verified", gatewayRequestId: "request-1" });
    await expect(log.readHistory({})).resolves.toMatchObject({
      entries: [{ tool: "computer_click", effect: "verified", gatewayRequestId: "request-1" }],
    });
  });
});

describe("audit gateway request identity", () => {
  it("keeps actual bounded transport identities and omits payload-like values", () => {
    expect(computerAuditGatewayRequestId(42)).toEqual({ gatewayRequestId: "42" });
    expect(computerAuditGatewayRequestId("rpc-request-1")).toEqual({
      gatewayRequestId: "rpc-request-1",
    });
    for (const invalid of [
      null,
      undefined,
      NaN,
      "/private/file",
      "token\nvalue",
      "x".repeat(129),
    ]) {
      expect(computerAuditGatewayRequestId(invalid)).toEqual({});
    }
  });
});
