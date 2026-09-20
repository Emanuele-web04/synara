/** Bounded, read-only measurement through Synara's existing diagnostic tools.
 * No live SQLite access and no transcript or tool-argument payloads in reports.
 */
import { isToolLifecycleItemType } from "@synara/contracts";

export type DiagnosticToolCaller = (
  name: "synara_read_thread_events" | "synara_read_thread_runtime_events",
  args: Record<string, unknown>,
) => Promise<unknown>;

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const timestamp = (value: unknown): number => (typeof value === "string" ? Date.parse(value) : NaN);

export interface ComputerRunScope {
  threadId: string;
  turnId: string;
  /** Capture before creating the fresh benchmark thread. */
  runStartedAt: string;
  maxPages?: number;
  /** Optional already-read mutation audit; never a source for total calls. */
  auditEntries?: readonly unknown[];
}

interface PageSet {
  rows: Row[];
  coverage: Row;
  pages: number;
}

function measurementRow(row: Row, runtime: boolean): Row {
  const base = { sequence: row.sequence, eventId: row.eventId, type: row.type };
  if (!runtime) return { ...base, occurredAt: row.occurredAt };
  const payload = runtimePayload(row);
  const envelope = record(payload.data);
  // Codex keeps the native item under data.item; other adapters project its
  // tool fields directly onto data. Both retain canonical itemId on the row.
  const data = record(envelope.item ?? envelope);
  const totals = record(record(payload.usage).cumulativeUsage);
  return {
    ...base,
    createdAt: row.createdAt,
    provider: row.provider,
    turnId: row.turnId,
    itemId: row.itemId,
    detail: {
      payload: {
        itemType: payload.itemType,
        status: payload.status,
        state: payload.state,
        data: {
          callId: data.callId,
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          tool: data.tool,
          name: data.name,
        },
        usage: {
          cumulativeUsage: {
            inputTokens: totals.inputTokens,
            outputTokens: totals.outputTokens,
            cachedInputTokens: totals.cachedInputTokens,
            cacheCreationInputTokens: totals.cacheCreationInputTokens,
          },
        },
      },
    },
  };
}

async function collectPages(
  call: DiagnosticToolCaller,
  name: Parameters<DiagnosticToolCaller>[0],
  args: Row,
  maxPages: number,
): Promise<PageSet> {
  const seenCursors = new Set<string>();
  const seenRows = new Map<number, Row>();
  const seenEventIds = new Map<string, number>();
  const runtime = name === "synara_read_thread_runtime_events";
  let cursor: string | undefined;
  let firstCoverage: Row | undefined;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    const page = record(await call(name, { ...args, ...(cursor ? { cursor } : {}), limit: 25 }));
    const coverage = record(page.coverage);
    if (
      page.threadId !== args.threadId ||
      !Array.isArray(page.events) ||
      coverage.source !== (runtime ? "provider_runtime_events" : "orchestration_events") ||
      !integer(coverage.highWaterSequence) ||
      typeof coverage.pageHasOlder !== "boolean"
    ) {
      throw new Error(`${name}: missing or invalid page coverage`);
    }
    if (firstCoverage && coverage.highWaterSequence !== firstCoverage.highWaterSequence) {
      throw new Error(`${name}: pagination high-water mark changed`);
    }
    firstCoverage ??= coverage;
    for (const raw of page.events) {
      // Drop content, screenshots, raw provider metadata and arguments before
      // retaining a page; the collector only needs identities and counters.
      const row = measurementRow(record(raw), runtime);
      if (
        !integer(row.sequence) ||
        !text(row.eventId) ||
        !text(row.type) ||
        row.sequence > coverage.highWaterSequence
      ) {
        throw new Error(`${name}: invalid event identity`);
      }
      const eventId = String(row.eventId);
      if (seenEventIds.has(eventId) && seenEventIds.get(eventId) !== row.sequence) {
        throw new Error(`${name}: conflicting event sequence`);
      }
      seenEventIds.set(eventId, row.sequence);
      const prior = seenRows.get(row.sequence);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) {
        throw new Error(`${name}: conflicting duplicate event`);
      }
      seenRows.set(row.sequence, row);
    }
    const next = text(page.nextCursor);
    if (coverage.pageHasOlder !== Boolean(next)) throw new Error(`${name}: incomplete pagination`);
    if (!next)
      return {
        rows: [...seenRows.values()].sort((a, b) => Number(a.sequence) - Number(b.sequence)),
        coverage: firstCoverage,
        pages: pageIndex + 1,
      };
    if (seenCursors.has(next)) throw new Error(`${name}: repeated pagination cursor`);
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error(`${name}: page limit reached before complete coverage`);
}

