// FILE: providerHistory/devinLocalHistory.ts
// Purpose: Read-only catalog and transcript reader for the Devin CLI/Desktop
// session store (~/.local/share/devin/cli/sessions.db, WAL mode). Never writes,
// never starts a session, never sends prompts. Layer: Provider history import.
// Exports: listDevinLocalSessions, readDevinLocalSession,
// defaultDevinLocalStorePath, DevinLocalSessionRow, DevinLocalRawMessage.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { ProviderHistoryError } from "@synara/contracts";

const OPERATION = "DevinLocalHistory";

// Loaded dynamically so bundlers don't try to resolve the runtime-only
// "bun:sqlite" specifier (same pattern as providerUsage/sqlite.ts).
const importRuntimeModule = (specifier: string): Promise<unknown> =>
  Function("specifier", "return import(specifier)")(specifier) as Promise<unknown>;

interface ReadonlyStatement {
  get: (...params: ReadonlyArray<unknown>) => unknown;
  all: (...params: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;
}

interface ReadonlyDatabase {
  query?: (sql: string) => ReadonlyStatement; // bun:sqlite
  prepare?: (sql: string) => ReadonlyStatement; // node:sqlite
  close: () => unknown;
}

async function openReadOnlyDatabase(dbPath: string): Promise<ReadonlyDatabase> {
  if (process.versions.bun !== undefined) {
    const { Database } = (await importRuntimeModule("bun:sqlite")) as {
      Database: new (path: string, options: { readonly: boolean }) => ReadonlyDatabase;
    };
    return new Database(dbPath, { readonly: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true }) as unknown as ReadonlyDatabase;
}

function fail(
  code: ProviderHistoryError["code"],
  detail: string,
  retryable: boolean,
  cause?: unknown,
): never {
  throw new ProviderHistoryError({ operation: OPERATION, code, detail, retryable, cause });
}

function isBusyError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.message.includes("SQLITE_BUSY") ||
      ("code" in cause && (cause as { code?: unknown }).code === "SQLITE_BUSY"))
  );
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Devin stores epoch seconds in sessions/message_nodes. */
function epochSecondsToIso(value: unknown): string | null {
  const seconds = asNumber(value);
  return seconds === null ? null : new Date(seconds * 1000).toISOString();
}

export function defaultDevinLocalStorePath(): string {
  return path.join(os.homedir(), ".local", "share", "devin", "cli", "sessions.db");
}

export interface DevinLocalSessionRow {
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly backendType: string;
  readonly model: string;
  readonly agentMode: string;
  readonly createdAt: string | null;
  readonly lastActivityAt: string | null;
  readonly title: string | null;
  readonly mainChainId: number | null;
  readonly hidden: boolean;
  readonly workspaceDirs: ReadonlyArray<string>;
}

export interface DevinLocalRawMessage {
  readonly nodeId: number;
  readonly messageId: string | null;
  readonly role: string;
  readonly content: string;
  readonly isUserInput: boolean;
  readonly createdAt: string | null;
}

const REQUIRED_SESSION_COLUMNS = [
  "id",
  "working_directory",
  "backend_type",
  "model",
  "agent_mode",
  "created_at",
  "last_activity_at",
  "title",
  "main_chain_id",
  "hidden",
] as const;

const REQUIRED_NODE_COLUMNS = [
  "session_id",
  "node_id",
  "parent_node_id",
  "chat_message",
  "created_at",
] as const;

function requireColumns(
  database: ReadonlyDatabase,
  table: string,
  required: ReadonlyArray<string>,
): void {
  const columns = new Set(
    (database
      .prepare?.(`PRAGMA table_info(${table})`)
      ?.all()
      .map((row) => (row as { name?: unknown }).name) ?? []) as unknown[],
  );
  if (required.some((name) => !columns.has(name))) {
    fail(
      "unsupported-version",
      `Devin store is missing expected ${table} columns (${required.join(", ")}).`,
      false,
    );
  }
}

