import {
  ClaudeCacheObservation,
  TurnId,
  type OrchestrationThread,
  type ThreadId,
} from "@synara/contracts";
import {
  IDLE_COMPACTION_SWEEP_MS,
  idleCompactionDue,
  idleCompactionLeaseKey,
} from "@synara/shared/idleCompaction";
import { Cause, Duration, Effect, Layer, Option, Schema } from "effect";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  IdleCompactionReactor,
  type IdleCompactionReactorShape,
} from "../Services/IdleCompactionReactor.ts";

const decodeClaudeCacheObservation = Schema.decodeUnknownOption(ClaudeCacheObservation);

const claudeCacheFromResumeCursor = (resumeCursor: unknown): ClaudeCacheObservation | undefined => {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const { claudeCache } = resumeCursor as { readonly claudeCache?: unknown };
  return Option.getOrUndefined(decodeClaudeCacheObservation(claudeCache));
};

/**
 * A compaction candidate has nothing for the user or the provider to act on:
 * its last turn settled normally, no interaction or review is pending, and the
 * thread is neither snoozed, archived, deleted, nor a derived conversation
 * (subagent, side chat) whose parent owns compaction cadence.
 */
const isThreadIdleForCompaction = (thread: OrchestrationThread): boolean =>
  thread.latestTurn?.state === "completed" &&
  thread.session?.status !== "starting" &&
  thread.session?.activeTurnId == null &&
  thread.hasPendingApprovals !== true &&
  thread.hasPendingUserInput !== true &&
  thread.claudeCacheReview == null &&
  thread.handoff == null &&
  thread.archivedAt == null &&
  thread.deletedAt == null &&
  thread.snoozedUntil == null &&
  thread.parentThreadId == null &&
  thread.subagentAgentId == null &&
  thread.sidechatSourceThreadId == null;

export const makeIdleCompactionReactor = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  const providerService = yield* ProviderService;
  const serverSettings = yield* ServerSettingsService;

  // Compactions already attempted, keyed by the observed cache lease they ran
  // against. A renewed lease (a real request) makes the thread eligible again.
  const compactedLeases = new Map<ThreadId, string>();
  const inFlight = new Set<ThreadId>();

  const compactThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const startClaudeCompaction = providerService.startClaudeCompaction;
      if (!startClaudeCompaction) {
        return;
      }
      if (providerService.prewarmSession) {
        yield* providerService.prewarmSession({ threadId });
      }
      // Prewarm ran the same recovery a send would run; the session may have
      // come up with queued work, so re-verify the thread is still idle before
      // consuming one provider request on a maintenance compaction.
      const readModel = yield* orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((candidate) => candidate.id === threadId);
      if (!thread || !isThreadIdleForCompaction(thread)) {
        return;
      }
      yield* startClaudeCompaction({
        threadId,
        turnId: TurnId.makeUnsafe(crypto.randomUUID()),
      });
    });

  const sweepOnce = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    if (settings.providers.claudeAgent.compactIdleThreads !== true) {
      return;
    }
    if (!providerService.startClaudeCompaction) {
      return;
    }
    const [readModel, bindings] = yield* Effect.all([
      orchestrationEngine.getReadModel(),
      providerSessionDirectory.listBindings(),
    ]);
    const threadById = new Map(readModel.threads.map((thread) => [thread.id, thread]));
    const nowMs = Date.now();
    for (const binding of bindings) {
      if (binding.provider !== "claudeAgent") {
        continue;
      }
      const observation = claudeCacheFromResumeCursor(binding.resumeCursor);
      if (!observation || !idleCompactionDue(observation, nowMs)) {
        continue;
      }
      const leaseKey = idleCompactionLeaseKey(observation);
      if (
        leaseKey === undefined ||
        inFlight.has(binding.threadId) ||
        compactedLeases.get(binding.threadId) === leaseKey
      ) {
        continue;
      }
      const thread = threadById.get(binding.threadId);
      if (!thread || !isThreadIdleForCompaction(thread)) {
        continue;
      }
      inFlight.add(binding.threadId);
      compactedLeases.set(binding.threadId, leaseKey);
      yield* compactThread(binding.threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("idle cache compaction failed", {
            threadId: binding.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.ensuring(Effect.sync(() => inFlight.delete(binding.threadId))),
        Effect.forkScoped,
      );
    }
  });

  const start: IdleCompactionReactorShape["start"] = Effect.gen(function* () {
    yield* Effect.forever(
      sweepOnce.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("idle cache compaction sweep failed", {
            cause: Cause.pretty(cause),
          }),
        ),
        Effect.andThen(Effect.sleep(Duration.millis(IDLE_COMPACTION_SWEEP_MS))),
      ),
    ).pipe(Effect.forkScoped);
  });

  return { start } satisfies IdleCompactionReactorShape;
});

export const IdleCompactionReactorLive = Layer.effect(
  IdleCompactionReactor,
  makeIdleCompactionReactor,
);
