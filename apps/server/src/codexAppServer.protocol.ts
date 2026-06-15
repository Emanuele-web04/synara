// Purpose: Pure parsing/classification helpers for the Codex app-server stream —
//   process-line normalization, the JSON-RPC frame gate, user-visible error
//   normalization, stderr/resume-error classification, account-snapshot parsing,
//   and branded-id helpers.
// Layer: Pure functions over plain data. No process handles, no manager state,
//   no I/O. Depends only on config constants and contracts brands.
// Exports: asObject, asString, normalizeCodexProcessLine, isIgnorableCodexProcessLine,
//   isJsonObjectLine, normalizeCodexUserVisibleErrorMessage, readCodexAccountSnapshot,
//   classifyCodexStderrLine, isRecoverableThreadResumeError,
//   shouldRetrySkillsListWithCwdFallback, brandIfNonEmpty, normalizeProviderThreadId,
//   readResumeCursorThreadId, toTurnId, toProviderItemId.
import { ProviderItemId, TurnId } from "@t3tools/contracts";

import {
  ANSI_ESCAPE_REGEX,
  BENIGN_ERROR_LOG_SNIPPETS,
  BENIGN_PROCESS_OUTPUT_REGEXES,
  CODEX_SPARK_DISABLED_PLAN_TYPES,
  CODEX_STDERR_LOG_REGEX,
  RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS,
} from "./codexAppServer.config.ts";
import type { CodexAccountSnapshot, CodexPlanType } from "./codexAppServer.types.ts";

export function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function normalizeCodexProcessLine(rawLine: string): string {
  return rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
}

export function isIgnorableCodexProcessLine(rawLine: string): boolean {
  const line = normalizeCodexProcessLine(rawLine);
  if (!line) {
    return true;
  }
  return BENIGN_PROCESS_OUTPUT_REGEXES.some((pattern) => pattern.test(line));
}

// A JSON-RPC frame is a single JSON object, so its first non-whitespace byte is
// `{`. ANSI escapes are stripped first because a PTY can prefix control codes.
// Cheap structural gate, not a full parse: it only decides whether a line should
// reach `JSON.parse` at all or be treated as interleaved process/log output.
export function isJsonObjectLine(rawLine: string): boolean {
  return normalizeCodexProcessLine(rawLine).startsWith("{");
}

export function normalizeCodexUserVisibleErrorMessage(rawMessage: string): string {
  const message = normalizeCodexProcessLine(rawMessage);

  const duplicateFunctionArgMatch = message.match(
    /failed to parse function arguments: duplicate field `([^`]+)`/i,
  );
  if (duplicateFunctionArgMatch) {
    const fieldName = duplicateFunctionArgMatch[1];
    return `Tool call failed because the same argument was sent twice${fieldName ? ` (${fieldName})` : ""}.`;
  }

  return message;
}

export function readCodexAccountSnapshot(response: unknown): CodexAccountSnapshot {
  const record = asObject(response);
  const account = asObject(record?.account) ?? record;
  const accountType = asString(account?.type);

  if (accountType === "apiKey") {
    return {
      type: "apiKey",
      planType: null,
      sparkEnabled: true,
    };
  }

  if (accountType === "chatgpt") {
    const planType = (account?.planType as CodexPlanType | null) ?? "unknown";
    return {
      type: "chatgpt",
      planType,
      sparkEnabled: !CODEX_SPARK_DISABLED_PLAN_TYPES.has(planType),
    };
  }

  return {
    type: "unknown",
    planType: null,
    sparkEnabled: false,
  };
}

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  if (isIgnorableCodexProcessLine(rawLine)) {
    return null;
  }
  const line = normalizeCodexProcessLine(rawLine);

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }

    const isBenignError = BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet));
    if (isBenignError) {
      return null;
    }
  }

  return { message: normalizeCodexUserVisibleErrorMessage(line) };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread/resume")) {
    return false;
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

export function shouldRetrySkillsListWithCwdFallback(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("skills/list failed") &&
    (message.includes("invalid") ||
      message.includes("unknown field") ||
      message.includes("unrecognized field") ||
      message.includes("missing field") ||
      message.includes("expected") ||
      message.includes("cwds"))
  );
}

export function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

export function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

export function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

export function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.makeUnsafe);
}

export function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.makeUnsafe);
}