const runtimePayload = (row: Row): Row => record(record(row.detail).payload);
const toolData = (row: Row): Row => record(runtimePayload(row).data);
const explicitCallId = (row: Row): string | undefined =>
  text(toolData(row).callId) ?? text(toolData(row).toolCallId);
const toolName = (row: Row): string | undefined => {
  const data = toolData(row);
  return text(data.toolName) ?? text(data.tool) ?? text(data.name);
};

interface MeasuredCall {
  callId: string;
  tool: string;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  status?: string | undefined;
}

function collectCalls(rows: Row[], issues: string[]): MeasuredCall[] {
  const lifecycle = rows.filter(
    (row) => row.type === "item.started" || row.type === "item.completed",
  );
  const aliases = new Map<string, string>();
  for (const row of lifecycle) {
    const itemId = text(row.itemId);
    const callId = explicitCallId(row);
    if (!itemId || !callId) continue;
    if (aliases.has(itemId) && aliases.get(itemId) !== callId)
      issues.push("conflicting-call-identity");
    aliases.set(itemId, callId);
  }
  const calls = new Map<string, MeasuredCall>();
  for (const row of lifecycle) {
    const payload = runtimePayload(row);
    const itemType = text(payload.itemType);
    const explicitName = toolName(row);
    if (!itemType || !isToolLifecycleItemType(itemType)) {
      if (explicitName) issues.push("tool-call-unsupported-item-type");
      continue;
    }
    // Native commands, searches and file changes often carry no tool name.
    // Count their canonical identities without retaining command/query text.
    // MCP/dynamic calls require a name to distinguish Computer from other tools.
    const needsName = itemType === "mcp_tool_call" || itemType === "dynamic_tool_call";
    const name = needsName ? explicitName : itemType;
    const itemId = text(row.itemId);
    const callId = explicitCallId(row) ?? (itemId ? (aliases.get(itemId) ?? itemId) : undefined);
    if (!callId || !name) {
      issues.push("tool-call-missing-identity-or-name");
      continue;
    }
    const prior = calls.get(callId);
    if (prior && prior.tool !== name) issues.push("conflicting-call-name");
    const value = prior ?? { callId, tool: name };
    if (row.type === "item.started") value.startedAt ??= text(row.createdAt);
    else {
      value.completedAt = text(row.createdAt);
      value.status = text(payload.status);
    }
    calls.set(callId, value);
  }
  for (const call of calls.values()) {
    if (!call.startedAt || !call.completedAt) issues.push("tool-call-lifecycle-incomplete");
  }
  return [...calls.values()];
}

/** Session totals are explicit in this contract. Latest-request counters are
 * deliberately not summed or treated as totals when a provider omits it. */
function cumulativeUsage(row: Row): Row | undefined {
  const usage = record(runtimePayload(row).usage);
  const totals = record(usage.cumulativeUsage);
  return integer(totals.inputTokens) && integer(totals.outputTokens) ? totals : undefined;
}

function measureUsage(rows: Row[], firstStartSequence: number, issues: string[]) {
  const snapshots = rows.filter((row) => row.type === "thread.token-usage.updated");
  const final = snapshots.at(-1);
  const totals = final ? cumulativeUsage(final) : undefined;
  if (!totals) {
    issues.push("cumulative-usage-missing-or-redacted");
    return null;
  }
  if (Number(final?.sequence) < firstStartSequence) issues.push("turn-usage-not-observed");
  const before = snapshots.filter((row) => Number(row.sequence) < firstStartSequence).at(-1);
  const baseline = before ? cumulativeUsage(before) : undefined;
  if (before && !baseline) issues.push("usage-baseline-missing-or-redacted");
  const previous: Row = { ...baseline };
  for (const row of snapshots.filter((value) => Number(value.sequence) >= firstStartSequence)) {
    const next = cumulativeUsage(row);
    if (!next) {
      issues.push("cumulative-usage-missing-or-redacted");
      continue;
    }
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "cacheCreationInputTokens",
    ]) {
      if (!integer(next[key])) continue;
      if (integer(previous[key]) && next[key] < previous[key]) issues.push("usage-counter-reset");
      // Retain an optional counter across a snapshot that omits it, so a
      // later decrease cannot disappear behind an unknown intermediate value.
      previous[key] = next[key];
    }
  }
  const delta = (key: string): number | null => {
    if (!integer(totals[key])) return null;
    if (baseline && !integer(baseline[key])) return null;
    const amount = Number(totals[key]) - Number(baseline?.[key] ?? 0);
    if (amount < 0) {
      issues.push("usage-counter-reset");
      return null;
    }
    return amount;
  };
  const inputTokens = delta("inputTokens");
  const cachedInputTokens = delta("cachedInputTokens");
  if (cachedInputTokens === null) issues.push("cache-usage-unavailable");
  if (inputTokens !== null && cachedInputTokens !== null && cachedInputTokens > inputTokens) {
    issues.push("cache-usage-exceeds-input");
  }
  return {
    basis: baseline ? "cumulative-delta" : "fresh-thread-cumulative",
    inputTokens,
    cachedInputTokens,
    uncachedInputTokens:
      inputTokens !== null && cachedInputTokens !== null && cachedInputTokens <= inputTokens
        ? inputTokens - cachedInputTokens
        : null,
    outputTokens: delta("outputTokens"),
    cacheCreationInputTokens: delta("cacheCreationInputTokens"),
  };
}

