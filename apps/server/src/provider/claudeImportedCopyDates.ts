import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";

import {
  findClaudeSessionTranscriptPath,
  readClaudeImportMessageDates,
} from "./claudeProjectImport.ts";

function queuedCommandSourceUuid(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== "attachment") return undefined;
  const attachment = entry.attachment;
  if (typeof attachment !== "object" || attachment === null) return undefined;
  const candidate = attachment as { type?: unknown; source_uuid?: unknown };
  return candidate.type === "queued_command" &&
    typeof candidate.source_uuid === "string" &&
    candidate.source_uuid.length > 0
    ? candidate.source_uuid
    : undefined;
}

/** Restore original message dates only inside a newly created native copy. */
export async function restoreClaudeImportedCopyDates(input: {
  readonly sourceSessionId: string;
  readonly copiedSessionId: string;
  readonly sourceMessages: ReadonlyArray<SessionMessage>;
  readonly configDir?: string;
}): Promise<void> {
  if (input.copiedSessionId === input.sourceSessionId) {
    throw new Error("The native Claude copy must have a different session ID.");
  }
  // SDK SessionMessage does not declare timestamps. Read persisted dates only
  // for the selected source and retain the SDK-selected frozen message chain.
  const sourceDates = await readClaudeImportMessageDates({
    sessionId: input.sourceSessionId,
    ...(input.configDir ? { configDir: input.configDir } : {}),
  });
  const dates = new Map<string, string>();
  for (const message of input.sourceMessages) {
    // Some SDK versions expose a timestamp beyond the public SessionMessage
    // declaration. Never substitute the time of import.
    const timestamp =
      sourceDates.get(message.uuid) ??
      (message as SessionMessage & { timestamp?: unknown }).timestamp;
    if (typeof timestamp === "string" && Number.isFinite(Date.parse(timestamp))) {
      dates.set(message.uuid, timestamp);
    }
  }
  if (dates.size === 0) return;
  const file = await findClaudeSessionTranscriptPath({
    sessionId: input.copiedSessionId,
    ...(input.configDir ? { configDir: input.configDir } : {}),
  });
  if (!file) throw new Error("The native Claude copy transcript could not be found.");
  const text = await readFile(file, "utf8");
  const matched = new Set<string>();
  let changed = false;
  const updated = text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      const entry = JSON.parse(line) as Record<string, unknown>;
      const origin = entry.forkedFrom as { sessionId?: unknown; messageUuid?: unknown } | undefined;
      if (
        entry.sessionId !== input.copiedSessionId ||
        origin?.sessionId !== input.sourceSessionId ||
        typeof origin.messageUuid !== "string"
      )
        return line;
      // The SDK materializes a queued_command attachment as a user message
      // keyed by attachment.source_uuid. When that reference names no copied
      // entry the fork preserves it verbatim on the attachment itself, so the
      // attachment carries this message's provenance instead of its own uuid.
      let timestamp = dates.get(origin.messageUuid);
      let provenanceUuid = origin.messageUuid;
      if (timestamp === undefined) {
        const queuedUuid = queuedCommandSourceUuid(entry);
        if (queuedUuid !== undefined) {
          timestamp = dates.get(queuedUuid);
          provenanceUuid = queuedUuid;
        }
      }
      if (timestamp === undefined) return line;
      matched.add(provenanceUuid);
      if (entry.timestamp === timestamp) return line;
      changed = true;
      return JSON.stringify({ ...entry, timestamp });
    })
    .join("\n");
  if (matched.size !== dates.size) {
    throw new Error("The native Claude copy did not preserve the expected message provenance.");
  }
  if (!changed) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, updated, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