function statement(database: ReadonlyDatabase, sql: string): ReadonlyStatement {
  const prepared = database.prepare?.(sql) ?? database.query?.(sql);
  if (!prepared) {
    fail("unsupported-version", "SQLite reader is unavailable on this runtime.", false);
  }
  return prepared;
}

function parseWorkspaceDirs(raw: unknown): ReadonlyArray<string> {
  const text = asText(raw);
  if (text === null) return [];
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * List all sessions in the local store (all workspaces). The `devin list`
 * binary only covers the current directory, so the store is the only
 * all-workspace catalog — read-only, as the PRD requires.
 */
export async function listDevinLocalSessions(input: {
  dbPath?: string;
  includeHidden?: boolean;
}): Promise<ReadonlyArray<DevinLocalSessionRow>> {
  const dbPath = input.dbPath ?? defaultDevinLocalStorePath();
  try {
    await fs.access(dbPath);
  } catch {
    fail("not-found", `Devin session store does not exist: ${dbPath}`, false);
  }
  let database: ReadonlyDatabase | null = null;
  try {
    database = await openReadOnlyDatabase(dbPath);
    requireColumns(database, "sessions", REQUIRED_SESSION_COLUMNS);
    requireColumns(database, "message_nodes", ["session_id"]);
    const rows = statement(
      database,
      `SELECT id, working_directory, backend_type, model, agent_mode,
              created_at, last_activity_at, title, main_chain_id, hidden,
              workspace_dirs
         FROM sessions
         ORDER BY last_activity_at DESC, id ASC`,
    ).all();
    return rows.flatMap((raw): ReadonlyArray<DevinLocalSessionRow> => {
      const row = raw as Record<string, unknown>;
      const sessionId = asText(row.id);
      const workingDirectory = asText(row.working_directory);
      if (sessionId === null || workingDirectory === null) return [];
      const hidden = asNumber(row.hidden) === 1;
      if (hidden && input.includeHidden !== true) return [];
      return [
        {
          sessionId,
          workingDirectory,
          backendType: asText(row.backend_type) ?? "unknown",
          model: asText(row.model) ?? "unknown",
          agentMode: asText(row.agent_mode) ?? "unknown",
          createdAt: epochSecondsToIso(row.created_at),
          lastActivityAt: epochSecondsToIso(row.last_activity_at),
          title: asText(row.title),
          mainChainId: asNumber(row.main_chain_id),
          hidden,
          workspaceDirs: parseWorkspaceDirs(row.workspace_dirs),
        },
      ];
    });
  } catch (error) {
    if (error instanceof ProviderHistoryError) throw error;
    if (isBusyError(error)) {
      return fail("busy", `Devin session store is locked by a live write: ${dbPath}`, true, error);
    }
    return fail("read-failed", `Failed to read Devin session store at ${dbPath}`, false, error);
  } finally {
    try {
      database?.close();
    } catch {
      // ignore close failures
    }
  }
}

interface RawNode {
  readonly nodeId: number;
  readonly parentNodeId: number | null;
  readonly messageId: string | null;
  readonly role: string;
  readonly content: string;
  readonly isUserInput: boolean;
  readonly createdAt: string | null;
}

function parseChatMessage(raw: unknown): {
  messageId: string | null;
  role: string;
  content: string;
  isUserInput: boolean;
  createdAt: string | null;
} | null {
  const text = asText(raw);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const metadata =
      record.metadata !== null && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : {};
    return {
      messageId: asText(record.message_id),
      role: asText(record.role) ?? "unknown",
      content: typeof record.content === "string" ? record.content : "",
      isUserInput: metadata.is_user_input === true || metadata.is_user_input === 1,
      createdAt: asText(metadata.created_at),
    };
  } catch {
    return null;
  }
}

/**
 * Read one session's transcript. The store is a forest of chains; the visible
 * history is the ancestor path of `main_chain_id` (falling back to the tip
 * with the highest node_id when the pointer is missing). Sibling nodes with
 * duplicate message_ids (the store re-materializes some messages on resume)
 * are deduplicated by the caller-visible contract, so only the chain path is
 * returned.
 */
