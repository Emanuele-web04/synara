/**
 * ACP adapter support - maps protocol errors and approval decisions into DP runtime shapes.
 *
 * @module AcpAdapterSupport
 */
import { type ProviderApprovalDecision, type ProviderKind, type ThreadId } from "@synara/contracts";
import { Schema } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";

export function mapAcpToAdapterError(
  provider: ProviderKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (Schema.is(EffectAcpErrors.AcpProcessExitedError)(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (Schema.is(EffectAcpErrors.AcpRequestError)(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

type AcpPermissionOptionLike = {
  readonly kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  readonly optionId: string;
};

export function selectAcpPermissionOptionId(
  decision: ProviderApprovalDecision,
  options: ReadonlyArray<AcpPermissionOptionLike>,
): string | undefined {
  if (decision === "cancel") {
    return undefined;
  }

  const preferredKinds =
    decision === "acceptForSession"
      ? (["allow_always", "allow_once"] as const)
      : decision === "accept"
        ? (["allow_once", "allow_always"] as const)
        : (["reject_once", "reject_always"] as const);

  for (const kind of preferredKinds) {
    const optionId = options.find((option) => option.kind === kind)?.optionId.trim();
    if (optionId) {
      return optionId;
    }
  }
  return undefined;
}

export function selectAcpFullAccessPermissionOptionId(
  options: ReadonlyArray<AcpPermissionOptionLike>,
): string | undefined {
  return selectAcpPermissionOptionId("acceptForSession", options);
}

type AcpToolCallLike = {
  readonly status?: string;
  readonly detail?: string | null;
  readonly title?: string | null;
};

// Converts provider-specific failed tool payloads into a stable turn failure message.
export function readAcpFailedToolDetail(toolCall: AcpToolCallLike): string | undefined {
  if (toolCall.status !== "failed") {
    return undefined;
  }

  return toolCall.detail?.trim() || toolCall.title?.trim() || "Tool call failed.";
}

export function classifyAcpPromptTurnCompletion(input: {
  readonly stopReason: string | null | undefined;
  readonly failedToolDetail?: string | undefined;
}): { readonly state: "completed" | "cancelled" | "failed"; readonly errorMessage?: string } {
  if (input.stopReason !== "cancelled") {
    return { state: "completed" };
  }

  const failedToolDetail = input.failedToolDetail?.trim();
  if (failedToolDetail) {
    return {
      state: "failed",
      errorMessage: failedToolDetail,
    };
  }

  return { state: "cancelled" };
}
