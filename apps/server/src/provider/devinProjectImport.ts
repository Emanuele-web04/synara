// FILE: provider/devinProjectImport.ts
// Purpose: Discover Devin CLI/Desktop conversations for project import and read
// one conversation's visible transcript as importable messages. Reads the local
// session store only; it never starts Devin, resumes a session, or sends a turn.
// Layer: Provider history import.
// Exports: discoverDevinProjects, readDevinImportHistory.

import * as crypto from "node:crypto";
import path from "node:path";

import { MessageId, type ThreadHandoffImportedMessage } from "@synara/contracts";

import {
  defaultDevinStorePath,
  listDevinSessions,
  readDevinSession,
} from "./devinSessionHistory.ts";
import type { NativeProjectImportCatalog } from "./projectImportTypes.ts";

// Prompts Synara injected while hosting a session carry this policy block;
// imported history shows only the user's own text.
const SYNARA_HOST_CONTEXT_PATTERN = /<synara_host_context>[\s\S]*?<\/synara_host_context>/gu;

export interface DevinProjectImportInput {
  /** Test override for the store path; defaults to the platform's Devin data dir. */
  readonly dbPath?: string;
}

/**
 * Group the store's sessions into import projects the way the other providers
 * are grouped: one project per working directory, sessions newest first.
 */
export async function discoverDevinProjects(
  input: DevinProjectImportInput = {},
): Promise<NativeProjectImportCatalog> {
  const sourceHome = input.dbPath ?? defaultDevinStorePath();
  const rows = await listDevinSessions({ dbPath: sourceHome });
  const projects = new Map<string, NativeProjectImportCatalog["projects"][number]>();
  const sessions: Array<NativeProjectImportCatalog["sessions"][number]> = [];
  for (const row of rows) {
    if (!path.isAbsolute(row.workingDirectory)) continue;
    const cwd = path.normalize(row.workingDirectory);
    const updatedAt = row.lastActivityAt ?? row.createdAt;
    if (updatedAt === null) continue;
    const title = row.title?.trim() || path.basename(cwd) || cwd;
    projects.set(cwd, { id: cwd, title: path.basename(cwd) || cwd, roots: [cwd] });
    sessions.push({
      id: row.sessionId,
      title,
      cwd,
      projectId: cwd,
      createdAt: row.createdAt ?? updatedAt,
      updatedAt,
      archived: false,
    });
  }
  return {
    sourceHome,
    projects: [...projects.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
    sessions,
  };
}

export interface DevinImportHistoryPage {
  readonly messages: ReadonlyArray<ThreadHandoffImportedMessage>;
  readonly nextCursor: string | null;
}

/**
 * Visible transcript of one Devin session as import messages. The store holds
 * the whole local conversation, so one page is complete and there is no older
 * cursor to page back to.
 */
export async function readDevinImportHistory(
  input: DevinProjectImportInput & {
    readonly sessionId: string;
    readonly importedAt: string;
  },
): Promise<DevinImportHistoryPage> {
  const { messages: nodes } = await readDevinSession({
    ...(input.dbPath ? { dbPath: input.dbPath } : {}),
    sessionId: input.sessionId,
  });
  const seen = new Set<string>();
  const messages: Array<ThreadHandoffImportedMessage> = [];
  for (const node of nodes) {
    const text =
      node.role === "assistant"
        ? node.content
        : node.role === "user" && node.isUserInput
          ? node.content.replace(SYNARA_HOST_CONTEXT_PATTERN, "").trim()
          : "";
    if (text.trim().length === 0) continue;
    // Resumed Devin sessions re-materialize some messages as sibling nodes.
    const upstreamId = node.messageId ?? `node-${node.nodeId}`;
    if (seen.has(upstreamId)) continue;
    seen.add(upstreamId);
    const createdAt = node.createdAt ?? input.importedAt;
    messages.push({
      // Stable per (session, upstream message) so a retried import replays the
      // same identities instead of appending a second copy.
      messageId: MessageId.makeUnsafe(
        `devin-import-${crypto.createHash("sha256").update(`${input.sessionId}:${upstreamId}`).digest("hex").slice(0, 32)}`,
      ),
      role: node.role === "user" ? "user" : "assistant",
      text,
      createdAt,
      updatedAt: createdAt,
    });
  }
  return { messages, nextCursor: null };
}
