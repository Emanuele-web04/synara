/**
 * GeminiAdapter.events - Pure mappers and helpers for the Gemini provider adapter.
 *
 * Purpose: classify Gemini tool calls into canonical item/request types, extract
 * tool/content detail and text blocks, build approval outcomes, manage resume
 * cursors and stored-turn snapshots, locate/clone Gemini session files, and run
 * process-cleanup primitives. Pure functions and self-contained async fs helpers
 * (no Effect/closure-bound runtime state).
 *
 * @module GeminiAdapter.events
 */
import { type ChildProcessWithoutNullStreams, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { type CanonicalItemType, type CanonicalRequestType, TurnId } from "@t3tools/contracts";

import { asArray, asNumber, asRecord, asString, trimToUndefined } from "../geminiValue.ts";
import {
  GEMINI_CHAT_DIR_NAME,
  GEMINI_SESSION_FILE_PREFIX,
  GEMINI_TMP_DIR,
} from "./GeminiAdapter.config.ts";
import type {
  GeminiPermissionOption,
  GeminiPermissionOptionKind,
  GeminiSessionContext,
  GeminiStoredTurn,
  GeminiToolCall,
  GeminiToolCallLocation,
  GeminiToolKind,
  GeminiToolStatus,
} from "./GeminiAdapter.types.ts";

export function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message;
  }
  return fallback;
}

export function readResumeSessionId(resumeCursor: unknown): string | undefined {
  const record = asRecord(resumeCursor);
  return trimToUndefined(record?.sessionId);
}

export function resolveStartedGeminiSessionId(
  requestedResumeSessionId: string | undefined,
  startResponse: unknown,
): string | undefined {
  const resolvedSessionId = trimToUndefined(asRecord(startResponse)?.sessionId);
  return resolvedSessionId ?? requestedResumeSessionId;
}

export function cloneUnknownArray(items: ReadonlyArray<unknown>): Array<unknown> {
  return items.map((item) => {
    const record = asRecord(item);
    return record ? Object.assign({}, record) : item;
  });
}

export function cloneStoredTurn(turn: GeminiStoredTurn): GeminiStoredTurn {
  return {
    id: turn.id,
    items: cloneUnknownArray(turn.items),
    ...(turn.snapshotSessionId ? { snapshotSessionId: turn.snapshotSessionId } : {}),
    ...(turn.snapshotFilePath ? { snapshotFilePath: turn.snapshotFilePath } : {}),
  };
}

export function readResumeTurns(resumeCursor: unknown): Array<GeminiStoredTurn> {
  const record = asRecord(resumeCursor);
  return (
    asArray(record?.snapshots)?.reduce<Array<GeminiStoredTurn>>((acc, entry) => {
      const snapshot = asRecord(entry);
      const turnId = trimToUndefined(snapshot?.turnId);
      const sessionId = trimToUndefined(snapshot?.sessionId);
      const items = asArray(snapshot?.items);
      if (!turnId || !sessionId || !items) {
        return acc;
      }
      const filePath = trimToUndefined(snapshot?.filePath);
      const storedTurn = {
        id: TurnId.makeUnsafe(turnId),
        items: cloneUnknownArray(items),
        snapshotSessionId: sessionId,
      };
      acc.push(
        filePath
          ? (Object.assign(storedTurn, {
              snapshotFilePath: filePath,
            }) satisfies GeminiStoredTurn)
          : (storedTurn satisfies GeminiStoredTurn),
      );
      return acc;
    }, []) ?? []
  );
}

export function buildResumeCursor(context: GeminiSessionContext) {
  const snapshots = context.turns
    .filter((turn) => turn.snapshotSessionId)
    .map((turn) => {
      const snapshot = {
        turnId: turn.id,
        sessionId: turn.snapshotSessionId as string,
        items: cloneUnknownArray(turn.items),
      };
      return turn.snapshotFilePath
        ? Object.assign(snapshot, { filePath: turn.snapshotFilePath })
        : snapshot;
    });

  return {
    sessionId: context.sessionId,
    ...(snapshots.length > 0 ? { snapshots } : {}),
  };
}