function summarizeAudit(scope: ComputerRunScope, calls: MeasuredCall[]) {
  if (!scope.auditEntries) return null;
  if (scope.auditEntries.length > 10_000) throw new Error("Audit exceeds measurement entry limit");
  const byTool: Record<string, number> = Object.create(null);
  const byEffect: Record<string, number> = Object.create(null);
  const refusalsByCode: Record<string, number> = Object.create(null);
  let missingTurnId = 0;
  for (const raw of scope.auditEntries) {
    const entry = record(raw);
    if (entry.threadId !== scope.threadId) continue;
    if (!entry.turnId) {
      missingTurnId++;
      continue;
    }
    if (entry.turnId !== scope.turnId || !text(entry.tool) || !text(entry.effect)) continue;
    const tool = String(entry.tool);
    const effect = String(entry.effect);
    byTool[tool] = (byTool[tool] ?? 0) + 1;
    byEffect[effect] = (byEffect[effect] ?? 0) + 1;
    if (text(entry.code))
      refusalsByCode[String(entry.code)] = (refusalsByCode[String(entry.code)] ?? 0) + 1;
  }
  return {
    basis: "mutation-only; no call IDs; counts are a cross-check, not proof of delivery",
    byTool,
    byEffect,
    refusalsByCode,
    missingTurnId,
    excessByTool: Object.fromEntries(
      Object.entries(byTool).flatMap(([name, count]) => {
        const observed = calls.filter(
          (call) => call.tool === name || call.tool.endsWith(`__${name}`),
        ).length;
        return count > observed ? [[name, count - observed]] : [];
      }),
    ),
  };
}

/** Verify the actual diagnostic route before dispatching a paid turn. Runtime
 * retention is always on; optional NDJSON logging is not required or enabled.
 * Empty runtime coverage is expected only here, on a newly created idle thread. */
export async function prepareComputerRunDiagnostics(
  call: DiagnosticToolCaller,
  scope: Pick<ComputerRunScope, "threadId" | "runStartedAt">,
) {
  const startedAt = timestamp(scope.runStartedAt);
  if (!scope.threadId || !Number.isFinite(startedAt))
    throw new Error("Invalid diagnostic preparation scope");
  const journal = await collectPages(
    call,
    "synara_read_thread_events",
    {
      threadId: scope.threadId,
      eventTypes: ["thread.created", "thread.turn-start-requested"],
      payloadMode: "none",
    },
    2,
  );
  if (
    journal.coverage.durableSourceComplete !== true ||
    journal.rows.length !== 1 ||
    journal.rows[0]?.type !== "thread.created" ||
    timestamp(journal.rows[0].occurredAt) < startedAt ||
    !Number.isFinite(timestamp(journal.rows[0].occurredAt))
  )
    throw new Error("Diagnostic preparation requires an observed fresh, undispatched thread");
  const runtime = await collectPages(
    call,
    "synara_read_thread_runtime_events",
    { threadId: scope.threadId, includeDetails: true },
    2,
  );
  if (
    runtime.rows.length !== 0 ||
    runtime.coverage.highWaterSequence !== 0 ||
    runtime.coverage.oldestRetainedSequence !== null ||
    runtime.coverage.retainedForThread !== 0
  )
    throw new Error("Diagnostic preparation found prior or unverifiable provider runtime state");
  return {
    ready: true,
    threadId: scope.threadId,
    basis: "fresh-idle-thread-diagnostic-route; execution-and-usage-still-unverified",
    journal: journal.coverage,
    runtime: runtime.coverage,
  };
}

