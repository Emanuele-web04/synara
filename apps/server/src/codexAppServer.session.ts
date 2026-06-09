// Purpose: Pure builders/mappers for Codex session and turn setup — runtime-mode
//   to approval/sandbox overrides, turn-override resolution, model-slug
//   normalization and account-aware fallback, collaboration-mode settings,
//   user-input answer coercion, initialize params, scratch workspace creation,
//   and provider-option/resume-cursor reads.
// Layer: Pure functions over plain data + filesystem dir creation. No process
//   handles, no manager state, no stdio. Reads only the fields of the values
//   passed in.
// Exports: mapCodexRuntimeMode, mapCodexRuntimeModeToTurnOverrides,
//   CODEX_ALWAYS_ALLOW_SESSION_TURN_OVERRIDES, resolveCodexTurnOverrides,
//   ensureIsolatedScratchWorkspace, resolveCodexModelForAccount,
//   normalizeCodexModelSlug, buildCodexInitializeParams, buildCodexCollaborationMode,
//   toCodexUserInputAnswer, toCodexUserInputAnswers, readCodexProviderOptions,
//   readResumeThreadId.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProviderUserInputAnswers, RuntimeMode, ThreadId } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { CODEX_DEFAULT_MODEL, CODEX_SPARK_MODEL } from "./codexAppServer.config.ts";
import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "./codexAppServer.config.ts";
import { readResumeCursorThreadId } from "./codexAppServer.protocol.ts";
import type {
  CodexAccountSnapshot,
  CodexApprovalPolicy,
  CodexAppServerStartSessionInput,
  CodexSandboxMode,
  CodexSessionApprovalOverride,
  CodexSessionContext,
  CodexTurnSandboxPolicy,
  CodexUserInputAnswer,
} from "./codexAppServer.types.ts";

// Maps Synara's simple runtime toggle to Codex thread-level permission overrides.
export function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandbox: CodexSandboxMode;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
  }
}

// turn/start uses sandboxPolicy objects, so keep this separate from thread/start.
export function mapCodexRuntimeModeToTurnOverrides(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandboxPolicy: CodexTurnSandboxPolicy;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "readOnly" },
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandboxPolicy: { type: "dangerFullAccess" },
      };
  }
}

export const CODEX_ALWAYS_ALLOW_SESSION_TURN_OVERRIDES: CodexSessionApprovalOverride = {
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
};

// Synara re-sends turn-level Codex permission overrides, so keep "always allow"
// as live session state instead of relying on one native approval reply.
export function resolveCodexTurnOverrides(context: CodexSessionContext): {
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly sandboxPolicy: CodexTurnSandboxPolicy;
} {
  return (
    context.sessionApprovalOverride ??
    mapCodexRuntimeModeToTurnOverrides(context.session.runtimeMode)
  );
}

export function ensureIsolatedScratchWorkspace(threadId: ThreadId): string {
  const workspaceRoot = path.join(tmpdir(), "synara-codex-workspaces");
  const workspaceDir = path.join(workspaceRoot, String(threadId));
  mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

export function resolveCodexModelForAccount(
  model: string | undefined,
  account: CodexAccountSnapshot,
): string | undefined {
  if (model !== CODEX_SPARK_MODEL || account.sparkEnabled) {
    return model;
  }

  return CODEX_DEFAULT_MODEL;
}

export function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }

  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }

  return normalized;
}

export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "synara_desktop",
      title: "Synara Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}

export function buildCodexCollaborationMode(input: {
  readonly interactionMode?: "default" | "plan";
  readonly model?: string;
  readonly effort?: string;
}):
  | {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string;
        developer_instructions: string;
      };
    }
  | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? "gpt-5.3-codex";
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions:
        input.interactionMode === "plan"
          ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
          : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    },
  };
}

export function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
  if (typeof value === "string") {
    return { answers: [value] };
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return { answers };
  }

  if (value && typeof value === "object") {
    const maybeAnswers = (value as { answers?: unknown }).answers;
    if (Array.isArray(maybeAnswers)) {
      const answers = maybeAnswers.filter((entry): entry is string => typeof entry === "string");
      return { answers };
    }
  }

  throw new Error("User input answers must be strings or arrays of strings.");
}

export function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, CodexUserInputAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      toCodexUserInputAnswer(value),
    ]),
  );
}

export function readCodexProviderOptions(input: CodexAppServerStartSessionInput): {
  readonly binaryPath?: string;
  readonly homePath?: string;
} {
  const options = input.providerOptions?.codex;
  if (!options) {
    return {};
  }
  return {
    ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    ...(options.homePath ? { homePath: options.homePath } : {}),
  };
}

export function readResumeThreadId(input: CodexAppServerStartSessionInput): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}
