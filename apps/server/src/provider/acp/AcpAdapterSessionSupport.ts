// FILE: AcpAdapterSessionSupport.ts
// Purpose: Shares ACP adapter bookkeeping that is independent of a provider's transport details.
// Layer: Provider ACP adapter support
// Exports: provider-independent ACP session bookkeeping and turn-local item scoping helpers.

import * as nodePath from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderSession,
  ProviderUserInputAnswers,
  TurnId,
} from "@synara/contracts";
import { Deferred, Effect, Option, Semaphore, SynchronizedRef } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

export interface AcpThreadLock {
  <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
}

// Serializes lifecycle mutations per thread while allowing unrelated ACP sessions to proceed.
export function makeAcpThreadLock(): Effect.Effect<AcpThreadLock> {
  return SynchronizedRef.make(new Map<string, Semaphore.Semaphore>()).pipe(
    Effect.map((locksRef) => {
      const get = (threadId: string) =>
        SynchronizedRef.modifyEffect(locksRef, (current) => {
          const existing = Option.fromNullishOr(current.get(threadId));
          return Option.match(existing, {
            onNone: () =>
              Semaphore.make(1).pipe(
                Effect.map((semaphore) => {
                  const next = new Map(current);
                  next.set(threadId, semaphore);
                  return [semaphore, next] as const;
                }),
              ),
            onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
          });
        });
      return (<A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
        Effect.flatMap(get(threadId), (semaphore) =>
          semaphore.withPermit(effect),
        )) satisfies AcpThreadLock;
    }),
  );
}

// Resolves outstanding permission requests before an ACP child is closed.
export function settleAcpPendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<
    unknown,
    { readonly decision: Deferred.Deferred<ProviderApprovalDecision> }
  >,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

// Resolves outstanding elicitation requests so shutdown cannot strand their handlers.
export function settleAcpPendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<
    unknown,
    { readonly answers: Deferred.Deferred<ProviderUserInputAnswers> }
  >,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

// Accepts only finite, non-negative USD totals from ACP cost notifications.
export function readAcpUsdCost(cost: EffectAcpSchema.Cost | null | undefined): number | undefined {
  if (!cost || cost.currency.toUpperCase() !== "USD" || !Number.isFinite(cost.amount)) {
    return undefined;
  }
  return cost.amount >= 0 ? cost.amount : undefined;
}

export function recordAcpSessionCost(
  context: { latestSessionCostUsd: number | undefined },
  cost: EffectAcpSchema.Cost | null | undefined,
): void {
  const sessionCostUsd = readAcpUsdCost(cost);
  if (sessionCostUsd !== undefined) {
    context.latestSessionCostUsd = sessionCostUsd;
  }
}

export function finalizeAcpActiveTurnCost(context: {
  latestSessionCostUsd: number | undefined;
}): { readonly cumulativeCostUsd?: number } {
  return context.latestSessionCostUsd !== undefined
    ? { cumulativeCostUsd: context.latestSessionCostUsd }
    : {};
}

export function withAcpPlanModePrompt(input: {
  readonly text: string;
  readonly interactionMode?: ProviderInteractionMode;
  readonly promptPrefix: string;
}): string {
  if (input.interactionMode !== "plan") {
    return input.text;
  }

  const text = input.text.trim();
  return text.length > 0
    ? `${input.promptPrefix}\n\nUser request:\n${text}`
    : input.promptPrefix;
}

export function resolveAcpSessionCwd(input: {
  readonly inputCwd: string | undefined;
  readonly serverCwd: string;
  readonly homeDir: string;
  readonly sessionCwd?: string;
}): string | undefined {
  const requestedCwd = input.inputCwd?.trim() || input.sessionCwd?.trim();
  if (requestedCwd) {
    return nodePath.resolve(requestedCwd);
  }

  const fallbackCwd = input.serverCwd.trim() || input.homeDir.trim();
  return fallbackCwd ? nodePath.resolve(fallbackCwd) : undefined;
}

export function clearAcpActiveTurn<PromptFiber, InteractionMode>(
  context: {
    activeTurnId: TurnId | undefined;
    activeTurnHadAssistantContent: boolean;
    activeAssistantItemsWithContent: { clear(): void };
    activeTurnFailedToolDetail: string | undefined;
    activePromptFiber: PromptFiber | undefined;
    activeInteractionMode: InteractionMode | undefined;
    session: ProviderSession;
  },
  turnId: TurnId,
): boolean {
  if (context.activeTurnId !== turnId) {
    return false;
  }

  context.activeTurnId = undefined;
  context.activeTurnHadAssistantContent = false;
  context.activeAssistantItemsWithContent.clear();
  context.activeTurnFailedToolDetail = undefined;
  context.activePromptFiber = undefined;
  context.activeInteractionMode = undefined;
  const { activeTurnId: _activeTurnId, ...session } = context.session;
  context.session = session;
  return true;
}

export function scopeAcpRuntimeItemIdForTurn(
  provider: string,
  turnId: TurnId,
  itemId: string,
): string {
  return `${provider}:${turnId}:${itemId}`;
}

// Preserves the provider-native tool id while making the public runtime id turn-local.
export function scopeAcpToolCallStateForTurn(
  provider: string,
  turnId: TurnId,
  toolCall: AcpToolCallState,
): AcpToolCallState {
  return {
    ...toolCall,
    toolCallId: scopeAcpRuntimeItemIdForTurn(provider, turnId, toolCall.toolCallId),
    data: {
      ...toolCall.data,
      providerToolCallId: toolCall.toolCallId,
    },
  };
}

export function acceptAcpPlanUpdate(
  context: { activeTurnId: TurnId | undefined; lastPlanFingerprint: string | undefined },
  payload: unknown,
): boolean {
  const fingerprint = `${context.activeTurnId ?? "no-turn"}:${JSON.stringify(payload)}`;
  if (context.lastPlanFingerprint === fingerprint) return false;
  context.lastPlanFingerprint = fingerprint;
  return true;
}
