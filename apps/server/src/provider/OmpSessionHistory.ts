// FILE: OmpSessionHistory.ts
// Purpose: Reads user-visible messages from Oh My Pi's local JSONL session store.
// Layer: Provider persistence compatibility
// Exports: readOmpSessionHistory and OmpSessionMessage.

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

export interface OmpSessionMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp?: string;
}

export interface OmpSessionHistory {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly lastModel?: string;
  readonly lastThinkingLevel?: string;
  readonly messages: ReadonlyArray<OmpSessionMessage>;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Prompts Synara injected while hosting a session carry the harness policy
// block; imported history should show only the user's text.
const SYNARA_HOST_CONTEXT_PATTERN = /<synara_host_context>[\s\S]*?<\/synara_host_context>/gu;

function visibleMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const record = recordValue(part);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n\n")
    .replace(SYNARA_HOST_CONTEXT_PATTERN, "")
    .trim();
}

async function findOmpSessionPath(sessionsDir: string, sessionId: string): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) return null;
  let workspaceDirs: Array<import("node:fs").Dirent>;
  try {
    workspaceDirs = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const workspaceDir of workspaceDirs) {
    if (!workspaceDir.isDirectory()) continue;
    const dirPath = nodePath.join(sessionsDir, workspaceDir.name);
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      // Session files are named `<iso-timestamp>_<sessionId>.jsonl`.
      if (entry.isFile() && entry.name.endsWith(`_${sessionId}.jsonl`)) {
        return nodePath.join(dirPath, entry.name);
      }
    }
  }
  return null;
}

// Filters tool/result and context rows so imports match the user-visible transcript.
export async function readOmpSessionHistory(
  agentDir: string,
  sessionId: string,
): Promise<OmpSessionHistory | null> {
  const normalizedSessionId = sessionId.trim();
  const path = await findOmpSessionPath(nodePath.join(agentDir, "sessions"), normalizedSessionId);
  if (!path) return null;
  const raw = await fs.readFile(path, "utf8");
  let cwd: string | undefined;
  let lastModel: string | undefined;
  let lastThinkingLevel: string | undefined;
  const messages: OmpSessionMessage[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = recordValue(JSON.parse(line));
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.type === "session" && typeof parsed.cwd === "string" && parsed.cwd.trim()) {
      cwd = parsed.cwd.trim();
      continue;
    }
    if (parsed.type === "model_change" && typeof parsed.model === "string" && parsed.model.trim()) {
      lastModel = parsed.model.trim();
      continue;
    }
    if (
      parsed.type === "thinking_level_change" &&
      typeof parsed.thinkingLevel === "string" &&
      parsed.thinkingLevel.trim()
    ) {
      lastThinkingLevel = parsed.thinkingLevel.trim();
      continue;
    }
    if (parsed.type !== "message") continue;
    const message = recordValue(parsed.message);
    if (!message) continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = visibleMessageText(message.content);
    if (!text) continue;
    const id =
      typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : `${messages.length}`;
    messages.push({
      id,
      role: message.role,
      text,
      ...(typeof parsed.timestamp === "string" && parsed.timestamp.trim()
        ? { timestamp: parsed.timestamp.trim() }
        : {}),
    });
  }
  return {
    sessionId: normalizedSessionId,
    ...(cwd ? { cwd } : {}),
    ...(lastModel ? { lastModel } : {}),
    ...(lastThinkingLevel ? { lastThinkingLevel } : {}),
    messages,
  };
}
