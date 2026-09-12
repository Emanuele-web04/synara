import { createHash, randomUUID } from "node:crypto";

import {
  MIND_HISTORY_MAX_ENTRIES,
  MIND_MEMORY_PROJECT_CAP,
  MIND_MEMORY_TEXT_MAX_CHARS,
  MIND_PROFILE_TEXT_MAX_CHARS,
  MIND_RECALL_CANDIDATE_MAX_ITEMS,
  MIND_RECALL_HYGIENE_NOTE,
  MIND_RECALL_MAX_DIGEST_CHARS,
  MIND_RECALL_MAX_ITEMS,
  MIND_RECALL_QUERY_MAX_CHARS,
  MindMemoryId,
  type MindHistoryResult,
  type MindListResult,
  type MindMemory,
  type MindProfile,
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
  MindTextExistsError,
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
  type MindHistoryRequest,
  type MindListRequest,
  type MindRememberRequest,
  type MindRememberResult,
  type MindRecallRequest,
  type MindServiceError,
  type MindServiceShape,
  type MindProfileGetRequest,
  type MindProfileSetRequest,
  type MindSetPinnedRequest,
  type MindStatusRequest,
  type MindStatusResult,
  type MindUpdateRequest,
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

/** Framed profile block: quoted user data, same `<`-escape as memory lines. */
const renderProfileDigestBlock = (text: string): string =>
  `\nProfile:\n- ${escapeDigestText(text)}`;

/**
 * Memory digest plus the opted-in profile block. Memory lines render first
 * within the char budget left after reserving the profile block, so the
 * result always fits the contracts' digest cap; the profile text itself is
 * truncated only in the degenerate case where it alone exceeds the cap.
 */
export const renderDigestWithProfile = (
  items: ReadonlyArray<MindRecallItem>,
  profileText: string | null,
): string => {
  if (profileText === null) return renderDigest(items);
  const block = renderProfileDigestBlock(profileText);
  if (block.length >= MIND_RECALL_MAX_DIGEST_CHARS) {
    const head = "\nProfile:\n- ";
    return `${head.slice(1)}${escapeDigestText(profileText).slice(
      0,
      Math.max(0, MIND_RECALL_MAX_DIGEST_CHARS - head.length + 1),
    )}`;
  }
  const lines: string[] = [];
  for (const item of items) {
    const line = renderDigestLine(item);
    const candidate = lines.length === 0 ? line : `${lines.join("\n")}\n${line}`;
    if (candidate.length + block.length > MIND_RECALL_MAX_DIGEST_CHARS) break;
    lines.push(line);
  }
  const base = lines.join("\n");
  return base.length === 0 ? block.slice(1) : `${base}${block}`;
};

/** Opted-in profile text for the recall digest, or null when it stays out. */
const optedInProfileText = (
  profile: Option.Option<{ readonly text: string; readonly optedIn: boolean }>,
): string | null => (Option.isSome(profile) && profile.value.optedIn ? profile.value.text : null);

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
      const profileText = optedInProfileText(
        yield* repository.getProfile({ projectId: input.projectId }),
      );
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
          digest: renderDigestWithProfile(digestItems, profileText),
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
        digest: renderDigestWithProfile(queryItems, profileText),
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
      const profile = yield* repository.getProfile({ projectId: input.projectId });
      return {
        count: rows.length,
        cap: MIND_MEMORY_PROJECT_CAP,
        pinnedCount: rows.filter((row) => row.pinned).length,
        digestChars: renderDigestWithProfile(digestItems, optedInProfileText(profile)).length,
        oldestIdleDays: roundTo(oldestIdleDays, 2),
        ...(Option.isSome(profile) ? { profileOptedIn: profile.value.optedIn } : {}),
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

  // The edit mutation serialized in its own transaction (check-then-act:
  // receipt lookup, collision check, row update, revision insert) so
  // concurrent saves stay race-free: one row update, one revision, one
  // receipt. Only text/type move, plus the decay anchor — peak weight and
  // access count are never touched by an edit.
  const updateInTransaction = (
    input: MindUpdateRequest,
  ): Effect.Effect<MindMemory, MindServiceError> =>
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
          const existing = yield* repository.getById({ memoryId: input.memoryId });
          if (Option.isNone(existing) || existing.value.projectId !== input.projectId) {
            return yield* Effect.fail(
              new MindMemoryNotFoundError({
                memoryId: input.memoryId,
                message: "No memory with this id; recall or list memories to get a valid id.",
              }),
            );
          }
          const row = existing.value;
          const textHash = hashMindText(normalized);
          const operationId =
            input.turnId === null ? null : `update:${input.turnId}:${input.memoryId}:${textHash}`;
          if (operationId !== null) {
            const receipt = yield* repository.getReceipt({
              projectId: row.projectId,
              operationId,
            });
            if (Option.isSome(receipt)) {
              // Durable no-op: re-read the row the first update wrote.
              const current = yield* repository.getById({ memoryId: input.memoryId });
              if (Option.isSome(current)) {
                const nowIso = yield* nowIsoNow;
                return toMindMemory(current.value, nowIso);
              }
            }
          }
          const clash = yield* repository.findByTextHash({
            projectId: row.projectId,
            textHash,
          });
          if (Option.isSome(clash) && clash.value.memoryId !== input.memoryId) {
            return yield* Effect.fail(
              new MindTextExistsError({
                memoryId: clash.value.memoryId,
                message:
                  "Another memory in this project already holds this text; forget or edit that memory instead of duplicating it.",
              }),
            );
          }
          const nowMillis = yield* Clock.currentTimeMillis;
          const nowIso = new Date(nowMillis).toISOString();
          const nextType = input.type ?? row.type;
          if (normalized === row.text && nextType === row.type) {
            if (operationId !== null) {
              // Crash-recovery replay: the receipt is missing but the row
              // already holds the target content, so this turn already applied.
              return toMindMemory(row, nowIso);
            }
            // The UI passes no turn, so every save applies: touch the decay
            // anchor even when the content is unchanged (no revision noise).
            const touched = yield* repository.applyUpdate({
              memoryId: input.memoryId,
              text: row.text,
              type: row.type,
              textHash: row.textHash,
              lastAccessedAt: nowIso,
            });
            if (Option.isNone(touched)) {
              return yield* Effect.fail(
                new MindMemoryNotFoundError({
                  memoryId: input.memoryId,
                  message: "The memory was deleted while editing; recall to get a valid id.",
                }),
              );
            }
            return toMindMemory(touched.value, nowIso);
          }
          const updated = yield* repository.applyUpdate({
            memoryId: input.memoryId,
            text: normalized,
            type: nextType,
            textHash,
            lastAccessedAt: nowIso,
          });
          if (Option.isNone(updated)) {
            return yield* Effect.fail(
              new MindMemoryNotFoundError({
                memoryId: input.memoryId,
                message: "The memory was deleted while editing; recall to get a valid id.",
              }),
            );
          }
          yield* repository.insertRevision({
            memoryId: input.memoryId,
            oldHash: row.textHash,
            newHash: textHash,
            actor: input.actor,
            createdAt: nowIso,
          });
          if (operationId !== null) {
            yield* repository.putReceipt({
              projectId: row.projectId,
              operationId,
              op: "update",
              resultJson: JSON.stringify({ memoryId: input.memoryId, textHash }),
              createdAt: nowIso,
            });
          }
          return toMindMemory(updated.value, nowIso);
        }),
      )
      .pipe(
        Effect.catchIf(
          (error): error is SqlError => error._tag === "SqlError",
          (error) => Effect.fail(toPersistenceSqlError("MindService.update:transaction")(error)),
        ),
      );

  // Sweep after the mutation: the just-edited row is fresh and exempt, so an
  // explicit edit can never be pre-empted by the prune sweep. Mirrors confirm.
  const update = (input: MindUpdateRequest): Effect.Effect<MindMemory, MindServiceError> =>
    Effect.gen(function* () {
      const result = yield* updateInTransaction(input);
      yield* maybeSweep(result.projectId);
      return result;
    });

  const profileGet = (
    input: MindProfileGetRequest,
  ): Effect.Effect<MindProfile | null, MindServiceError> =>
    Effect.map(repository.getProfile({ projectId: input.projectId }), Option.getOrNull);

  // User-only write from the Mind UI: no thread/turn context, no journal row.
  // An empty text on opt-out keeps the last saved text; with no prior profile
  // there is nothing to keep, so the save is rejected as empty.
  const profileSet = (input: MindProfileSetRequest): Effect.Effect<MindProfile, MindServiceError> =>
    Effect.gen(function* () {
      const nowIso = yield* nowIsoNow;
      const existing = yield* repository.getProfile({ projectId: input.projectId });
      const normalized = normalizeMindText(input.text);
      const nextText =
        normalized.length > 0 ? normalized : Option.isSome(existing) ? existing.value.text : "";
      if (nextText.length === 0) {
        return yield* Effect.fail(
          new MindInvalidTextError({
            reason: "empty",
            message: "Profile text is empty; write a short project profile or opt back in later.",
          }),
        );
      }
      if (nextText.length > MIND_PROFILE_TEXT_MAX_CHARS) {
        return yield* Effect.fail(
          new MindInvalidTextError({
            reason: "tooLong",
            message: `Profile text is ${nextText.length} characters after trimming; keep it at ${MIND_PROFILE_TEXT_MAX_CHARS} or fewer.`,
          }),
        );
      }
      if (isMindSecret(nextText)) {
        return yield* Effect.fail(
          new MindSecretRejectedError({
            message:
              "Profile text matches a credential or secret pattern and was rejected; keep secrets in a secret store, never in project memory.",
          }),
        );
      }
      yield* repository.setProfile({
        projectId: input.projectId,
        text: nextText,
        optedIn: input.optedIn,
        updatedAt: nowIso,
      });
      if (!Option.isSome(existing) || existing.value.text !== nextText) {
        yield* repository.insertProfileRevision({
          projectId: input.projectId,
          textHash: hashMindText(nextText),
          actor: { kind: "user" },
          createdAt: nowIso,
        });
      }
      return {
        projectId: input.projectId,
        text: nextText,
        optedIn: input.optedIn,
        updatedAt: nowIso,
      };
    });

  const history = (input: MindHistoryRequest): Effect.Effect<MindHistoryResult, MindServiceError> =>
    Effect.gen(function* () {
      const existing = yield* repository.getById({ memoryId: input.memoryId });
      if (Option.isNone(existing) || existing.value.projectId !== input.projectId) {
        return yield* Effect.fail(
          new MindMemoryNotFoundError({
            memoryId: input.memoryId,
            message: "No memory with this id; recall or list memories to get a valid id.",
          }),
        );
      }
      const row = existing.value;
      const journal = yield* repository.listJournalForMemory({ memoryId: input.memoryId });
      const revisions = yield* repository.listRevisions({ memoryId: input.memoryId });
      // Op timeline only — journal and revision rows never carry memory text.
      const entries: MindHistoryResult["entries"] = [
        ...journal.map((entry) => ({
          op: entry.op as MindHistoryResult["entries"][number]["op"],
          actor: entry.actor,
          createdAt: entry.createdAt,
        })),
        ...revisions.map((revision) => ({
          op: "edit" as const,
          actor: revision.actor,
          createdAt: revision.createdAt,
        })),
      ]
        .toSorted((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .slice(0, MIND_HISTORY_MAX_ENTRIES);
      if (entries.length === 0) {
        // The memory exists, so it was remembered — the journal row may
        // predate journaling. Anchor the empty timeline honestly on creation.
        return { entries: [{ op: "remember", actor: { kind: "user" }, createdAt: row.createdAt }] };
      }
      return { entries };
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
    update,
    history,
    profileGet,
    profileSet,
  };
  return shape;
});

export const MindServiceLive = Layer.effect(MindService, makeMindService);