export function isStoredGeminiSession(value: unknown): value is Record<string, unknown> & {
  sessionId: string;
  messages: Array<unknown>;
  startTime: string;
  lastUpdated: string;
} {
  const record = asRecord(value);
  return Boolean(
    trimToUndefined(record?.sessionId) &&
    asArray(record?.messages) &&
    trimToUndefined(record?.startTime) &&
    trimToUndefined(record?.lastUpdated),
  );
}

export function makeGeminiSessionFileName(sessionId: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  return `${GEMINI_SESSION_FILE_PREFIX}${timestamp}-${sessionId.slice(0, 8)}.json`;
}

export async function readStoredGeminiSession(filePath: string) {
  const content = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isStoredGeminiSession(content)) {
    throw new Error(`Invalid Gemini session file: ${filePath}`);
  }
  return content;
}

export async function findGeminiSessionFileById(
  sessionId: string,
  hintedPath?: string,
): Promise<string | undefined> {
  const prefix = sessionId.slice(0, 8);
  const candidatePaths = new Set<string>();
  if (hintedPath) {
    candidatePaths.add(hintedPath);
  }

  let projectDirs: Array<string> = [];
  try {
    projectDirs = (await fs.readdir(GEMINI_TMP_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(GEMINI_TMP_DIR, entry.name, GEMINI_CHAT_DIR_NAME));
  } catch {
    return undefined;
  }

  for (const chatsDir of projectDirs) {
    try {
      const files = await fs.readdir(chatsDir, { withFileTypes: true });
      for (const entry of files) {
        if (
          entry.isFile() &&
          entry.name.startsWith(GEMINI_SESSION_FILE_PREFIX) &&
          entry.name.endsWith(".json") &&
          entry.name.includes(prefix)
        ) {
          candidatePaths.add(path.join(chatsDir, entry.name));
        }
      }
    } catch {
      // Ignore project temp dirs without chats.
    }
  }

  for (const candidatePath of candidatePaths) {
    try {
      const storedSession = await readStoredGeminiSession(candidatePath);
      if (storedSession.sessionId === sessionId) {
        return candidatePath;
      }
    } catch {
      // Ignore unreadable or unrelated files.
    }
  }

  return undefined;
}

export async function cloneGeminiSessionFile(
  sourcePath: string,
  sessionId: string,
): Promise<string> {
  const storedSession = await readStoredGeminiSession(sourcePath);
  const nextSession = {
    ...storedSession,
    sessionId,
    lastUpdated: new Date().toISOString(),
  };
  const destinationPath = path.join(path.dirname(sourcePath), makeGeminiSessionFileName(sessionId));
  await fs.writeFile(destinationPath, `${JSON.stringify(nextSession, null, 2)}\n`, "utf8");
  return destinationPath;
}

export function itemTypeFromToolKind(kind: GeminiToolKind | undefined): CanonicalItemType {
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
      return "web_search";
    case "read":
    case "think":
    case "fetch":
    case "switch_mode":
    case "other":
    default:
      return "dynamic_tool_call";
  }
}

export function requestTypeFromToolKind(kind: GeminiToolKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "execute":
      return "command_execution_approval";
    case "edit":
    case "delete":
    case "move":
      return "file_change_approval";
    case "read":
      return "file_read_approval";
    case "search":
    case "think":
    case "fetch":
    case "switch_mode":
    case "other":
    default:
      return "dynamic_tool_call";
  }
}

export function statusFromToolStatus(
  status: GeminiToolStatus | undefined | null,
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
    case "in_progress":
      return "inProgress";
    default:
      return undefined;
  }
}

export function toolDetail(toolCall: GeminiToolCall): string | undefined {
  const location = toolCall.locations?.[0];
  if (location?.path) {
    return typeof location.line === "number" ? `${location.path}:${location.line}` : location.path;
  }
  return undefined;
}

export function isAskUserToolCall(toolCall: GeminiToolCall | undefined): boolean {
  return trimToUndefined(toolCall?.title)?.toLowerCase() === "ask user";
}

