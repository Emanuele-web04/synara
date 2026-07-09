// FILE: FactorySessionHistory.ts
// Purpose: Reads user-visible messages from Factory Droid's local JSONL session store.
// Layer: Provider persistence compatibility
// Exports: readFactorySessionHistory and FactorySessionMessage.

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

export interface FactorySessionMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly timestamp?: string;
}

export interface FactorySessionHistory {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly messages: ReadonlyArray<FactorySessionMessage>;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function visibleMessageText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      const record = recordValue(part);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    })
    .join("\n\n")
    .trim();
}

async function findFactorySessionPath(
  sessionsDir: string,
  sessionId: string,
): Promise<string | null> {
  if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) return null;
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = nodePath.join(sessionsDir, entry.name, `${sessionId}.jsonl`);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue through the bounded set of workspace session directories.
    }
  }
  return null;
}

// Filters llm-only/user-only bookkeeping rows so imports match Droid's visible transcript.
export async function readFactorySessionHistory(
  homeDir: string,
  sessionId: string,
): Promise<FactorySessionHistory | null> {
  const normalizedSessionId = sessionId.trim();
  const path = await findFactorySessionPath(
    nodePath.join(homeDir, ".factory", "sessions"),
    normalizedSessionId,
  );
  if (!path) return null;
  const raw = await fs.readFile(path, "utf8");
  let cwd: string | undefined;
  const messages: FactorySessionMessage[] = [];
  for (const line of raw.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = recordValue(JSON.parse(line));
    } catch {
      continue;
    }
    if (!parsed) continue;
    if (parsed.type === "session_start" && typeof parsed.cwd === "string" && parsed.cwd.trim()) {
      cwd = parsed.cwd.trim();
      continue;
    }
    if (parsed.type !== "message") continue;
    const message = recordValue(parsed.message);
    if (!message || (message.visibility !== undefined && message.visibility !== null)) continue;
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
    messages,
  };
}
