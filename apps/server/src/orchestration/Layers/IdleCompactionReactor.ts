import {
  ClaudeCacheObservation,
  TurnId,
  type OrchestrationThread,
  type ThreadId,
} from "@synara/contracts";
import {
  IDLE_COMPACTION_PROVIDER_DEFAULT_TTL_SECONDS,
  IDLE_COMPACTION_SWEEP_MS,
  idleCompactionDue,
  idleCompactionEstimatedContextTokens,
  idleCompactionLeaseKey,
  type IdleCompactionObservation,
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
 * Providers without native cache telemetry get a synthetic observation:
 * the lease anchors on the thread's last provider-runtime activity, the TTL
 * is the provider's default prompt-cache window, and context size is
 * estimated from message text since no token counts are persisted.
 */
const defaultObservationFor = (
  provider: string,
  thread: OrchestrationThread,
): IdleCompactionObservation | undefined => {
  const ttlSeconds = IDLE_COMPACTION_PROVIDER_DEFAULT_TTL_SECONDS[provider];
  const lease = thread.session?.lastActivityAt ?? thread.session?.lastProgressAt;
  if (ttlSeconds === undefined || lease == null) {
    return undefined;
  }
  const messageTextLength = thread.messages.reduce(
    (total, message) => total + message.text.length,
    0,
  );
  return {
    ttlSeconds,
    cacheReferenceAt: lease,
    contextTokens: idleCompactionEstimatedContextTokens(messageTextLength),
  };
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

  const compactThread = (threadId: ThreadId, provider: string) =>
    Effect.gen(function* () {
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
      if (provider === "claudeAgent") {
        const startClaudeCompaction = providerService.startClaudeCompaction;
        if (!startClaudeCompaction) {
          return;
        }
        yield* startClaudeCompaction({
          threadId,
          turnId: TurnId.makeUnsafe(crypto.randomUUID()),
        });
      } else {
        yield* providerService.compactThread({ threadId });
      }
    });

  const sweepOnce = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const enabledProviders = new Set<string>(
      (
        [
          ["claudeAgent", settings.providers.claudeAgent.compactIdleThreads],
          ["codex", settings.providers.codex.compactIdleThreads],
          ["antigravity", settings.providers.antigravity.compactIdleThreads],
        ] as const
      )
        .filter(([, enabled]) => enabled === true)
        .map(([provider]) => provider),
    );
    if (enabledProviders.size === 0) {
      return;
    }
    const [readModel, bindings] = yield* Effect.all([
      orchestrationEngine.getReadModel(),
      providerSessionDirectory.listBindings(),
    ]);
    const threadById = new Map(readModel.threads.map((thread) => [thread.id, thread]));
    const nowMs = Date.now();
    for (const binding of bindings) {
      if (!enabledProviders.has(binding.provider)) {
        continue;
      }
      const thread = threadById.get(binding.threadId);
      if (!thread || !isThreadIdleForCompaction(thread)) {
        continue;
      }
      const observation =
        binding.provider === "claudeAgent"
          ? claudeCacheFromResumeCursor(binding.resumeCursor)
          : defaultObservationFor(binding.provider, thread);
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
      inFlight.add(binding.threadId);
      compactedLeases.set(binding.threadId, leaseKey);
      yield* compactThread(binding.threadId, binding.provider).pipe(
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
