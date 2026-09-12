import { createHash, randomUUID } from "node:crypto";

import {
  MIND_MEMORY_PROJECT_CAP,
  MIND_MEMORY_TEXT_MAX_CHARS,
  MIND_RECALL_CANDIDATE_MAX_ITEMS,
  MIND_RECALL_HYGIENE_NOTE,
  MIND_RECALL_MAX_DIGEST_CHARS,
  MIND_RECALL_MAX_ITEMS,
  MIND_RECALL_QUERY_MAX_CHARS,
  MindMemoryId,
  type MindListResult,
  type MindMemory,
  type MindRecallItem,
  type MindRecallResult,
  type ProjectId,
} from "@synara/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { Clock, Effect, Layer, Option } from "effect";

import {
  buildMindFtsMatchExpr,
  MIND_RECEIPT_PRUNE_MAX_ITEMS,
  MindRepository,
  type MindMemoryCandidate,
  type MindMemoryRow,
} from "../../persistence/Services/MindRepository.ts";
import {
  MindInvalidTextError,
  MindMemoryNotFoundError,
  MindProjectCapReachedError,
  MindSecretRejectedError,
} from "../Errors.ts";
import { isMindSecret } from "../secretPatterns.ts";
import {
  INITIAL_WEIGHT,
  confirmedWeight,
  effectiveWeight,
  rankCandidates,
  shouldPrune,
} from "../scoring.ts";
import {
  MindService,
  type MindAffirmRequest,
  type MindConfirmRequest,
  type MindForgetRequest,
  type MindForgetResult,
  type MindListRequest,
  type MindRememberRequest,
  type MindRememberResult,
  type MindRecallRequest,
  type MindServiceError,
  type MindServiceShape,
  type MindSetPinnedRequest,
  type MindStatusRequest,
  type MindStatusResult,
} from "../Services/MindService.ts";

const DAY_MS = 86_400_000;
/** Lazy prune sweep cadence: at most once per 24h per project (plan 05 §6.2). */
const PRUNE_SWEEP_INTERVAL_MS = DAY_MS;
/** Per-run bound: one sweep deletes at most 100 memories; the rest resume next interval. */
const SWEEP_MAX_DELETES = 100;
/** Operation receipts younger than this are always kept; older ones need a proving journal row. */
const RECEIPT_RETENTION_MS = 30 * DAY_MS;
/** Query-recall default matches the contracts' 8-item result cap. */
const RECALL_DEFAULT_LIMIT = 8;
/** Digest line format mirrors mind's ACTIVE.md hot-memories list. */
const roundTo = (value: number, decimals: number) => Number(value.toFixed(decimals));

const normalizeMindText = (text: string): string => text.trim();
const hashMindText = (normalized: string): string =>
  createHash("sha256").update(normalized).digest("hex");

/**
 * `<` never survives into rendered digest text (it becomes the literal six
 * characters `\u003c`), so stored memories can neither terminate nor forge a
 * `<synara_memories>`/host-context block (plan 05 §6.5).
 */
const escapeDigestText = (text: string): string => text.replace(/</g, "\\u003c");

const renderDigestLine = (item: MindRecallItem): string =>
  `- [${item.type}] ${escapeDigestText(item.text)}`;

/** Renders whole lines only, stopping before the digest char cap would be exceeded. */
const renderDigest = (items: ReadonlyArray<MindRecallItem>): string => {
  const lines: string[] = [];
  for (const item of items) {
    const line = renderDigestLine(item);
    const candidate = lines.length === 0 ? line : `${lines.join("\n")}\n${line}`;
    if (candidate.length > MIND_RECALL_MAX_DIGEST_CHARS) break;
    lines.push(line);
  }
  return lines.join("\n");
};

const toRecallItem = (row: MindMemoryRow, weight: number, nowIso: string): MindRecallItem => ({
  memoryId: row.memoryId,
  type: row.type,
  text: row.text,
  weight: roundTo(weight, 4),
  ageDays: roundTo(Math.max(0, (Date.parse(nowIso) - Date.parse(row.createdAt)) / DAY_MS), 2),
});

const toMindMemory = (row: MindMemoryRow, nowIso: string): MindMemory => ({
  memoryId: row.memoryId,
  projectId: row.projectId,
  text: row.text,
  type: row.type,
  weight: roundTo(effectiveWeight(row, nowIso), 4),
  accessCount: row.accessCount,
  pinned: row.pinned,
  createdAt: row.createdAt,
  lastAccessedAt: row.lastAccessedAt,
  provenance: row.provenance,
});

