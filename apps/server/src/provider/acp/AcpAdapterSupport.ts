/**
 * ACP adapter support - maps protocol errors and approval decisions into DP runtime shapes.
 *
 * @module AcpAdapterSupport
 */
import {
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderKind,
  type RuntimeMode,
  type ThreadId,
  type ToolLifecycleItemType,
} from "@synara/contracts";
import { Schema } from "effect";
import * as AcpErrors from "./AcpErrors.ts";

import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";

export function canonicalItemTypeFromAcpToolKind(kind: string | undefined): ToolLifecycleItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "fetch":
      return "web_search";
    case "search":
    default:
      return "dynamic_tool_call";
  }
}

function acpRequestErrorDetail(error: AcpErrors.AcpRequestError): string {
  const message = error.message.trim();
  const dataDetail =
    typeof error.data === "string"
      ? error.data.trim()
      : typeof error.data === "object" && error.data !== null
        ? (() => {
            const data = error.data as Record<string, unknown>;
            const detail = data.detail ?? data.details;
            return typeof detail === "string" ? detail.trim() : "";
          })()
        : "";

  if (dataDetail && /^(?:internal error(?:: agent error)?|agent error)$/iu.test(message)) {
    return dataDetail;
  }
  return message || dataDetail || "ACP request failed.";
}

export function mapAcpToAdapterError(
  provider: ProviderKind,
  _threadId: ThreadId,
  method: string,
  error: AcpErrors.AcpError,
): ProviderAdapterError {
  if (Schema.is(AcpErrors.AcpRequestError)(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: acpRequestErrorDetail(error),
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

export type AcpPermissionPolicyOutcome =
  | { readonly outcome: "selected"; readonly optionId: string }
  | { readonly outcome: "cancelled" };

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

/** Full access never blocks on a human prompt, even if an agent offers no allow option. */
export function resolveAcpFullAccessPermissionOutcome(
  options: ReadonlyArray<AcpPermissionOptionLike>,
): AcpPermissionPolicyOutcome {
  const optionId = selectAcpFullAccessPermissionOptionId(options);
  return optionId === undefined
    ? { outcome: "cancelled" }
    : { outcome: "selected", optionId };
}

/**
 * Applies Synara's turn-scoped permission precedence to ACP reverse requests.
 *
 * `interactionMode: undefined` means that no turn owns the request. Those
 * requests are cancelled so replay or late provider activity cannot inherit a
 * previous Plan turn or a future Full Access turn. Active adapters normalize
 * an omitted turn mode to `default` before dispatching the prompt.
 */
export function resolveAcpPermissionPolicy(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly options: ReadonlyArray<AcpPermissionOptionLike>;
}): AcpPermissionPolicyOutcome | undefined {
  if (input.interactionMode === "plan") {
    const optionId = selectAcpPermissionOptionId("decline", input.options);
    return optionId === undefined
      ? { outcome: "cancelled" }
      : { outcome: "selected", optionId };
  }

  if (input.interactionMode === undefined) {
    return { outcome: "cancelled" };
  }

  return input.runtimeMode === "full-access"
    ? resolveAcpFullAccessPermissionOutcome(input.options)
    : undefined;
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
