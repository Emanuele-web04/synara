import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ComputerGetAuditHistoryInput, ComputerGetAuditHistoryResult } from "./computerAudit";
import { ServerReadThreadDiagnosticsInput } from "./server";

describe("bounded owner history requests", () => {
  it("accepts bounded Computer history pages and rejects oversized or path-like cursors", () => {
    const decode = Schema.decodeUnknownSync(ComputerGetAuditHistoryInput);
    expect(decode({ limit: 100, before: "YWJj" })).toEqual({ limit: 100, before: "YWJj" });
    for (const input of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { before: "../private" },
      { before: "x".repeat(513) },
    ]) {
      expect(() => decode(input)).toThrow();
    }
  });

  it("rejects unknown outcomes and unbounded result pages", () => {
    const decode = Schema.decodeUnknownSync(ComputerGetAuditHistoryResult);
    const entry = {
      id: "a".repeat(64),
      ts: "2026-09-20T12:00:00.000Z",
      tool: "computer_click",
      effect: "dispatched-unknown",
    };
    const result = { entries: [entry], status: "available", nextCursor: null, truncated: false };
    expect(decode(result)).toEqual(result);
    expect(() => decode({ ...result, entries: [{ ...entry, effect: "success" }] })).toThrow();
    expect(() => decode({ ...result, entries: Array(101).fill(entry) })).toThrow();
  });

  it("bounds diagnostic page size, cursor and filters before dispatch", () => {
    const decode = Schema.decodeUnknownSync(ServerReadThreadDiagnosticsInput);
    expect(
      decode({ source: "runtime", threadId: "thread-1", limit: 200, includeDetails: true }),
    ).toMatchObject({ source: "runtime", limit: 200 });
    for (const input of [
      { limit: 201 },
      { cursor: "x".repeat(4_097) },
      { threadId: "x".repeat(257) },
      { eventTypes: Array(65).fill("turn.started") },
      { eventTypes: ["x".repeat(129)] },
    ]) {
      expect(() => decode({ source: "events", threadId: "thread-1", ...input })).toThrow();
    }
  });
});
