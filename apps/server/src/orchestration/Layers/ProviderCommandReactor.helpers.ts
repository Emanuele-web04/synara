// Purpose: Pure helper functions for the ProviderCommandReactor — input
//   normalization, skill-mention rewriting, status mapping, key derivation,
//   error classification, and worktree branch-name generation. None close over
//   reactor service state.
// Layer: orchestration layer support (pure functions; no service dependencies).
// Exports: see named exports below.

import {
  CommandId,
  type ChatAttachment,
  type OrchestrationSession,
  type ProviderKind,
  type ProviderSkillReference,
  ThreadId,
} from "@t3tools/contracts";
import { Cause, Schema } from "effect";
import { WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";

import { ProviderAdapterRequestError, type ProviderServiceError } from "../../provider/Errors.ts";
import type { ProviderIntentEvent } from "./ProviderCommandReactor.types.ts";

export function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Codex app-server still expects `$skill` text next to the structured skill item.
export function normalizeSkillMentionTextForProvider(input: {
  readonly provider: ProviderKind;
  readonly messageText: string;
  readonly skills?: ReadonlyArray<ProviderSkillReference>;
}): string {
  if (input.provider !== "codex" || !input.skills || input.skills.length === 0) {
    return input.messageText;
  }

  let nextText = input.messageText;
  for (const skill of input.skills) {
    const escapedName = escapeRegExp(skill.name);
    nextText = nextText.replace(
      new RegExp(`(^|\\s)/${escapedName}(?=\\s|$)`, "gi"),
      `$1$${skill.name}`,
    );
  }
  return nextText;
}

export function attachmentTitleSeed(attachment: ChatAttachment | undefined): string {
  if (!attachment) {
    return "";
  }
  if (attachment.type === "image") {
    return attachment.name;
  }
  return attachment.text.trim();
}

export function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

export const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

export const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

export const resolveSubagentProviderThreadId = (
  threadId: ThreadId,
  parentThreadId: ThreadId | null | undefined,
): string | undefined => {
  if (!parentThreadId) {
    return undefined;
  }

  const prefix = `subagent:${parentThreadId}:`;
  const rawThreadId = threadId as string;
  return rawThreadId.startsWith(prefix) ? rawThreadId.slice(prefix.length) : undefined;
};

export const editResendTurnStartKey = (threadId: ThreadId, messageId: string) =>
  `${threadId}:${messageId}`;

export function wrapSidechatInput(messageText: string, boundaryInstruction: string): string {
  return `<sidechat_boundary>\n${boundaryInstruction}\n</sidechat_boundary>\n\n<latest_user_message>\n${messageText}\n</latest_user_message>`;
}

export function isUnknownPendingApprovalRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

export function isUnknownPendingUserInputRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

export function isStaleCodexResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("thread/resume") &&
    (normalized.includes("no rollout found") ||
      normalized.includes("thread not found") ||
      normalized.includes("missing thread") ||
      normalized.includes("unknown thread"))
  );
}

export function isRollbackStillInProgressError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("rollback") &&
    (normalized.includes("turn is in progress") ||
      normalized.includes("turn in progress") ||
      normalized.includes("active turn"))
  );
}

export function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

export function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.replace(/^(synara|dpcode|t3code)\//, "");

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

export function hasDedicatedTextGenerationProvider(provider: ProviderKind | undefined): boolean {
  return (
    provider === "codex" || provider === "cursor" || provider === "kilo" || provider === "opencode"
  );
}
