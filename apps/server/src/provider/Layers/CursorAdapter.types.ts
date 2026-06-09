// Purpose: Pure, runtime-free shared types, constants, and state helpers for the Cursor adapter modules.
// Layer: types, literal constants, and pure functions operating only on passed-in arguments — no session-context closures.
// Exports: PROVIDER, resume/discovery constants, plan-mode prompt prefix, session-context types, state mutators, parsers.

import {
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Scope, Stream } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import { type AcpSessionRuntimeShape } from "../acp/AcpSessionRuntime.ts";
import { type CursorAcpRuntimeCursorSettings } from "../acp/CursorAcpSupport.ts";

import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

export const PROVIDER = "cursor" as const;
export const CURSOR_RESUME_VERSION = 1 as const;
export const CURSOR_MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
export const CURSOR_PLAN_MODE_PROMPT_PREFIX = [
  "Synara Cursor plan mode is active.",
  "Do not implement or mutate files in this turn.",
  "Do not ask follow-up questions or wait for confirmation; if scope is ambiguous, choose a reasonable default and state the assumption in the plan.",
  "When ready, create the final implementation plan.",
].join("\n");

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => "",
    (acc, chunk) => acc + new TextDecoder().decode(chunk),
  );

export interface CursorAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

export interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

export interface CursorSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntimeShape;
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  completedPlanFingerprint: string | undefined;
  activeInteractionMode: ProviderInteractionMode | undefined;
  activeTurnId: TurnId | undefined;
  activeTurnFailedToolDetail: string | undefined;
  activePromptFiber: Fiber.Fiber<void, never> | undefined;
  latestSessionCostUsd: number | undefined;
  stopped: boolean;
}

export function clearCursorActiveTurn(ctx: CursorSessionContext, turnId: TurnId): boolean {
  if (ctx.activeTurnId !== turnId) {
    return false;
  }

  ctx.activeTurnId = undefined;
  ctx.activeTurnFailedToolDetail = undefined;
  ctx.activePromptFiber = undefined;
  ctx.activeInteractionMode = undefined;
  const { activeTurnId: _activeTurnId, ...session } = ctx.session;
  ctx.session = session;
  return true;
}

export function readAcpUsdCost(cost: EffectAcpSchema.Cost | null | undefined): number | undefined {
  if (!cost || cost.currency.toUpperCase() !== "USD" || !Number.isFinite(cost.amount)) {
    return undefined;
  }
  return cost.amount >= 0 ? cost.amount : undefined;
}

export function recordCursorSessionCost(
  ctx: CursorSessionContext,
  cost: EffectAcpSchema.Cost | null | undefined,
): void {
  const sessionCostUsd = readAcpUsdCost(cost);
  if (sessionCostUsd === undefined) {
    return;
  }
  ctx.latestSessionCostUsd = sessionCostUsd;
}

// ACP reports session-cumulative cost, so keep it cumulative instead of inventing turn deltas.
export function finalizeCursorActiveTurnCost(ctx: CursorSessionContext): {
  readonly cumulativeCostUsd?: number;
} {
  return ctx.latestSessionCostUsd !== undefined
    ? { cumulativeCostUsd: ctx.latestSessionCostUsd }
    : {};
}

export function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

export function withCursorPlanModePrompt(input: {
  readonly text: string;
  readonly interactionMode?: ProviderInteractionMode;
}): string {
  if (input.interactionMode !== "plan") {
    return input.text;
  }

  const text = input.text.trim();
  return text.length > 0
    ? `${CURSOR_PLAN_MODE_PROMPT_PREFIX}\n\nUser request:\n${text}`
    : CURSOR_PLAN_MODE_PROMPT_PREFIX;
}

export function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

export function mergeCursorAcpSettings(
  base: CursorAcpRuntimeCursorSettings,
  override: { readonly binaryPath?: string; readonly apiEndpoint?: string } | undefined,
): CursorAcpRuntimeCursorSettings {
  return {
    ...(base.binaryPath !== undefined ? { binaryPath: base.binaryPath } : {}),
    ...(base.apiEndpoint !== undefined ? { apiEndpoint: base.apiEndpoint } : {}),
    ...(override?.binaryPath !== undefined ? { binaryPath: override.binaryPath } : {}),
    ...(override?.apiEndpoint !== undefined ? { apiEndpoint: override.apiEndpoint } : {}),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCursorResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== CURSOR_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}