const idleDaysOf = (row: MindMemoryRow, nowIso: string): number =>
  Math.max(0, (Date.parse(nowIso) - Date.parse(row.lastAccessedAt)) / DAY_MS);

/** Top memories by effective weight (deterministic id tie-break) — the digest source. */
const topDigestRows = (
  rows: ReadonlyArray<MindMemoryRow>,
  nowIso: string,
): ReadonlyArray<{ readonly row: MindMemoryRow; readonly weight: number }> =>
  rows
    .map((row) => ({ row, weight: effectiveWeight(row, nowIso) }))
    .toSorted((a, b) => b.weight - a.weight || a.row.memoryId.localeCompare(b.row.memoryId))
    .slice(0, MIND_RECALL_MAX_ITEMS);

const decodeRememberReceipt = (resultJson: string): MindRememberResult | undefined => {
  try {
    const parsed: unknown = JSON.parse(resultJson);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      if (
        typeof record.memoryId === "string" &&
        typeof record.created === "boolean" &&
        typeof record.reinforced === "boolean"
      ) {
        return {
          memoryId: MindMemoryId.makeUnsafe(record.memoryId),
          created: record.created,
          reinforced: record.reinforced,
          replayed: true,
        };
      }
    }
  } catch {
    // A malformed receipt falls through to the live path; the journal lookup still guards.
  }
  return undefined;
};

