// FILE: provider/devinSessionHistory.ts
// Purpose: Read-only access to the Devin CLI/Desktop session store
// (devin/cli/sessions.db, SQLite). Never writes to the database or starts
// Devin. SQLite can access adjacent WAL and shared-memory files.
// Exports: defaultDevinStorePath, listDevinSessions, readDevinSession,
// DevinSessionRow, DevinSessionMessage.

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

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
  exec: (sql: string) => unknown;
  close: () => unknown;
}

async function openBunDatabase(dbPath: string, readonly: boolean): Promise<ReadonlyDatabase> {
  const { Database } = (await importRuntimeModule("bun:sqlite")) as {
    Database: new (path: string, options: { readonly: boolean }) => ReadonlyDatabase;
  };
  return new Database(dbPath, { readonly });
}

async function openReadOnlyDatabase(dbPath: string): Promise<ReadonlyDatabase> {
  if (process.versions.bun !== undefined) {
    return openBunDatabase(dbPath, true);
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true }) as unknown as ReadonlyDatabase;
}

/** Errors this reader raises with a message meant for the user. */
class DevinStoreError extends Error {}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Devin stores epoch seconds in sessions/message_nodes. */
function epochSecondsToIso(value: unknown): string | null {
  const seconds = asNumber(value);
  if (seconds === null) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** The store path an account with this launch environment writes to. */
export function devinStorePathForEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = environment.HOME?.trim() || environment.USERPROFILE?.trim() || os.homedir();
  const dataHome =
    platform === "win32"
      ? environment.LOCALAPPDATA?.trim() || home
      : environment.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  return path.join(dataHome, "devin", "cli", "sessions.db");
}

export function defaultDevinStorePath(): string {
  return devinStorePathForEnvironment(process.env);
}

export interface DevinSessionRow {
  readonly sessionId: string;
  readonly workingDirectory: string;
  readonly createdAt: string | null;
  readonly lastActivityAt: string | null;
  readonly title: string | null;
  readonly mainChainId: number | null;
  readonly hidden: boolean;
}

export interface DevinSessionMessage {
  readonly nodeId: number;
  readonly messageId: string | null;
  readonly role: string;
  readonly content: string;
  readonly isUserInput: boolean;
  readonly createdAt: string | null;
}

const SESSION_COLUMNS = [
  "id",
  "working_directory",
  "created_at",
  "last_activity_at",
  "title",
  "main_chain_id",
  "hidden",
] as const;

const SESSION_SELECT = `SELECT id, working_directory, created_at, last_activity_at,
              title, main_chain_id, hidden FROM sessions`;

function requireColumns(
  database: ReadonlyDatabase,
  table: string,
  required: ReadonlyArray<string>,
): void {
  const columns = new Set(
    statement(database, `PRAGMA table_info(${table})`)
      .all()
      .map((row) => (row as { name?: unknown }).name),
  );
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    throw new DevinStoreError(
      `This Devin version stores ${table} differently (missing ${missing.join(", ")}); its history cannot be imported.`,
    );
  }
}

function statement(database: ReadonlyDatabase, sql: string): ReadonlyStatement {
  const prepared = database.prepare?.(sql) ?? database.query?.(sql);
  if (!prepared) throw new DevinStoreError("SQLite reader is unavailable on this runtime.");
  return prepared;
}

function sessionRow(raw: unknown): DevinSessionRow | null {
  const row = raw as Record<string, unknown> | null | undefined;
  const sessionId = asText(row?.id);
  const workingDirectory = asText(row?.working_directory);
  if (sessionId === null || workingDirectory === null) return null;
  return {
    sessionId,
    workingDirectory,
    createdAt: epochSecondsToIso(row?.created_at),
    lastActivityAt: epochSecondsToIso(row?.last_activity_at),
    title: asText(row?.title),
    mainChainId: asNumber(row?.main_chain_id),
    hidden: asNumber(row?.hidden) === 1,
  };
}

function describeStoreFailure(error: unknown, dbPath: string): DevinStoreError {
  const busy =
    error instanceof Error &&
    (error.message.includes("SQLITE_BUSY") ||
      ("code" in error && (error as { code?: unknown }).code === "SQLITE_BUSY"));
  return new DevinStoreError(
    busy
      ? `The Devin session store is locked by a running Devin session: ${dbPath}`
      : `The Devin session store could not be read: ${dbPath}`,
  );
}

function readStore<A>(database: ReadonlyDatabase, run: (database: ReadonlyDatabase) => A): A {
  try {
    // Keep the session pointer and the message chain in the same read snapshot.
    database.exec("BEGIN");
    requireColumns(database, "sessions", SESSION_COLUMNS);
    requireColumns(database, "message_nodes", ["session_id"]);
    return run(database);
  } finally {
    database.close();
  }
}

