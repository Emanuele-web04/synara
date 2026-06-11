// Purpose: Turn-dispatch operations for a live Codex thread — building the
//   provider turn-input payload, starting a turn (turn/start), steering the
//   active turn (turn/steer, with a fresh-start fallback), and starting a native
//   review (review/start). Extracted from CodexAppServerManager so the class
//   stays a shell over these request builders.
// Layer: Free functions over a CodexTurnDeps surface (requireSession/sendRequest/
//   updateSession plus the steer fallback). Depends on the pure session/parsers
//   modules and contracts brands. No transport creation, no maps beyond context.
// Exports: CodexTurnDeps, sendTurn, steerTurn, startReview.
import {
  TurnId,
  type ProviderStartReviewInput,
  type ProviderTurnStartResult,
  type ThreadId,
} from "@t3tools/contracts";

import { readObject, readString, toCodexReviewTarget } from "./codexAppServer.parsers.ts";
import {
  buildCodexCollaborationMode,
  normalizeCodexModelSlug,
  readResumeThreadId,
  resolveCodexModelForAccount,
  resolveCodexTurnOverrides,
} from "./codexAppServer.session.ts";
import type {
  CodexAppServerInjectThreadItemsInput,
  CodexApprovalPolicy,
  CodexAppServerSendTurnInput,
  CodexSessionContext,
  CodexTurnSandboxPolicy,
} from "./codexAppServer.types.ts";

type CodexTurnInputItem =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "image"; url: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string };

export interface CodexTurnDeps {
  requireSession(threadId: ThreadId): CodexSessionContext;
  sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
  ): Promise<TResponse>;
  updateSession(
    context: CodexSessionContext,
    updates: Partial<CodexSessionContext["session"]>,
  ): void;
  sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult>;
}

function buildTurnInput(input: CodexAppServerSendTurnInput): CodexTurnInputItem[] {
  const turnInput: CodexTurnInputItem[] = [];
  if (input.input) {
    turnInput.push({
      type: "text",
      text: input.input,
      text_elements: [],
    });
  }
  for (const attachment of input.attachments ?? []) {
    if (attachment.type === "image") {
      turnInput.push({
        type: "image",
        url: attachment.url,
      });
    }
  }
  for (const skill of input.skills ?? []) {
    turnInput.push({
      type: "skill",
      name: skill.name,
      path: skill.path,
    });
  }
  for (const mention of input.mentions ?? []) {
    turnInput.push({
      type: "mention",
      name: mention.name,
      path: mention.path,
    });
  }
  return turnInput;
}

export async function sendTurn(
  deps: CodexTurnDeps,
  input: CodexAppServerSendTurnInput,
): Promise<ProviderTurnStartResult> {
  const context = deps.requireSession(input.threadId);
  context.collabReceiverTurns.clear();

  // Normal sends never interrupt active work. The orchestration layer decides
  // when a queued follow-up is ready to become a provider turn.
  const turnInput = buildTurnInput(input);
  if (turnInput.length === 0) {
    throw new Error("Turn input must include text or attachments.");
  }

  const providerThreadId = readResumeThreadId({
    threadId: context.session.threadId,
    runtimeMode: context.session.runtimeMode,
    resumeCursor: context.session.resumeCursor,
  });
  if (!providerThreadId) {
    throw new Error("Session is missing provider resume thread id.");
  }
  const turnStartParams: {
    threadId: string;
    input: CodexTurnInputItem[];
    model?: string;
    serviceTier?: string | null;
    effort?: string;
    approvalPolicy?: CodexApprovalPolicy;
    sandboxPolicy?: CodexTurnSandboxPolicy;
    collaborationMode?: {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string;
        developer_instructions: string;
      };
    };
  } = {
    threadId: providerThreadId,
    input: turnInput,
    ...resolveCodexTurnOverrides(context),
  };
  const normalizedModel = resolveCodexModelForAccount(
    normalizeCodexModelSlug(input.model ?? context.session.model),
    context.account,
  );
  if (normalizedModel) {
    turnStartParams.model = normalizedModel;
  }
  if (input.serviceTier !== undefined) {
    turnStartParams.serviceTier = input.serviceTier;
  }
  if (input.effort) {
    turnStartParams.effort = input.effort;
  }
  const collaborationMode = buildCodexCollaborationMode({
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
  });
  if (collaborationMode) {
    if (!turnStartParams.model) {
      turnStartParams.model = collaborationMode.settings.model;
    }
    turnStartParams.collaborationMode = collaborationMode;
  }

  const response = await deps.sendRequest(context, "turn/start", turnStartParams);
  const turnIdRaw = readString(readObject(readObject(response), "turn"), "id");
  if (!turnIdRaw) {
    throw new Error("turn/start response did not include a turn id.");
  }
  const turnId = TurnId.makeUnsafe(turnIdRaw);

  deps.updateSession(context, {
    status: "running",
    activeTurnId: turnId,
    ...(context.session.resumeCursor !== undefined
      ? { resumeCursor: context.session.resumeCursor }
      : {}),
  });

  return {
    threadId: context.session.threadId,
    turnId,
    ...(context.session.resumeCursor !== undefined
      ? { resumeCursor: context.session.resumeCursor }
      : {}),
  };
}

