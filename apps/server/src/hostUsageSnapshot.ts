// Product-consent host execution snapshots, frozen once per completed UTC day.
// Reuses the former Beta turn grouping; health diagnostics remain a separate owner.
import {
  HOST_USAGE_MAX_COUNTER,
  HOST_USAGE_MAX_ROWS,
  HOST_USAGE_MAX_TURNS,
  HOST_USAGE_RECEIPT_DAYS,
  type HostUsageRow,
  type HostUsageSnapshot,
} from "@synara/contracts/hostUsage";
import {
  HOST_USAGE_DAY_MS,
  HOST_USAGE_DIRECTORY,
  HOST_USAGE_POLICY_FILE,
  HOST_USAGE_RECEIPTS_FILE,
  HOST_USAGE_SETTLE_MS,
} from "@synara/shared/hostUsage";
import { usageTurnCategories } from "@synara/shared/usageAnalytics";
import { Effect, FileSystem, Path } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { writeFileStringAtomically } from "./atomicWrite";

interface TurnRow {
  state: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
  interactionMode: string | null;
  runtimeMode: string | null;
  origin: string | null;
  durationMs: number | null;
  usage: string | null;
}
const OUTCOMES = { completed: "succeeded", error: "failed", interrupted: "cancelled" } as const;
const TOKEN_FIELDS = [
  ["inputTokens", "inputSamples", "inputTokens"],
  ["outputTokens", "outputSamples", "outputTokens"],
  ["cachedInputTokens", "cachedInputSamples", "cacheReadInputTokens"],
] as const;
const validCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= HOST_USAGE_MAX_COUNTER;

/** A field is measured only when every entry provides it; an explicit zero remains measured. */
function tokenMeasurements(raw: string | null) {
  const result: {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    truncated: boolean;
  } = { inputTokens: null, outputTokens: null, cachedInputTokens: null, truncated: false };
  if (!raw) return result;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result;
    const entries = Object.values(parsed);
    if (entries.length > 64) return { ...result, truncated: true };
    if (entries.length === 0) return result;
    for (const [field, , key] of TOKEN_FIELDS) {
      let sum = 0;
      let measured = true;
      for (const entry of entries) {
        const value =
          entry && typeof entry === "object" && !Array.isArray(entry)
            ? (entry as Record<string, unknown>)[key]
            : undefined;
        if (!validCount(value) || !validCount(sum + value)) {
          measured = false;
          break;
        }
        sum += value;
      }
      if (measured) result[field] = sum;
    }
  } catch {
    /* Missing/corrupt usage never becomes a measured zero. */
  }
  return result;
}

/** Bounded, finite grouping with independent token denominators and explicit truncation. */
function aggregateTurns(turns: readonly TurnRow[]) {
  const groups = new Map<string, { row: HostUsageRow; overflow: Set<string> }>();
  let tokenTruncatedTurns = 0;
  let cappedMeasurements = 0;
  for (const turn of turns) {
    const outcome = OUTCOMES[turn.state as keyof typeof OUTCOMES];
    if (!outcome) continue;
    const dimensions = { ...usageTurnCategories(turn), outcome };
    const key = Object.values(dimensions).join("|");
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= HOST_USAGE_MAX_ROWS) continue;
      group = {
        row: {
          ...dimensions,
          turns: 0,
          durationMs: 0,
          durationSamples: 0,
          inputTokens: 0,
          inputSamples: 0,
          outputTokens: 0,
          outputSamples: 0,
          cachedInputTokens: 0,
          cachedInputSamples: 0,
        },
        overflow: new Set(),
      };
      groups.set(key, group);
    }
    const row = group.row as { -readonly [Key in keyof HostUsageRow]: HostUsageRow[Key] };
    row.turns += 1;
    const add = (
      field: "durationMs" | "inputTokens" | "outputTokens" | "cachedInputTokens",
      samples: "durationSamples" | "inputSamples" | "outputSamples" | "cachedInputSamples",
      value: number | null,
    ) => {
      if (value === null || !validCount(value) || group!.overflow.has(field)) return;
      if (!validCount(row[field] + value)) {
        row[field] = 0;
        row[samples] = 0;
        group!.overflow.add(field);
        cappedMeasurements += 1;
      } else {
        row[field] += value;
        row[samples] += 1;
      }
    };
    add(
      "durationMs",
      "durationSamples",
      turn.durationMs === null ? null : Math.round(turn.durationMs),
    );
    const tokens = tokenMeasurements(turn.usage);
    if (tokens.truncated) tokenTruncatedTurns += 1;
    for (const [field, samples] of TOKEN_FIELDS) add(field, samples, tokens[field]);
  }
  const rows = [...groups.values()].map(({ row }) => row);
  return {
    rows,
    includedTurns: rows.reduce((n, row) => n + row.turns, 0),
    tokenTruncatedTurns,
    cappedMeasurements,
  };
}

