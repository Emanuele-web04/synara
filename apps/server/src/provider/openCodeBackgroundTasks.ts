import type { Part } from "@opencode-ai/sdk/v2";

export type OpenCodeToolPart = Extract<Part, { type: "tool" }>;

export interface OpenCodeBackgroundTaskStart {
  readonly taskId: string;
  readonly childSessionId: string | null;
  readonly description: string | undefined;
  readonly subagentType: string | undefined;
  readonly source: "native-task" | "delegate-plugin";
}

export interface OpenCodeBackgroundTaskSettlement {
  readonly taskId: string;
  readonly status: "completed" | "failed";
  readonly summary: string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toolOutputText(part: OpenCodeToolPart): string | undefined {
  const state = asRecord(part.state);
  return nonEmptyString(state?.output);
}

const DELEGATION_STARTED_REGEX = /Delegation started:\s*([A-Za-z0-9_.:-]+)/;
const DELEGATION_DESCRIPTION_MAX_LENGTH = 120;

function firstLine(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const line = value.split("\n", 1)[0]?.trim();
  if (!line) {
    return undefined;
  }
  return line.length > DELEGATION_DESCRIPTION_MAX_LENGTH
    ? line.slice(0, DELEGATION_DESCRIPTION_MAX_LENGTH)
    : line;
}

export function detectOpenCodeBackgroundTaskStart(
  part: OpenCodeToolPart,
): OpenCodeBackgroundTaskStart | null {
  const state = asRecord(part.state);
  if (state?.status !== "completed") {
    return null;
  }
  const toolName = typeof part.tool === "string" ? part.tool.trim().toLowerCase() : "";
  const input = asRecord(state.input);

  if (toolName === "task") {
    const metadata = asRecord(state.metadata) ?? asRecord(part.metadata);
    if (metadata?.background !== true) {
      return null;
    }
    const childSessionId = nonEmptyString(metadata.sessionId) ?? nonEmptyString(metadata.sessionID);
    const taskId = nonEmptyString(metadata.jobId) ?? childSessionId;
    if (!taskId) {
      return null;
    }
    return {
      taskId,
      childSessionId: childSessionId ?? null,
      description: nonEmptyString(state.title) ?? nonEmptyString(input?.description),
      subagentType: nonEmptyString(input?.subagent_type),
      source: "native-task",
    };
  }

  if (toolName === "delegate") {
    const delegationId = DELEGATION_STARTED_REGEX.exec(toolOutputText(part) ?? "")?.[1];
    if (!delegationId) {
      return null;
    }
    return {
      taskId: delegationId,
      childSessionId: null,
      description: firstLine(nonEmptyString(input?.prompt)),
      subagentType: nonEmptyString(input?.agent),
      source: "delegate-plugin",
    };
  }

  return null;
}

const TASK_TAG_REGEX = /<task\b([^>]*)>/gi;
const TAG_ID_REGEX = /\bid\s*=\s*"([^"]+)"/i;
const TAG_STATE_REGEX = /\bstate\s*=\s*"([^"]+)"/i;
const SUMMARY_REGEX = /<summary>([\s\S]*?)(?:<\/summary>|$)/i;
const TASK_NOTIFICATION_REGEX = /<task-notification>([\s\S]*?)(?:<\/task-notification>|$)/i;
const DELEGATION_ID_REGEX = /(?:delegation[_ ]?id|\bid)\s*[:=]?\s*"?'?([A-Za-z0-9_.:-]+)/i;
const NOTIFICATION_FAILED_REGEX = /(error|fail|timeout|cancel)/i;

function detectNativeSettlement(text: string): OpenCodeBackgroundTaskSettlement | null {
  TASK_TAG_REGEX.lastIndex = 0;
  for (const match of text.matchAll(TASK_TAG_REGEX)) {
    const attributes = match[1] ?? "";
    const taskId = TAG_ID_REGEX.exec(attributes)?.[1];
    const state = TAG_STATE_REGEX.exec(attributes)?.[1]?.toLowerCase();
    if (!taskId || (state !== "completed" && state !== "error" && state !== "failed")) {
      continue;
    }
    const summary = SUMMARY_REGEX.exec(text.slice((match.index ?? 0) + match[0].length))?.[1];
    return {
      taskId,
      status: state === "completed" ? "completed" : "failed",
      summary: nonEmptyString(summary),
    };
  }
  return null;
}

function detectPluginSettlement(text: string): OpenCodeBackgroundTaskSettlement | null {
  const body = TASK_NOTIFICATION_REGEX.exec(text)?.[1];
  if (body === undefined) {
    return null;
  }
  const taskId = DELEGATION_ID_REGEX.exec(body)?.[1];
  if (!taskId) {
    return null;
  }
  // A task-notification marks the end of a delegation; default to completed
  // unless the body reads as a failure.
  const status = NOTIFICATION_FAILED_REGEX.test(body) ? "failed" : "completed";
  return { taskId, status, summary: undefined };
}

export function detectOpenCodeBackgroundTaskSettlement(
  text: string,
): OpenCodeBackgroundTaskSettlement | null {
  return detectNativeSettlement(text) ?? detectPluginSettlement(text);
}