export async function readDevinLocalSession(input: {
  dbPath?: string;
  sessionId: string;
}): Promise<{
  session: DevinLocalSessionRow;
  messages: ReadonlyArray<DevinLocalRawMessage>;
}> {
  const dbPath = input.dbPath ?? defaultDevinLocalStorePath();
  try {
    await fs.access(dbPath);
  } catch {
    fail("not-found", `Devin session store does not exist: ${dbPath}`, false);
  }
  let database: ReadonlyDatabase | null = null;
  try {
    database = await openReadOnlyDatabase(dbPath);
    requireColumns(database, "sessions", REQUIRED_SESSION_COLUMNS);
    requireColumns(database, "message_nodes", REQUIRED_NODE_COLUMNS);

    const sessionRow = statement(
      database,
      `SELECT id, working_directory, backend_type, model, agent_mode,
              created_at, last_activity_at, title, main_chain_id, hidden,
              workspace_dirs
         FROM sessions WHERE id = ?`,
    ).get(input.sessionId) as Record<string, unknown> | null | undefined;
    if (sessionRow === null || sessionRow === undefined) {
      fail("not-found", `Devin session ${input.sessionId} is not in ${dbPath}`, false);
    }
    const session: DevinLocalSessionRow = {
      sessionId: input.sessionId,
      workingDirectory: asText(sessionRow.working_directory) ?? "",
      backendType: asText(sessionRow.backend_type) ?? "unknown",
      model: asText(sessionRow.model) ?? "unknown",
      agentMode: asText(sessionRow.agent_mode) ?? "unknown",
      createdAt: epochSecondsToIso(sessionRow.created_at),
      lastActivityAt: epochSecondsToIso(sessionRow.last_activity_at),
      title: asText(sessionRow.title),
      mainChainId: asNumber(sessionRow.main_chain_id),
      hidden: asNumber(sessionRow.hidden) === 1,
      workspaceDirs: parseWorkspaceDirs(sessionRow.workspace_dirs),
    };

    const nodeRows = statement(
      database,
      `SELECT node_id, parent_node_id, chat_message, created_at
         FROM message_nodes WHERE session_id = ? ORDER BY node_id ASC`,
    ).all(input.sessionId);

    const nodes = new Map<number, RawNode>();
    for (const raw of nodeRows) {
      const row = raw as Record<string, unknown>;
      const nodeId = asNumber(row.node_id);
      if (nodeId === null) continue;
      const parsed = parseChatMessage(row.chat_message);
      if (parsed === null) continue;
      nodes.set(nodeId, {
        nodeId,
        parentNodeId: asNumber(row.parent_node_id),
        messageId: parsed.messageId,
        role: parsed.role,
        content: parsed.content,
        isUserInput: parsed.isUserInput,
        createdAt: parsed.createdAt ?? epochSecondsToIso(row.created_at),
      });
    }
    if (nodes.size === 0) {
      return { session, messages: [] };
    }

    // Chain tip: the stored main_chain_id when it exists and resolves, else
    // the highest node_id in the forest.
    const tip =
      session.mainChainId !== null && nodes.has(session.mainChainId)
        ? session.mainChainId
        : Math.max(...nodes.keys());

    const chain: Array<RawNode> = [];
    const seen = new Set<number>();
    for (let cursor: number | null = tip; cursor !== null; ) {
      const node = nodes.get(cursor);
      if (node === undefined || seen.has(cursor)) break;
      seen.add(cursor);
      chain.push(node);
      cursor = node.parentNodeId;
    }
    chain.reverse();
    return { session, messages: chain };
  } catch (error) {
    if (error instanceof ProviderHistoryError) throw error;
    if (isBusyError(error)) {
      return fail("busy", `Devin session store is locked by a live write: ${dbPath}`, true, error);
    }
    return fail("read-failed", `Failed to read Devin session store at ${dbPath}`, false, error);
  } finally {
    try {
      database?.close();
    } catch {
      // ignore close failures
    }
  }
}
