// Purpose: Pure session-context helpers for the Grok adapter (turn state, runtime-id scoping, cost, cwd, plan-mode prompt).
// Layer: synchronous helpers + a couple of params-only Effects over a GrokSessionContext — no runtime services.
// Exports: turn clearing, resume parsing, runtime-id scoping, cost recording, pending-settlement effects, cwd/plan-mode helpers.

import { type ApprovalRequestId, type ProviderInteractionMode } from "@t3tools/contracts";
import * as nodePath from "node:path";

import { Deferred, Effect } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";

import { type ServerConfigShape } from "../../config.ts";
import { type AcpToolCallState } from "../acp/AcpRuntimeModel.ts";

import {
  GROK_PLAN_MODE_PROMPT_PREFIX,
  GROK_RESUME_VERSION,
  type GrokSessionContext,
  isRecord,
  type PendingApproval,
  type PendingUserInput,
} from "./GrokAdapter.types.ts";
import type { TurnId } from "@t3tools/contracts";

export function clearGrokActiveTurn(ctx: GrokSessionContext, turnId: TurnId): boolean {
  if (ctx.activeTurnId !== turnId) {
    return false;
  }

  ctx.activeTurnId = undefined;
  ctx.activeTurnHadAssistantContent = false;
  ctx.activeAssistantItemsWithContent.clear();
  ctx.activeTurnFailedToolDetail = undefined;
  ctx.activePromptFiber = undefined;
  ctx.activeInteractionMode = undefined;
  const { activeTurnId: _activeTurnId, ...session } = ctx.session;
  ctx.session = session;
  return true;
}

export function scopeGrokRuntimeItemIdForTurn(turnId: TurnId, itemId: string): string {
  return `grok:${turnId}:${itemId}`;
}

// Grok can close a stale assistant segment before any visible text arrives.
export function isRenderableGrokAssistantDelta(input: {
  readonly streamKind?: string | undefined;
  readonly text: string;
}): boolean {
  return input.streamKind !== "reasoning_text" && input.text.trim().length > 0;
}

// Grok may reuse ACP item ids across resumed history; DP runtime ids must stay turn-local.
export function scopeGrokToolCallStateForTurn(
  turnId: TurnId,
  toolCall: AcpToolCallState,
): AcpToolCallState {
  return {
    ...toolCall,
    toolCallId: scopeGrokRuntimeItemIdForTurn(turnId, toolCall.toolCallId),
    data: {
      ...toolCall.data,
      providerToolCallId: toolCall.toolCallId,
    },
  };
}

export function parseGrokResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== GROK_RESUME_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

function readAcpUsdCost(cost: EffectAcpSchema.Cost | null | undefined): number | undefined {
  if (!cost || cost.currency.toUpperCase() !== "USD" || !Number.isFinite(cost.amount)) {
    return undefined;
  }
  return cost.amount >= 0 ? cost.amount : undefined;
}

export function recordGrokSessionCost(
  ctx: GrokSessionContext,
  cost: EffectAcpSchema.Cost | null | undefined,
): void {
  const sessionCostUsd = readAcpUsdCost(cost);
  if (sessionCostUsd !== undefined) {
    ctx.latestSessionCostUsd = sessionCostUsd;
  }
}

export function finalizeGrokActiveTurnCost(ctx: GrokSessionContext): {
  readonly cumulativeCostUsd?: number;
} {
  return ctx.latestSessionCostUsd !== undefined
    ? { cumulativeCostUsd: ctx.latestSessionCostUsd }
    : {};
}

export function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}

export function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingUserInputs.values()),
    (pending) => Deferred.succeed(pending.answers, {}).pipe(Effect.ignore),
    { discard: true },
  );
}

export function withGrokPlanModePrompt(input: {
  readonly text: string;
  readonly interactionMode?: ProviderInteractionMode;
}): string {
  if (input.interactionMode !== "plan") {
    return input.text;
  }

  const text = input.text.trim();
  return text.length > 0
    ? `${GROK_PLAN_MODE_PROMPT_PREFIX}\n\nUser request:\n${text}`
    : GROK_PLAN_MODE_PROMPT_PREFIX;
}

export function resolveGrokSessionCwd(
  inputCwd: string | undefined,
  serverConfig: ServerConfigShape,
): string | undefined {
  const requestedCwd = inputCwd?.trim();
  if (requestedCwd) {
    return nodePath.resolve(requestedCwd);
  }

  const fallbackCwd = serverConfig.cwd.trim() || serverConfig.homeDir.trim();
  return fallbackCwd ? nodePath.resolve(fallbackCwd) : undefined;
}