export async function injectThreadItems(
  deps: CodexTurnDeps,
  input: CodexAppServerInjectThreadItemsInput,
): Promise<void> {
  if (input.items.length === 0) {
    throw new Error("thread/inject_items requires at least one item.");
  }
  const context = deps.requireSession(input.threadId);
  const providerThreadId = readResumeThreadId({
    threadId: context.session.threadId,
    runtimeMode: context.session.runtimeMode,
    resumeCursor: context.session.resumeCursor,
  });
  if (!providerThreadId) {
    throw new Error("Session is missing provider resume thread id.");
  }

  await deps.sendRequest(context, "thread/inject_items", {
    threadId: providerThreadId,
    items: input.items,
  });
}

export async function steerTurn(
  deps: CodexTurnDeps,
  input: CodexAppServerSendTurnInput,
): Promise<ProviderTurnStartResult> {
  const context = deps.requireSession(input.threadId);
  context.collabReceiverTurns.clear();

  const activeTurnId = context.session.activeTurnId;
  if (context.session.status !== "running" || activeTurnId === undefined) {
    return deps.sendTurn(input);
  }

  const turnInput = buildTurnInput(input);
  if (turnInput.length === 0) {
    throw new Error("Turn input must include text or attachments.");
  }

  const providerThreadId = readResumeThreadId({
    threadId: context.session.threadId,
    runtimeMode: context.session.runtimeMode,
    resumeCursor: context.session.resumeCursor,
  });
  if (!providerThreadId) {
    throw new Error("Session is missing provider resume thread id.");
  }

  const response = await deps.sendRequest(context, "turn/steer", {
    threadId: providerThreadId,
    input: turnInput,
    expectedTurnId: activeTurnId,
  });

  const turnIdRaw = readString(readObject(response), "turnId");
  if (!turnIdRaw) {
    throw new Error("turn/steer response did not include a turn id.");
  }
  const turnId = TurnId.makeUnsafe(turnIdRaw);

  deps.updateSession(context, {
    status: "running",
    activeTurnId: turnId,
    ...(context.session.resumeCursor !== undefined
      ? { resumeCursor: context.session.resumeCursor }
      : {}),
  });

  return {
    threadId: context.session.threadId,
    turnId,
    ...(context.session.resumeCursor !== undefined
      ? { resumeCursor: context.session.resumeCursor }
      : {}),
  };
}

export async function startReview(
  deps: CodexTurnDeps,
  input: ProviderStartReviewInput,
): Promise<ProviderTurnStartResult> {
  const context = deps.requireSession(input.threadId);
  const providerThreadId = readResumeThreadId({
    threadId: context.session.threadId,
    runtimeMode: context.session.runtimeMode,
    resumeCursor: context.session.resumeCursor,
  });
  if (!providerThreadId) {
    throw new Error("Session is missing a provider resume thread id.");
  }

  const response = await deps.sendRequest(context, "review/start", {
    threadId: providerThreadId,
    delivery: "inline",
    target: toCodexReviewTarget(input.target),
  });

  const turn = readObject(readObject(response), "turn");
  const turnIdRaw = readString(turn, "id");
  if (!turnIdRaw) {
    throw new Error("review/start response did not include a turn id.");
  }
  const turnId = TurnId.makeUnsafe(turnIdRaw);
  context.reviewTurnIds.add(turnId);
  console.log("[codex-review] review/start acknowledged", {
    threadId: context.session.threadId,
    providerThreadId,
    turnId,
    target: input.target.type,
  });

  deps.updateSession(context, {
    status: "running",
    activeTurnId: turnId,
    ...(context.session.resumeCursor !== undefined
      ? { resumeCursor: context.session.resumeCursor }
      : {}),
  });

  return {
    threadId: context.session.threadId,
    turnId,
    ...(context.session.resumeCursor !== undefined
      ? { resumeCursor: context.session.resumeCursor }
      : {}),
  };
}
