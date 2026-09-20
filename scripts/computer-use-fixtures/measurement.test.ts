import { describe, expect, it } from "vitest";
import {
  collectComputerRun,
  prepareComputerRunDiagnostics,
  type DiagnosticToolCaller,
} from "./measurement.ts";

const time = (seconds: number) => new Date(Date.UTC(2026, 8, 20, 10, 0, seconds)).toISOString();
const scope = { threadId: "fresh", turnId: "turn", runStartedAt: time(0) };
type Row = Record<string, unknown>;
const event = (sequence: number, type: string, payload: Row = {}, extra: Row = {}): Row => ({
  sequence,
  eventId: `event-${sequence}`,
  type,
  provider: "codex",
  turnId: "turn",
  createdAt: time(sequence),
  detail: { type, payload },
  ...extra,
});
const usage = (sequence: number, input: number, output: number, cached: number): Row =>
  event(sequence, "thread.token-usage.updated", {
    usage: {
      cumulativeUsage: { inputTokens: input, outputTokens: output, cachedInputTokens: cached },
    },
  });
function fixtures() {
  return {
    journal: [
      { sequence: 1, eventId: "created", type: "thread.created", occurredAt: time(1) },
      {
        sequence: 2,
        eventId: "dispatch",
        type: "thread.turn-start-requested",
        occurredAt: time(2),
      },
    ],
    runtime: [
      event(1, "session.started", {}, { turnId: null }),
      usage(2, 20, 2, 10),
      event(3, "turn.started"),
      event(
        4,
        "item.started",
        {
          itemType: "mcp_tool_call",
          data: { tool: "computer_click" },
        },
        { itemId: "item-1" },
      ),
      event(
        5,
        "item.completed",
        {
          itemType: "mcp_tool_call",
          status: "completed",
          data: { tool: "computer_click", callId: "call-1", arguments: { text: "private" } },
        },
        { itemId: "item-1" },
      ),
      usage(6, 100, 10, 60),
      usage(7, 140, 15, 70),
      event(8, "turn.completed", { state: "completed" }),
    ],
  };
}

function reader(input: ReturnType<typeof fixtures>, pageSize = 25): DiagnosticToolCaller {
  return async (name, args) => {
    const runtime = name === "synara_read_thread_runtime_events";
    const all = runtime ? input.runtime : input.journal;
    const end = typeof args.cursor === "string" ? Number(args.cursor) : all.length;
    const start = Math.max(0, end - pageSize);
    return {
      threadId: "fresh",
      events: all.slice(start, end),
      coverage: {
        source: runtime ? "provider_runtime_events" : "orchestration_events",
        highWaterSequence: all.at(-1)?.sequence ?? 0,
        pageHasOlder: start > 0,
        ...(runtime
          ? {
              sourceComplete: false,
              oldestRetainedSequence: all[0]?.sequence ?? null,
              retainedForThread: all.length,
            }
          : { durableSourceComplete: true }),
      },
      ...(start > 0 ? { nextCursor: String(start) } : {}),
    };
  };
}