const makeMindService = Effect.gen(function* () {
  const repository = yield* MindRepository;
  const sqlClient = yield* SqlClient.SqlClient;

  // In-memory sweep schedule (plan 05 §6.2 decision): the cadence is process-local
  // hygiene timing, while operation idempotency stays durable in receipts + journal.
  const lastSweepAtByProject = new Map<string, number>();

  const nowIsoNow = Effect.map(Clock.currentTimeMillis, (millis) => new Date(millis).toISOString());

  /**
   * Runs the prune sweep at most once per 24h per project, on the first memory
   * operation after the interval. Deletes prune-eligible rows (journaling
   * op:'prune' per id), capped at SWEEP_MAX_DELETES per run so one sweep never
   * holds the writer long — the remainder resumes on the next interval (and a
   * restart simply re-arms the in-memory clock and sweeps again sooner).
   * Pinned rows are exempt via shouldPrune. Also GCs operation receipts older
   * than 30d when a journal row proves the op, so retries still replay.
   * Callers run this OUTSIDE any mutation transaction; it commits on its own.
   */
  const maybeSweep = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      const lastSweepAt = lastSweepAtByProject.get(projectId);
      if (lastSweepAt !== undefined && nowMillis - lastSweepAt < PRUNE_SWEEP_INTERVAL_MS) {
        return;
      }
      lastSweepAtByProject.set(projectId, nowMillis);
      const nowIso = new Date(nowMillis).toISOString();
      const rows = yield* repository.listByProject({ projectId });
      const pruneIds = rows
        .filter((row) => shouldPrune(row, nowIso))
        .map((row) => row.memoryId)
        .slice(0, SWEEP_MAX_DELETES);
      let pruned = 0;
      for (const memoryId of pruneIds) {
        const deleted = yield* repository.deleteById({ memoryId });
        if (deleted) {
          pruned += 1;
          yield* repository.appendJournal({
            projectId,
            memoryId,
            op: "prune",
            // Prune is system hygiene, not an agent or user action.
            actor: { kind: "user" },
            threadId: null,
            turnId: null,
            createdAt: nowIso,
          });
        }
      }
      const receiptsPruned = yield* repository.pruneReceipts({
        projectId,
        olderThanIso: new Date(nowMillis - RECEIPT_RETENTION_MS).toISOString(),
        limit: MIND_RECEIPT_PRUNE_MAX_ITEMS,
      });
      if (pruned > 0 || receiptsPruned > 0) {
        yield* Effect.logInfo("Mind hygiene sweep pruned rows.", {
          projectId,
          prunedMemories: pruned,
          prunedReceipts: receiptsPruned,
        });
      }
    });

  // The remember mutation serialized in its own transaction (check-then-act:
  // receipt lookup, text-hash dedupe, cap count, insert) so concurrent retries
  // and saves stay race-free: one reinforcement, one cap check, one row. The
  // hygiene sweep runs before this, never inside it — see `remember`.
  const rememberInTransaction = (
    input: MindRememberRequest,
  ): Effect.Effect<MindRememberResult, MindServiceError> =>
    sqlClient
      .withTransaction(
        Effect.gen(function* () {
          const normalized = normalizeMindText(input.text);
          if (normalized.length === 0) {
            return yield* Effect.fail(
              new MindInvalidTextError({
                reason: "empty",
                message: "Memory text is empty after trimming; save a non-empty declarative fact.",
              }),
            );
          }
          if (normalized.length > MIND_MEMORY_TEXT_MAX_CHARS) {
            return yield* Effect.fail(
              new MindInvalidTextError({
                reason: "tooLong",
                message: `Memory text is ${normalized.length} characters after trimming; keep it at ${MIND_MEMORY_TEXT_MAX_CHARS} or fewer.`,
              }),
            );
          }
          if (isMindSecret(normalized)) {
            return yield* Effect.fail(
              new MindSecretRejectedError({
                message:
                  "Memory text matches a credential or secret pattern and was rejected; keep secrets in a secret store, never in project memory.",
              }),
            );
          }

          // The sweep already ran outside this transaction (see above), so the
          // cap count below sees the freed slots without holding them in-transaction.
          const nowMillis = yield* Clock.currentTimeMillis;
          const nowIso = new Date(nowMillis).toISOString();
          const textHash = hashMindText(normalized);
          const operationId = input.turnId === null ? null : `remember:${input.turnId}:${textHash}`;

          if (operationId !== null) {
            const receipt = yield* repository.getReceipt({
              projectId: input.projectId,
              operationId,
            });
            if (Option.isSome(receipt)) {
              const replayed = decodeRememberReceipt(receipt.value.resultJson);
              if (replayed !== undefined) return replayed;
            }
          }

          const existing = yield* repository.findByTextHash({
            projectId: input.projectId,
            textHash,
          });
          if (Option.isSome(existing)) {
            const row = existing.value;
            if (operationId !== null) {
              const journaled = yield* repository.findJournalOp({
                memoryId: row.memoryId,
                op: "remember",
                turnId: input.turnId,
              });
              if (Option.isSome(journaled)) {
                // Crash-recovery replay: the receipt is missing but the journal proves
                // this turn already remembered this text. The row was created by this
                // turn exactly when its creation instant equals the journal instant.
                const createdThisTurn = row.createdAt === journaled.value.createdAt;
                return {
                  memoryId: row.memoryId,
                  created: createdThisTurn,
                  reinforced: !createdThisTurn,
                  replayed: true,
                };
              }
            }
            // Reinforce-as-confirm: same (project, text hash) never becomes a second row.
            const updated = yield* repository.applyConfirm({
              memoryId: row.memoryId,
              peakWeight: confirmedWeight(row.peakWeight),
              lastAccessedAt: nowIso,
            });
            if (Option.isNone(updated)) {
              return yield* Effect.fail(
                new MindMemoryNotFoundError({
                  memoryId: row.memoryId,
                  message: "The matching memory disappeared while reinforcing; retry the remember.",
                }),
              );
            }
            const result: MindRememberResult = {
              memoryId: row.memoryId,
              created: false,
              reinforced: true,
              replayed: false,
            };
            yield* repository.appendJournal({
              projectId: input.projectId,
              memoryId: row.memoryId,
              op: "remember",
              actor: input.actor,
              threadId: input.threadId,
              turnId: input.turnId,
              createdAt: nowIso,
            });
            if (operationId !== null) {
              yield* repository.putReceipt({
                projectId: input.projectId,
                operationId,
                op: "remember",
                resultJson: JSON.stringify({
                  memoryId: result.memoryId,
                  created: false,
                  reinforced: true,
                }),
                createdAt: nowIso,
              });
            }
            return result;
          }

          const count = yield* repository.countByProject({ projectId: input.projectId });
          if (count >= MIND_MEMORY_PROJECT_CAP) {
            return yield* Effect.fail(
              new MindProjectCapReachedError({
                projectId: input.projectId,
                count,
                cap: MIND_MEMORY_PROJECT_CAP,
                message: `Project memory is at the ${MIND_MEMORY_PROJECT_CAP}-memory cap; forget or consolidate memories before adding new ones.`,
              }),
            );
          }
          const inserted = yield* repository.insert({
            memoryId: MindMemoryId.makeUnsafe(randomUUID()),
            projectId: input.projectId,
            text: normalized,
            type: input.type,
            textHash,
            peakWeight: INITIAL_WEIGHT,
            accessCount: 0,
            pinned: false,
            createdAt: nowIso,
            lastAccessedAt: nowIso,
            provenance:
              input.actor.kind === "agent" && input.threadId !== null
                ? { kind: "agent", threadId: input.threadId, provider: input.actor.provider }
                : { kind: "user" },
          });
          const result: MindRememberResult = {
            memoryId: inserted.memoryId,
            created: true,
            reinforced: false,
            replayed: false,
          };
          yield* repository.appendJournal({
            projectId: input.projectId,
            memoryId: inserted.memoryId,
            op: "remember",
            actor: input.actor,
            threadId: input.threadId,
            turnId: input.turnId,
            createdAt: nowIso,
          });
          if (operationId !== null) {
            yield* repository.putReceipt({
              projectId: input.projectId,
              operationId,
              op: "remember",
              resultJson: JSON.stringify({
                memoryId: inserted.memoryId,
                created: true,
                reinforced: false,
              }),
              createdAt: nowIso,
            });
          }
          return result;
        }),
      )
      .pipe(
        Effect.catchIf(
          (error): error is SqlError => error._tag === "SqlError",
          (error) => Effect.fail(toPersistenceSqlError("MindService.remember:transaction")(error)),
        ),
      );

  // Hygiene runs BEFORE the mutation transaction, never inside it: pruned
  // rows free cap slots for the cap check, and the bounded sweep never holds
  // the write transaction open. Both halves are lazy effect descriptions, so
  // `andThen` runs the sweep strictly before the transaction runs.
  const remember = (
    input: MindRememberRequest,
  ): Effect.Effect<MindRememberResult, MindServiceError> =>
    Effect.andThen(maybeSweep(input.projectId), rememberInTransaction(input));

  const recall = (input: MindRecallRequest): Effect.Effect<MindRecallResult, MindServiceError> =>
    Effect.gen(function* () {
      const nowIso = yield* nowIsoNow;
      const query = input.query ?? "";
      const limit = Math.min(
        Math.max(1, input.limit ?? RECALL_DEFAULT_LIMIT),
        MIND_RECALL_MAX_ITEMS,
      );
      if (query.trim().length === 0) {
        const rows = yield* repository.listByProject({ projectId: input.projectId });
        const digestItems = topDigestRows(rows, nowIso).map(({ row, weight }) =>
          toRecallItem(row, weight, nowIso),
        );
        return {
          digest: renderDigest(digestItems),
          items: digestItems,
          note: MIND_RECALL_HYGIENE_NOTE,
        };
      }
      const candidates = yield* repository
        .searchCandidates({
          projectId: input.projectId,
          matchExpr: buildMindFtsMatchExpr(query.slice(0, MIND_RECALL_QUERY_MAX_CHARS)),
          limit: MIND_RECALL_CANDIDATE_MAX_ITEMS,
        })
        .pipe(
          // Recall stays a pure read that never throws on query-shaped FTS
          // failures (tokenizer edges on exotic input): best-effort, no
          // matches. Decode-level corruption is already skipped row-wise by
          // the repository, so only SQL failures can land here.
          Effect.catchTag("PersistenceSqlError", (error) =>
            Effect.logWarning("Mind recall FTS search failed; returning no matches.", {
              error: error.message,
            }).pipe(Effect.as([] as ReadonlyArray<MindMemoryCandidate>)),
          ),
        );
      // rankCandidates sorts ascending by score. bm25 is negative/lower-is-better and
      // the weight factor is a positive multiplier, so the best match carries the most
      // negative score and heads the ascending list — consume from the front.
      const ranked = rankCandidates(candidates, nowIso).slice(0, limit);
      const queryItems = ranked.map((candidate) =>
        toRecallItem(candidate.memory, candidate.effectiveWeight, nowIso),
      );
      return {
        digest: renderDigest(queryItems),
        items: queryItems,
        note: MIND_RECALL_HYGIENE_NOTE,
      };
    });

  const confirm = (input: MindConfirmRequest): Effect.Effect<MindMemory, MindServiceError> =>
    Effect.gen(function* () {
      const existing = yield* repository.getById({ memoryId: input.memoryId });
      if (Option.isNone(existing)) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "No memory with this id; recall or list memories to get a valid id.",
          }),
        );
      }
      const row = existing.value;
      if (row.projectId !== input.projectId) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "No memory with this id; recall or list memories to get a valid id.",
          }),
        );
      }
      const operationId =
        input.turnId === null ? null : `confirm:${input.turnId}:${input.memoryId}`;
      // Confirm-race note: the read (getById) and write (applyConfirm) below
      // are not atomic, but repeats are still safe. Same-turn repeats hit the
      // receipt/journal replay above and return the row untouched; concurrent
      // confirms from different turns may each apply once (+0.15, capped at
      // 1.0, decay anchor reset) — a benign double-bump, never a lost write.
      if (operationId !== null) {
        const receipt = yield* repository.getReceipt({
          projectId: row.projectId,
          operationId,
        });
        const replayed =
          Option.isSome(receipt) ||
          Option.isSome(
            yield* repository.findJournalOp({
              memoryId: input.memoryId,
              op: "confirm",
              turnId: input.turnId,
            }),
          );
        if (replayed) {
          // Durable no-op: re-read the row the first confirm updated.
          const current = yield* repository.getById({ memoryId: input.memoryId });
          if (Option.isSome(current)) {
            const nowIso = yield* nowIsoNow;
            return toMindMemory(current.value, nowIso);
          }
        }
      }
      const nowMillis = yield* Clock.currentTimeMillis;
      const nowIso = new Date(nowMillis).toISOString();
      const updated = yield* repository.applyConfirm({
        memoryId: input.memoryId,
        peakWeight: confirmedWeight(row.peakWeight),
        lastAccessedAt: nowIso,
      });
      if (Option.isNone(updated)) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "The memory was deleted while confirming; recall to get a valid id.",
          }),
        );
      }
      yield* repository.appendJournal({
        projectId: row.projectId,
        memoryId: input.memoryId,
        op: "confirm",
        actor: input.actor,
        threadId: input.threadId,
        turnId: input.turnId,
        createdAt: nowIso,
      });
      if (operationId !== null) {
        yield* repository.putReceipt({
          projectId: row.projectId,
          operationId,
          op: "confirm",
          resultJson: JSON.stringify({
            memoryId: input.memoryId,
            peakWeight: updated.value.peakWeight,
          }),
          createdAt: nowIso,
        });
      }
      // Sweep after the mutation: the just-confirmed row is fresh and exempt,
      // so an explicit confirm can never be pre-empted by the prune sweep.
      yield* maybeSweep(row.projectId);
      return toMindMemory(updated.value, nowIso);
    });

  const forget = (input: MindForgetRequest): Effect.Effect<MindForgetResult, MindServiceError> =>
    Effect.gen(function* () {
      const nowIso = yield* nowIsoNow;
      const existing = yield* repository.getById({ memoryId: input.memoryId });
      if (Option.isNone(existing)) {
        // Idempotent: forgetting a missing id succeeds.
        return { memoryId: input.memoryId, deleted: false, alreadyGone: true };
      }
      const row = existing.value;
      if (row.projectId !== input.projectId) {
        // From the caller's project the memory is already gone: idempotent success.
        return { memoryId: input.memoryId, deleted: false, alreadyGone: true };
      }
      const deleted = yield* repository.deleteById({ memoryId: input.memoryId });
      if (!deleted) {
        return { memoryId: input.memoryId, deleted: false, alreadyGone: true };
      }
      // Journal rows carry the op and ids only — never memory text.
      yield* repository.appendJournal({
        projectId: row.projectId,
        memoryId: input.memoryId,
        op: "forget",
        actor: input.actor,
        threadId: input.threadId,
        turnId: input.turnId,
        createdAt: nowIso,
      });
      yield* maybeSweep(row.projectId);
      return { memoryId: input.memoryId, deleted: true, alreadyGone: false };
    });

  const status = (input: MindStatusRequest): Effect.Effect<MindStatusResult, MindServiceError> =>
    Effect.gen(function* () {
      const nowIso = yield* nowIsoNow;
      const rows = yield* repository.listByProject({ projectId: input.projectId });
      const digestItems = topDigestRows(rows, nowIso).map(({ row, weight }) =>
        toRecallItem(row, weight, nowIso),
      );
      const oldestIdleDays = rows.reduce((max, row) => Math.max(max, idleDaysOf(row, nowIso)), 0);
      return {
        count: rows.length,
        cap: MIND_MEMORY_PROJECT_CAP,
        pinnedCount: rows.filter((row) => row.pinned).length,
        digestChars: renderDigest(digestItems).length,
        oldestIdleDays: roundTo(oldestIdleDays, 2),
      };
    });

  const list = (input: MindListRequest): Effect.Effect<MindListResult, MindServiceError> =>
    Effect.gen(function* () {
      const nowIso = yield* nowIsoNow;
      const rows = yield* repository.listByProject({ projectId: input.projectId });
      // `count` is the true total; `memories` is the shown page. A shortfall
      // means undecodable rows were skipped read-side (never fatal) — log it
      // with shown/total so corruption is visible instead of silent.
      const total = yield* repository.countByProject({ projectId: input.projectId });
      const skipped = Math.max(0, total - rows.length);
      if (skipped > 0) {
        yield* Effect.logWarning("Mind list skipped undecodable rows.", {
          projectId: input.projectId,
          shown: rows.length,
          total,
          skipped,
        });
      }
      const memories = rows
        .map((row) => toMindMemory(row, nowIso))
        .toSorted((a, b) => b.weight - a.weight || a.memoryId.localeCompare(b.memoryId));
      return {
        memories,
        count: total,
        cap: MIND_MEMORY_PROJECT_CAP,
        ...(skipped > 0 ? { skipped } : {}),
      };
    });

  // Global list for the project-agnostic Mind view: every memory across all
  // projects, so rows whose project left the projection stay reachable. The
  // repository page is bounded to one cap; `count` stays the true total and
  // `skipped` counts only undecodable rows within the page, never the
  // truncation beyond it.
  const listAll = (): Effect.Effect<MindListResult, MindServiceError> =>
    Effect.gen(function* () {
      const nowIso = yield* nowIsoNow;
      const rows = yield* repository.listAll({ limit: MIND_MEMORY_PROJECT_CAP });
      const total = yield* repository.countAll();
      const skipped = Math.max(0, Math.min(total, MIND_MEMORY_PROJECT_CAP) - rows.length);
      if (skipped > 0) {
        yield* Effect.logWarning("Mind list skipped undecodable rows.", {
          shown: rows.length,
          total,
          skipped,
        });
      }
      const memories = rows
        .map((row) => toMindMemory(row, nowIso))
        .toSorted((a, b) => b.weight - a.weight || a.memoryId.localeCompare(b.memoryId));
      return {
        memories,
        count: total,
        cap: MIND_MEMORY_PROJECT_CAP,
        ...(skipped > 0 ? { skipped } : {}),
      };
    });

  const setPinned = (input: MindSetPinnedRequest): Effect.Effect<MindMemory, MindServiceError> =>
    Effect.gen(function* () {
      const existing = yield* repository.getById({ memoryId: input.memoryId });
      if (Option.isNone(existing)) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "No memory with this id; list memories to get a valid id.",
          }),
        );
      }
      const row = existing.value;
      if (row.projectId !== input.projectId) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "No memory with this id; list memories to get a valid id.",
          }),
        );
      }
      const nowIso = yield* nowIsoNow;
      const updated = yield* repository.setPinned({
        memoryId: input.memoryId,
        pinned: input.pinned,
      });
      if (Option.isNone(updated)) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "The memory was deleted while pinning; list memories to get a valid id.",
          }),
        );
      }
      yield* repository.appendJournal({
        projectId: row.projectId,
        memoryId: input.memoryId,
        op: input.pinned ? "pin" : "unpin",
        actor: input.actor,
        threadId: input.threadId,
        turnId: input.turnId,
        createdAt: nowIso,
      });
      // Sweep after the mutation: pinning a prune-eligible row must protect it.
      // A sweep before the update would delete the row first and fail below
      // with "deleted while pinning". Mirrors confirm.
      yield* maybeSweep(row.projectId);
      return toMindMemory(updated.value, nowIso);
    });

  const shape: MindServiceShape = {
    remember,
    recall,
    confirm,
    forget,
    status,
    list,
    listAll,
    setPinned,
    affirm: (input: MindAffirmRequest) =>
      confirm({
        projectId: input.projectId,
        memoryId: input.memoryId,
        actor: { kind: "user" },
        threadId: null,
        turnId: null,
      }),
  };
  return shape;
});

export const MindServiceLive = Layer.effect(MindService, makeMindService);