export async function collectComputerRun(call: DiagnosticToolCaller, scope: ComputerRunScope) {
  const runStart = timestamp(scope.runStartedAt);
  const maxPages = scope.maxPages ?? 80;
  if (
    !scope.threadId ||
    !scope.turnId ||
    !Number.isFinite(runStart) ||
    !integer(maxPages) ||
    maxPages < 1 ||
    maxPages > 200
  )
    throw new Error("Invalid measurement scope");
  const journal = await collectPages(
    call,
    "synara_read_thread_events",
    {
      threadId: scope.threadId,
      eventTypes: [
        "thread.created",
        "thread.turn-start-requested",
        "thread.turn-interrupt-requested",
      ],
      payloadMode: "summary",
    },
    maxPages,
  );
  // Fetch the whole fresh thread, including pre-turn cumulative usage. Runtime
  // usage events may legitimately omit turnId; never drop their baseline.
  const runtime = await collectPages(
    call,
    "synara_read_thread_runtime_events",
    {
      threadId: scope.threadId,
      eventTypes: [
        "session.started",
        "turn.started",
        "turn.completed",
        "turn.aborted",
        "item.started",
        "item.completed",
        "thread.token-usage.updated",
      ],
      includeDetails: true,
    },
    maxPages,
  );
  const issues: string[] = [];
  const created = journal.rows.filter((row) => row.type === "thread.created");
  const dispatches = journal.rows.filter((row) => row.type === "thread.turn-start-requested");
  const fresh =
    journal.coverage.durableSourceComplete === true &&
    created.length === 1 &&
    dispatches.length === 1 &&
    timestamp(created[0]!.occurredAt) >= runStart &&
    timestamp(dispatches[0]!.occurredAt) >= timestamp(created[0]!.occurredAt);
  if (!fresh) issues.push("fresh-thread-unproven");
  if (journal.rows.some((row) => row.type === "thread.turn-interrupt-requested"))
    issues.push("turn-interrupted");
  const starts = runtime.rows.filter(
    (row) => row.type === "turn.started" && row.turnId === scope.turnId,
  );
  const terminal = runtime.rows
    .filter(
      (row) =>
        (row.type === "turn.completed" || row.type === "turn.aborted") &&
        row.turnId === scope.turnId,
    )
    .at(-1);
  const firstStart = starts[0];
  if (
    !firstStart ||
    !terminal ||
    runtimePayload(terminal).state !== "completed" ||
    Number(firstStart.sequence) >= Number(terminal.sequence)
  )
    issues.push("completed-turn-coverage-unproven");
  if (runtime.rows.some((row) => text(row.turnId) && row.turnId !== scope.turnId))
    issues.push("other-turn-in-fresh-thread");
  if (
    !integer(runtime.coverage.oldestRetainedSequence) ||
    !firstStart ||
    Number(runtime.coverage.oldestRetainedSequence) > Number(firstStart.sequence)
  )
    issues.push("runtime-retention-gap");
  if (
    !runtime.rows.some(
      (row) =>
        row.type === "session.started" && Number(row.sequence) < Number(firstStart?.sequence),
    )
  )
    issues.push("session-start-coverage-unproven");
  const turnRows = runtime.rows.filter((row) => row.turnId === scope.turnId);
  const calls = collectCalls(turnRows, issues);
  const computerCalls = calls.filter((call) => /computer_[a-z_]+$/.test(call.tool));
  if (computerCalls.length === 0) issues.push("no-computer-calls-observed");
  const usage = measureUsage(runtime.rows, Number(firstStart?.sequence), issues);
  const wallClockMs =
    terminal && dispatches[0]
      ? timestamp(terminal.createdAt) - timestamp(dispatches[0].occurredAt)
      : NaN;
  if (!Number.isFinite(wallClockMs) || wallClockMs < 0) issues.push("invalid-run-timestamps");
  const countByName: Record<string, number> = {};
  for (const value of computerCalls) countByName[value.tool] = (countByName[value.tool] ?? 0) + 1;
  return {
    valid: issues.length === 0,
    issues: [...new Set(issues)],
    threadId: scope.threadId,
    turnId: scope.turnId,
    threadFresh: fresh,
    wallClockMs: Number.isFinite(wallClockMs) ? wallClockMs : null,
    wallClockBasis: "turn-dispatch-to-provider-completion",
    toolCalls: { total: calls.length, computer: computerCalls.length, byName: countByName },
    calls,
    usage,
    audit: summarizeAudit(scope, calls),
    coverage: {
      journal: journal.coverage,
      runtime: runtime.coverage,
      journalPages: journal.pages,
      runtimePages: runtime.pages,
    },
    // The audit is a mutation-only source with no call IDs. Do not turn its
    // length into a tool count or infer focus/Escape proof from missing rows.
    acceptance: {
      taskOutcome: "unverified",
      focus: "unverified",
      escapeInterruptions: "unverified",
    },
  };
}