/** Generates only unsent, completed days in the current local consent generation. */
export const writeHostUsageSnapshots = (homeDir: string, now = Date.now()) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = path.join(homeDir, "product-analytics");
    const readJson = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.flatMap((text) =>
          Effect.try({
            try: () => JSON.parse(text) as Record<string, unknown>,
            catch: (cause) => cause,
          }),
        ),
        Effect.catch(() => Effect.succeed(null)),
      );
    const policy = yield* readJson(path.join(root, HOST_USAGE_POLICY_FILE));
    if (
      !policy ||
      policy.enabled !== true ||
      typeof policy.policyId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(policy.policyId) ||
      typeof policy.since !== "string" ||
      !Number.isFinite(Date.parse(policy.since))
    )
      return;
    const sinceIso = policy.since;
    const since = Date.parse(sinceIso);
    if (since > now) return;
    const consentPath = path.join(root, "consent.json");
    const hasCurrentConsent = Effect.gen(function* () {
      const current = yield* readJson(path.join(root, HOST_USAGE_POLICY_FILE));
      if (current?.policyId !== policy.policyId || current?.enabled !== true) return false;
      // A failed policy unlink must not override a separately persisted opt-out.
      if (yield* fs.exists(consentPath)) {
        const consent = yield* readJson(consentPath);
        if (consent?.enabled !== true) return false;
      }
      return true;
    });
    if (!(yield* hasCurrentConsent)) return;
    const spool = path.join(root, HOST_USAGE_DIRECTORY);
    const files = yield* fs
      .readDirectory(spool)
      .pipe(Effect.catch(() => Effect.succeed([] as string[])));
    for (const name of files) {
      const match = /^([0-9a-f-]{36})-(\d{4}-\d\d-\d\d)\.json$/.exec(name);
      if (
        match &&
        (match[1] !== policy.policyId ||
          Date.parse(`${match[2]}T00:00:00.000Z`) + HOST_USAGE_DAY_MS <
            now - HOST_USAGE_RECEIPT_DAYS * HOST_USAGE_DAY_MS)
      )
        yield* fs.remove(path.join(spool, name), { force: true });
    }
    const receipts = yield* readJson(path.join(root, HOST_USAGE_RECEIPTS_FILE));
    const delivered =
      receipts?.policyId === policy.policyId && Array.isArray(receipts.days)
        ? new Set(receipts.days)
        : new Set();
    const sql = yield* SqlClient.SqlClient;
    const first = Math.max(
      Math.floor(since / HOST_USAGE_DAY_MS) * HOST_USAGE_DAY_MS,
      Math.floor((now - HOST_USAGE_RECEIPT_DAYS * HOST_USAGE_DAY_MS) / HOST_USAGE_DAY_MS) *
        HOST_USAGE_DAY_MS,
    );
    for (
      let start = first;
      start + HOST_USAGE_DAY_MS + HOST_USAGE_SETTLE_MS <= now;
      start += HOST_USAGE_DAY_MS
    ) {
      const windowStart = new Date(start).toISOString();
      const windowEnd = new Date(start + HOST_USAGE_DAY_MS).toISOString();
      const day = windowStart.slice(0, 10);
      const file = path.join(root, HOST_USAGE_DIRECTORY, `${policy.policyId}-${day}.json`);
      if (delivered.has(day) || (yield* fs.exists(file))) continue;
      const coveredFrom = new Date(Math.max(start, since)).toISOString();
      // Counts and sampled rows share one read transaction; projection writes cannot split their view.
      const [counts, turns] = yield* sql.withTransaction(
        Effect.gen(function* () {
          const counts = yield* sql<{ eligible: number; missing: number }>`SELECT
      SUM(CASE WHEN julianday(completed_at) >= julianday(${windowStart}) AND julianday(completed_at) < julianday(${windowEnd}) THEN 1 ELSE 0 END) AS eligible,
      SUM(CASE WHEN julianday(completed_at) IS NULL AND julianday(requested_at) >= julianday(${windowStart}) AND julianday(requested_at) < julianday(${windowEnd}) THEN 1 ELSE 0 END) AS missing
      FROM projection_turns WHERE state IN ('completed', 'error', 'interrupted') AND julianday(requested_at) >= julianday(${sinceIso})`;
          const turns = yield* sql<TurnRow>`SELECT t.state,
      json_extract(e.payload_json, '$.modelSelection.provider') AS provider,
      json_extract(e.payload_json, '$.modelSelection.model') AS model,
      COALESCE(json_extract(e.payload_json, '$.modelSelection.options.effort'),
        json_extract(e.payload_json, '$.modelSelection.options.reasoningEffort'),
        json_extract(e.payload_json, '$.modelSelection.options.thinkingLevel'),
        json_extract(e.payload_json, '$.modelSelection.options.variant')) AS effort,
      json_extract(e.payload_json, '$.interactionMode') AS interactionMode,
      json_extract(e.payload_json, '$.runtimeMode') AS runtimeMode,
      json_extract(e.payload_json, '$.dispatchOrigin') AS origin,
      CASE WHEN t.started_at IS NOT NULL THEN (julianday(t.completed_at) - julianday(t.started_at)) * 86400000 END AS durationMs,
      (SELECT json_extract(a.payload_json, '$.modelUsage') FROM projection_thread_activities a
       WHERE a.kind = 'turn.completed' AND a.thread_id = t.thread_id AND a.turn_id = t.turn_id
       ORDER BY a.created_at DESC, a.activity_id DESC LIMIT 1) AS usage
      FROM projection_turns t LEFT JOIN orchestration_events e ON e.event_id = (
        SELECT r.event_id FROM orchestration_events r WHERE r.event_type = 'thread.turn-start-requested'
          AND r.stream_id = t.thread_id AND json_extract(r.payload_json, '$.messageId') = t.pending_message_id
        ORDER BY r.stream_version DESC LIMIT 1)
      WHERE t.state IN ('completed', 'error', 'interrupted') AND julianday(t.requested_at) >= julianday(${sinceIso})
        AND julianday(t.completed_at) >= julianday(${windowStart}) AND julianday(t.completed_at) < julianday(${windowEnd})
      ORDER BY julianday(t.completed_at), t.thread_id, t.turn_id LIMIT ${HOST_USAGE_MAX_TURNS}`;
          return [counts, turns] as const;
        }),
      );
      const snapshot: HostUsageSnapshot = {
        v: 1,
        policyId: policy.policyId,
        windowStart,
        windowEnd,
        coveredFrom,
        generatedAt: new Date(now).toISOString(),
        eligibleTurns: Number(counts[0]?.eligible ?? 0),
        missingCompletionTimes: Number(counts[0]?.missing ?? 0),
        ...aggregateTurns(turns),
      };
      // An opt-out may occur while SQLite is read; stale generations cannot publish a current spool.
      if (!(yield* hasCurrentConsent)) return;
      yield* writeFileStringAtomically({
        filePath: file,
        contents: `${JSON.stringify(snapshot)}\n`,
      });
      // Opt-out can also clear the spool during the atomic write; remove only this generation.
      if (!(yield* hasCurrentConsent)) {
        yield* fs.remove(file, { force: true });
        return;
      }
    }
  });

/** A missing/disabled policy does no projection work, including on Stable and CLI hosts. */
export const startHostUsageSnapshotJob = (homeDir: string) =>
  Effect.gen(function* () {
    while (true) {
      yield* writeHostUsageSnapshots(homeDir).pipe(
        Effect.catch(() => Effect.logWarning("host usage snapshot unavailable")),
      );
      yield* Effect.sleep(60_000);
    }
  }).pipe(Effect.forkScoped);