describe("computer run measurement", () => {
  it("preflights explicit fresh-thread pages without treating empty pre-turn runtime as a completed run", async () => {
    const data = fixtures();
    data.journal = data.journal.slice(0, 1);
    data.runtime = [];
    const prepared = await prepareComputerRunDiagnostics(reader(data), scope);
    expect(prepared.ready).toBe(true);
    expect(prepared.runtime).toMatchObject({ highWaterSequence: 0, retainedForThread: 0 });
    expect((await collectComputerRun(reader(data), scope)).valid).toBe(false);
  });

  it("refuses null serialization, missing creation and reused runtime before a paid turn", async () => {
    await expect(prepareComputerRunDiagnostics(async () => null, scope)).rejects.toThrow(
      "missing or invalid page coverage",
    );
    const data = fixtures();
    data.journal = [];
    data.runtime = [];
    await expect(prepareComputerRunDiagnostics(reader(data), scope)).rejects.toThrow(
      "observed fresh, undispatched thread",
    );
    data.journal = fixtures().journal;
    await expect(prepareComputerRunDiagnostics(reader(data), scope)).rejects.toThrow(
      "undispatched",
    );
    data.journal = data.journal.slice(0, 1);
    data.runtime = [event(1, "session.started")];
    await expect(prepareComputerRunDiagnostics(reader(data), scope)).rejects.toThrow(
      "prior or unverifiable provider runtime state",
    );
  });

  it("pages to the fresh-thread boundary, deduplicates tool lifecycle, and uses cumulative deltas", async () => {
    const report = await collectComputerRun(reader(fixtures(), 2), scope);
    expect(report.valid).toBe(true);
    expect(report.coverage.runtimePages).toBe(4);
    expect(report.toolCalls).toEqual({ total: 1, computer: 1, byName: { computer_click: 1 } });
    expect(report.calls[0]?.callId).toBe("call-1");
    expect(report.usage).toMatchObject({
      basis: "cumulative-delta",
      inputTokens: 120,
      outputTokens: 13,
      cachedInputTokens: 60,
      uncachedInputTokens: 60,
    });
    expect(report.wallClockMs).toBe(6000);
    expect(JSON.stringify(report)).not.toContain("private");
    expect(report.acceptance.focus).toBe("unverified");
  });

  it("uses fresh-thread totals when no pre-turn usage snapshot exists", async () => {
    const data = fixtures();
    data.runtime.splice(1, 1);
    const report = await collectComputerRun(reader(data), scope);
    expect(report.valid).toBe(true);
    expect(report.usage).toMatchObject({ basis: "fresh-thread-cumulative", outputTokens: 15 });
  });

  it("retains calls and usage for an interrupted turn while refusing completed-run qualification", async () => {
    const data = fixtures();
    data.runtime[data.runtime.length - 1] = event(8, "turn.aborted", { state: "interrupted" });
    data.journal.push({
      sequence: 3,
      eventId: "interrupted",
      type: "thread.turn-interrupt-requested",
      occurredAt: time(7),
    });
    const report = await collectComputerRun(reader(data), scope);
    expect(report.valid).toBe(false);
    expect(report.issues).toContain("turn-interrupted");
    expect(report.issues).toContain("completed-turn-coverage-unproven");
    expect(report.toolCalls.computer).toBe(1);
    expect(report.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 13,
      cachedInputTokens: 60,
    });
  });

  it("reads Codex native data.item envelopes using the canonical item ID", async () => {
    const data = fixtures();
    for (const row of data.runtime.filter(
      (entry) => entry.type === "item.started" || entry.type === "item.completed",
    )) {
      row.detail = {
        payload: {
          itemType: "mcp_tool_call",
          status: "completed",
          data: { item: { id: "item-1", type: "mcpToolCall", tool: "computer_click" } },
        },
      };
    }
    const report = await collectComputerRun(reader(data), scope);
    expect(report.valid).toBe(true);
    expect(report.toolCalls.computer).toBe(1);
    expect(report.calls[0]?.callId).toBe("item-1");
  });

  it("counts native Codex command, search and file-change lifecycles without retaining their content", async () => {
    const data = fixtures();
    const native = [
      ["command_execution", "commandExecution", { command: "private-command" }],
      ["web_search", "webSearch", { query: "private-search" }],
      ["file_change", "fileChange", { changes: [{ path: "private-path" }] }],
    ] as const;
    data.runtime.splice(
      -1,
      1,
      ...native.flatMap(([itemType, type, content], index) =>
        ["item.started", "item.completed"].map((lifecycle, offset) =>
          event(
            8 + index * 2 + offset,
            lifecycle,
            {
              itemType,
              status: offset === 0 ? "inProgress" : "completed",
              data: { item: { id: `native-${index}`, type, ...content } },
            },
            { itemId: `native-${index}` },
          ),
        ),
      ),
      event(14, "turn.completed", { state: "completed" }),
    );
    const report = await collectComputerRun(reader(data), scope);
    expect(report.valid).toBe(true);
    expect(report.toolCalls).toEqual({ total: 4, computer: 1, byName: { computer_click: 1 } });
    expect(report.calls.map((call) => call.tool)).toEqual([
      "computer_click",
      "command_execution",
      "web_search",
      "file_change",
    ]);
    expect(JSON.stringify(report)).not.toContain("private-");

    data.runtime = data.runtime.filter(
      (row) => !(row.itemId === "native-0" && row.type === "item.started"),
    );
    expect((await collectComputerRun(reader(data), scope)).issues).toContain(
      "tool-call-lifecycle-incomplete",
    );
  });

  it("does not hide an unnamed MCP call behind its canonical type", async () => {
    const data = fixtures();
    data.runtime.splice(
      -1,
      1,
      event(8, "item.started", { itemType: "mcp_tool_call" }, { itemId: "unnamed" }),
      event(9, "item.completed", { itemType: "mcp_tool_call" }, { itemId: "unnamed" }),
      event(10, "turn.completed", { state: "completed" }),
    );
    const report = await collectComputerRun(reader(data), scope);
    expect(report.valid).toBe(false);
    expect(report.issues).toContain("tool-call-missing-identity-or-name");
  });

  it("invalidates reused threads and a missing initial creation event", async () => {
    const data = fixtures();
    data.journal[0]!.occurredAt = time(-1);
    expect((await collectComputerRun(reader(data), scope)).issues).toContain(
      "fresh-thread-unproven",
    );
    data.journal.shift();
    expect((await collectComputerRun(reader(data), scope)).valid).toBe(false);
  });

  it("does not certify a resumed second turn as a fresh run", async () => {
    const data = fixtures();
    data.journal.push({
      sequence: 3,
      eventId: "again",
      type: "thread.turn-start-requested",
      occurredAt: time(3),
    });
    data.runtime.push(event(9, "turn.started", {}, { turnId: "second-turn" }));
    const report = await collectComputerRun(reader(data), scope);
    expect(report.issues).toContain("fresh-thread-unproven");
    expect(report.issues).toContain("other-turn-in-fresh-thread");
  });

  it("rejects empty/truncated evidence instead of reporting a successful zero", async () => {
    const data = fixtures();
    data.runtime = [];
    const report = await collectComputerRun(reader(data), scope);
    expect(report.valid).toBe(false);
    expect(report.issues).toContain("no-computer-calls-observed");
    expect(report.issues).toContain("completed-turn-coverage-unproven");
    data.runtime = fixtures().runtime.slice(3);
    expect((await collectComputerRun(reader(data), scope)).issues).toContain(
      "runtime-retention-gap",
    );
  });

  it("fails bounded pagination, repeated cursors, and changing high-water marks", async () => {
    await expect(
      collectComputerRun(reader(fixtures(), 1), { ...scope, maxPages: 1 }),
    ).rejects.toThrow("page limit");
    const normal = reader(fixtures(), 1);
    const repeated: DiagnosticToolCaller = async (name, args) => ({
      ...((await normal(name, { ...args, cursor: undefined })) as Row),
      nextCursor: "same",
    });
    await expect(collectComputerRun(repeated, scope)).rejects.toThrow("repeated pagination cursor");
    const moving: DiagnosticToolCaller = async (name, args) => {
      const page = (await normal(name, args)) as Row;
      return {
        ...page,
        coverage: { ...(page.coverage as Row), highWaterSequence: args.cursor ? 99 : 2 },
      };
    };
    await expect(collectComputerRun(moving, scope)).rejects.toThrow("high-water mark changed");
  });

  it("rejects missing/redacted usage and does not mistake latest request counters for totals", async () => {
    const data = fixtures();
    data.runtime[6] = event(7, "thread.token-usage.updated", {
      usage: { inputTokens: 140, outputTokens: 15, cumulativeUsage: { inputTokens: "[redacted]" } },
    });
    const report = await collectComputerRun(reader(data), scope);
    expect(report.valid).toBe(false);
    expect(report.usage).toBeNull();
    expect(report.issues).toContain("cumulative-usage-missing-or-redacted");
  });

  it("invalidates cumulative counter resets and unknown cache counts", async () => {
    const data = fixtures();
    data.runtime[6] = usage(7, 50, 5, 20);
    expect((await collectComputerRun(reader(data), scope)).issues).toContain("usage-counter-reset");
    data.runtime[6] = event(7, "thread.token-usage.updated", {
      usage: { cumulativeUsage: { inputTokens: 140, outputTokens: 15 } },
    });
    expect((await collectComputerRun(reader(data), scope)).issues).toContain(
      "cache-usage-unavailable",
    );
  });

  it.each(["cachedInputTokens", "cacheCreationInputTokens"])(
    "invalidates a reset of %s even while input and output totals rise",
    async (counter) => {
      const data = fixtures();
      for (const row of data.runtime.filter(
        (entry) => entry.type === "thread.token-usage.updated",
      )) {
        const totals = ((row.detail as Row).payload as Row).usage as Row;
        (totals.cumulativeUsage as Row)[counter] =
          row.sequence === 2 ? 10 : row.sequence === 6 ? 60 : 30;
      }
      const report = await collectComputerRun(reader(data), scope);
      expect(report.valid).toBe(false);
      expect(report.issues).toContain("usage-counter-reset");
    },
  );

  it("keeps optional mutation audit counts separate from all-call totals", async () => {
    const report = await collectComputerRun(reader(fixtures()), {
      ...scope,
      auditEntries: [
        {
          threadId: "fresh",
          turnId: "turn",
          tool: "computer_click",
          effect: "dispatched-unknown",
          args: { text: "secret" },
        },
        { threadId: "other", turnId: "turn", tool: "computer_click", effect: "refused" },
        { threadId: "fresh", tool: "computer_click", effect: "refused" },
      ],
    });
    expect(report.toolCalls.total).toBe(1);
    expect(report.audit).toMatchObject({ byTool: { computer_click: 1 }, missingTurnId: 1 });
    expect(JSON.stringify(report)).not.toContain("secret");
  });
});