export function textFromContentBlock(value: unknown): string | undefined {
  const block = asRecord(value);
  const type = asString(block?.type);
  if (type === "text") {
    return asString(block?.text);
  }
  if (type === "resource") {
    return asString(asRecord(block?.resource)?.text);
  }
  return undefined;
}

export function toolContentDetail(
  content: ReadonlyArray<unknown> | undefined | null,
): string | undefined {
  if (!content) {
    return undefined;
  }

  for (const entry of content) {
    const record = asRecord(entry);
    const type = asString(record?.type);
    if (type === "content") {
      const text = textFromContentBlock(record?.content);
      if (text?.trim()) {
        return text.trim();
      }
    }
    if (type === "diff") {
      const path = trimToUndefined(record?.path);
      const kind = trimToUndefined(asRecord(record?._meta)?.kind);
      return [kind, path].filter(Boolean).join(" ").trim() || "File diff";
    }
    if (type === "terminal") {
      const terminalId = trimToUndefined(record?.terminalId);
      return terminalId ? `Terminal ${terminalId}` : "Terminal output";
    }
  }

  return undefined;
}

export function makeApprovalOutcome(
  decision: "accept" | "acceptForSession" | "decline" | "cancel",
  options: ReadonlyArray<GeminiPermissionOption>,
): { outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } } {
  if (decision === "cancel") {
    return { outcome: { outcome: "cancelled" } };
  }

  const pick = (...kinds: ReadonlyArray<GeminiPermissionOptionKind>) =>
    options.find((option) => kinds.includes(option.kind));

  const selected =
    decision === "acceptForSession"
      ? pick("allow_always", "allow_once")
      : decision === "accept"
        ? pick("allow_once", "allow_always")
        : pick("reject_once", "reject_always");

  if (!selected) {
    return { outcome: { outcome: "cancelled" } };
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId,
    },
  };
}

export function killChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall back to direct kill below.
    }
  }

  child.kill("SIGTERM");
}

export function releaseProcessResources(context: GeminiSessionContext): void {
  context.stdout.removeAllListeners();
  context.stderr.removeAllListeners();
  context.child.removeAllListeners("exit");
  context.child.removeAllListeners("error");
  if (context.systemSettingsPath) {
    void fs.unlink(context.systemSettingsPath).catch(() => {
      // Ignore already deleted temporary settings files.
    });
    context.systemSettingsPath = undefined;
  }
  try {
    context.stdout.close();
  } catch {
    // Ignore already closed interfaces.
  }
  try {
    context.stderr.close();
  } catch {
    // Ignore already closed interfaces.
  }
}

export function parsePermissionOptions(value: unknown): ReadonlyArray<GeminiPermissionOption> {
  return (
    asArray(value)
      ?.map((entry) => {
        const record = asRecord(entry);
        const optionId = trimToUndefined(record?.optionId);
        const name = trimToUndefined(record?.name);
        const kind = trimToUndefined(record?.kind) as GeminiPermissionOptionKind | undefined;
        if (!optionId || !name || !kind) {
          return null;
        }
        return { optionId, name, kind } satisfies GeminiPermissionOption;
      })
      .filter((entry): entry is GeminiPermissionOption => entry !== null) ?? []
  );
}

export function parseToolCall(value: unknown): GeminiToolCall | undefined {
  const record = asRecord(value);
  const toolCallId = trimToUndefined(record?.toolCallId);
  if (!toolCallId) {
    return undefined;
  }

  return {
    toolCallId,
    title: trimToUndefined(record?.title) ?? null,
    kind: (trimToUndefined(record?.kind) as GeminiToolKind | undefined) ?? null,
    status: (trimToUndefined(record?.status) as GeminiToolStatus | undefined) ?? null,
    content: asArray(record?.content) ?? null,
    locations:
      asArray(record?.locations)?.reduce<Array<GeminiToolCallLocation>>((acc, entry) => {
        const location = asRecord(entry);
        const path = trimToUndefined(location?.path);
        if (!path) {
          return acc;
        }
        acc.push({
          path,
          line: asNumber(location?.line) ?? null,
        });
        return acc;
      }, []) ?? null,
    rawInput: record?.rawInput,
    rawOutput: record?.rawOutput,
  };
}