async function hasSidecar(dbPath: string): Promise<boolean> {
  const files = await Promise.all(
    ["-wal", "-shm"].map(async (suffix) => {
      try {
        await fs.lstat(dbPath + suffix);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return false;
      }
    }),
  );
  return files.some(Boolean);
}

async function readCheckpointedBunStore<A>(
  dbPath: string,
  run: (database: ReadonlyDatabase) => A,
  originalError: unknown,
): Promise<A> {
  // Apple's SQLite can reject a read-only WAL database after a clean close
  // (oven-sh/bun#45171). Never copy an active WAL or open the source for writes.
  const before = await fs.stat(dbPath, { bigint: true });
  if (!before.isFile() || (await hasSidecar(dbPath))) throw originalError;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-devin-import-"));
  try {
    const copy = path.join(directory, "sessions.db");
    await fs.copyFile(dbPath, copy);
    const sidecar = await hasSidecar(dbPath);
    const after = await fs.stat(dbPath, { bigint: true });
    if (
      sidecar ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw originalError;
    }
    const database = await openBunDatabase(copy, false);
    return readStore(database, run);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function withStore<A>(dbPath: string, run: (database: ReadonlyDatabase) => A): Promise<A> {
  try {
    return readStore(await openReadOnlyDatabase(dbPath), run);
  } catch (error) {
    if (error instanceof DevinStoreError) throw error;
    try {
      await fs.stat(dbPath);
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code === "ENOENT") {
        throw new DevinStoreError(`No Devin session store on this machine: ${dbPath}`);
      }
    }
    if (
      process.platform === "darwin" &&
      process.versions.bun !== undefined &&
      (error as NodeJS.ErrnoException).code === "SQLITE_CANTOPEN"
    ) {
      try {
        return await readCheckpointedBunStore(dbPath, run, error);
      } catch (fallbackError) {
        if (fallbackError instanceof DevinStoreError) throw fallbackError;
        throw describeStoreFailure(fallbackError, dbPath);
      }
    }
    throw describeStoreFailure(error, dbPath);
  }
}

/** Every session in the store, newest activity first, hidden sessions excluded. */
export async function listDevinSessions(
  input: { dbPath?: string } = {},
): Promise<ReadonlyArray<DevinSessionRow>> {
  const dbPath = input.dbPath ?? defaultDevinStorePath();
  return withStore(dbPath, (database) =>
    statement(database, `${SESSION_SELECT} ORDER BY last_activity_at DESC, id ASC`)
      .all()
      .flatMap((raw) => {
        const row = sessionRow(raw);
        return row !== null && !row.hidden ? [row] : [];
      }),
  );
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
 * One session's visible transcript. The store is a forest of chains; the
 * visible history is the ancestor path of `main_chain_id`, falling back to the
 * highest node id when that pointer is missing.
 */
export async function readDevinSession(input: {
  dbPath?: string;
  sessionId: string;
}): Promise<{ session: DevinSessionRow; messages: ReadonlyArray<DevinSessionMessage> }> {
  const dbPath = input.dbPath ?? defaultDevinStorePath();
  return withStore(dbPath, (database) => {
    const session = sessionRow(
      statement(database, `${SESSION_SELECT} WHERE id = ?`).get(input.sessionId),
    );
    if (session === null) {
      throw new Error(`Devin session ${input.sessionId} was not found in ${dbPath}`);
    }

    const nodes = new Map<
      number,
      {
        nodeId: number;
        parentNodeId: number | null;
        message: ReturnType<typeof parseChatMessage>;
        fallbackCreatedAt: string | null;
      }
    >();
    for (const raw of statement(
      database,
      `SELECT node_id, parent_node_id, chat_message, created_at
         FROM message_nodes WHERE session_id = ? ORDER BY node_id ASC`,
    ).all(input.sessionId)) {
      const row = raw as Record<string, unknown>;
      const nodeId = asNumber(row.node_id);
      const message = parseChatMessage(row.chat_message);
      if (nodeId === null || message === null) continue;
      nodes.set(nodeId, {
        nodeId,
        parentNodeId: asNumber(row.parent_node_id),
        message,
        fallbackCreatedAt: epochSecondsToIso(row.created_at),
      });
    }
    if (nodes.size === 0) return { session, messages: [] };

    const tip =
      session.mainChainId !== null && nodes.has(session.mainChainId)
        ? session.mainChainId
        : Math.max(...nodes.keys());
    const chain: Array<DevinSessionMessage> = [];
    const seen = new Set<number>();
    for (let cursor: number | null = tip; cursor !== null; ) {
      const node = nodes.get(cursor);
      if (node === undefined || seen.has(cursor)) break;
      seen.add(cursor);
      chain.push({
        nodeId: node.nodeId,
        messageId: node.message!.messageId,
        role: node.message!.role,
        content: node.message!.content,
        isUserInput: node.message!.isUserInput,
        createdAt: node.message!.createdAt ?? node.fallbackCreatedAt,
      });
      cursor = node.parentNodeId;
    }
    return { session, messages: chain.toReversed() };
  });
}
