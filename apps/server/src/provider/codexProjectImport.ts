import fs from "node:fs/promises";
import path from "node:path";

import { resolveBaseCodexHomePath } from "../codexHomePaths";
import type {
  NativeImportProject,
  NativeImportSession,
  NativeProjectImportCatalog,
} from "./projectImportTypes";

type Row = Record<string, unknown>;
interface CodexProjectImportInput {
  homePath?: string;
  env?: NodeJS.ProcessEnv;
}

interface ReadonlyDatabase {
  prepare?: (sql: string) => { all: () => ReadonlyArray<Row> };
  query?: (sql: string) => { all: () => ReadonlyArray<Row> };
  exec: (sql: string) => unknown;
  close: () => unknown;
}

export class CodexProjectImportError extends Error {
  constructor(
    readonly code: "unsupported" | "unreadable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexProjectImportError";
  }
}

function object(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isMissing(error: unknown): boolean {
  return object(error).code === "ENOENT";
}

async function realpathIfPresent(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if (isMissing(error)) return path.resolve(value);
    throw error;
  }
}

export async function resolveCodexProjectImportHome(
  input: CodexProjectImportInput = {},
): Promise<string> {
  const home = await realpathIfPresent(
    resolveBaseCodexHomePath(input.env ?? process.env, input.homePath),
  );
  try {
    // Synara's overlay links this file to the original home. Keep one provenance identity.
    return path.dirname(await fs.realpath(path.join(home, ".codex-global-state.json")));
  } catch (error) {
    if (isMissing(error)) return home;
    throw error;
  }
}

async function readDesktopState(home: string): Promise<Row> {
  try {
    return object(
      JSON.parse(await fs.readFile(path.join(home, ".codex-global-state.json"), "utf8")),
    );
  } catch (error) {
    if (isMissing(error)) return {};
    throw error;
  }
}

async function findStateDatabase(sqliteHome: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(sqliteHome);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  const candidates = entries
    .flatMap((name) => {
      const match = /^state_(\d+)\.sqlite$/.exec(name);
      return match ? [{ name, version: Number(match[1]) }] : [];
    })
    .toSorted((a, b) => b.version - a.version);
  return candidates[0] ? path.join(sqliteHome, candidates[0].name) : undefined;
}

async function openDatabase(dbPath: string): Promise<ReadonlyDatabase> {
  if (process.versions.bun !== undefined) {
    // Keep Bun's runtime-only module out of the Node bundle, as providerUsage/sqlite does.
    const importRuntimeModule = Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<{
      Database: new (file: string, options: { readonly: boolean }) => ReadonlyDatabase;
    }>;
    const { Database } = await importRuntimeModule("bun:sqlite");
    return new Database(dbPath, { readonly: true });
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true }) as unknown as ReadonlyDatabase;
}

function rows(database: ReadonlyDatabase, sql: string): ReadonlyArray<Row> {
  const statement = database.prepare?.(sql) ?? database.query?.(sql);
  if (!statement)
    throw new CodexProjectImportError("unsupported", "Codex SQLite reader is unavailable.");
  return statement.all();
}

function requireColumns(
  database: ReadonlyDatabase,
  table: string,
  required: ReadonlyArray<string>,
) {
  const columns = new Set(rows(database, `PRAGMA table_info(${table})`).map((row) => row.name));
  if (required.some((name) => !columns.has(name))) {
    throw new CodexProjectImportError("unsupported", `Unsupported Codex ${table} metadata schema.`);
  }
  return columns;
}

function readDatabaseProjects(
  database: ReadonlyDatabase,
  tables: Set<unknown>,
): NativeImportProject[] {
  if (!tables.has("projects") && !tables.has("project_roots")) return [];
  requireColumns(database, "projects", ["id", "name"]);
  requireColumns(database, "project_roots", ["project_id", "path", "position"]);
  const roots = rows(database, "SELECT project_id, path FROM project_roots ORDER BY position");
  return rows(database, "SELECT id, name FROM projects").flatMap((project) => {
    const id = text(project.id);
    if (!id) return [];
    return [
      {
        id,
        title: text(project.name) ?? id,
        roots: roots.flatMap((root) =>
          root.project_id === id && text(root.path) ? [root.path as string] : [],
        ),
      },
    ];
  });
}

function mergeLegacyProjects(
  modern: ReadonlyArray<NativeImportProject>,
  state: Row,
  homes: ReadonlyArray<string>,
): { projects: NativeImportProject[]; legacyIds: Map<string, string> } {
  const projects = new Map(modern.map((project) => [project.id, project]));
  const legacyIds = new Map<string, string>();
  const mappings = object(state["app-server-project-id-by-legacy-project-id-by-host"]);
  const hostMappings = homes.map((home) => object(mappings[`local:${home}`]));
  for (const [key, value] of Object.entries(object(state["local-projects"]))) {
    const legacy = object(value);
    const legacyId = text(legacy.id) ?? key;
    const mappedId = hostMappings
      .map((mapping) => text(mapping[legacyId]))
      .find((id) => id && projects.has(id));
    const id = mappedId ?? legacyId;
    legacyIds.set(legacyId, id);
    if (projects.has(id)) continue;
    const roots = Array.isArray(legacy.rootPaths)
      ? legacy.rootPaths.flatMap((root) => (text(root) ? [root as string] : []))
      : [];
    projects.set(id, { id, title: text(legacy.name) ?? path.basename(roots[0] ?? id), roots });
  }
  return { projects: [...projects.values()], legacyIds };
}

function isInternalThread(row: Row, children: Set<unknown>): boolean {
  if (children.has(row.id) || text(row.parent_thread_id)) return true;
  const source = text(row.source) ?? "";
  const threadSource = text(row.thread_source) ?? "";
  if (/^sub_?agent/i.test(source) || /^(sub_?agent|guardian)/i.test(threadSource)) return true;
  if (!source.startsWith("{")) return false;
  try {
    return object(JSON.parse(source)).subagent !== undefined;
  } catch {
    return false;
  }
}

function timestamp(milliseconds: unknown, seconds: unknown): string {
  const value =
    typeof milliseconds === "number"
      ? milliseconds
      : typeof seconds === "number"
        ? seconds * 1_000
        : NaN;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CodexProjectImportError(
      "unsupported",
      "Codex thread metadata has an unsupported timestamp.",
    );
  }
  return date.toISOString();
}

function readDatabaseSessions(
  database: ReadonlyDatabase,
  tables: Set<unknown>,
  state: Row,
  legacyIds: Map<string, string>,
  projects: ReadonlyArray<NativeImportProject>,
): NativeImportSession[] {
  const columns = requireColumns(database, "threads", [
    "id",
    "cwd",
    "source",
    "created_at",
    "updated_at",
  ]);
  const selected = [
    "id",
    "cwd",
    "source",
    "created_at",
    "updated_at",
    "created_at_ms",
    "updated_at_ms",
    "name",
    "title",
    "project_id",
    "archived",
    "thread_source",
    "parent_thread_id",
  ].filter((column) => columns.has(column));
  const children = new Set(
    tables.has("thread_spawn_edges")
      ? rows(database, "SELECT child_thread_id FROM thread_spawn_edges").map(
          (row) => row.child_thread_id,
        )
      : [],
  );
  const projectIds = new Set(projects.map((project) => project.id));
  const assignments = object(state["thread-project-assignments"]);
  const projectless = new Set(
    Array.isArray(state["projectless-thread-ids"]) ? state["projectless-thread-ids"] : [],
  );
  return rows(database, `SELECT ${selected.join(", ")} FROM threads`).flatMap((row) => {
    const id = text(row.id);
    const cwd = text(row.cwd);
    if (!id || !cwd || isInternalThread(row, children)) return [];
    const assignment = object(assignments[id]);
    const legacyId =
      !projectless.has(id) && assignment.projectKind === "local"
        ? text(assignment.projectId)
        : undefined;
    const candidateId = text(row.project_id) ?? (legacyId ? legacyIds.get(legacyId) : undefined);
    return [
      {
        id,
        title: text(row.name) ?? text(row.title) ?? id,
        cwd,
        projectId: candidateId && projectIds.has(candidateId) ? candidateId : null,
        createdAt: timestamp(row.created_at_ms, row.created_at),
        updatedAt: timestamp(row.updated_at_ms, row.updated_at),
        archived: row.archived === 1 || row.archived === true,
      },
    ];
  });
}

export async function discoverCodexProjects(
  input: CodexProjectImportInput = {},
): Promise<NativeProjectImportCatalog> {
  let database: ReadonlyDatabase | undefined;
  try {
    const env = input.env ?? process.env;
    const configuredHome = path.resolve(resolveBaseCodexHomePath(env, input.homePath));
    const home = await realpathIfPresent(configuredHome);
    const sourceHome = await resolveCodexProjectImportHome(input);
    const state = await readDesktopState(home);
    const sqliteHome = await realpathIfPresent(env.CODEX_SQLITE_HOME?.trim() || sourceHome);
    const dbPath = await findStateDatabase(sqliteHome);
    if (dbPath) database = await openDatabase(dbPath);
    // A read transaction keeps projects, assignments, and thread metadata on one SQLite snapshot.
    database?.exec("BEGIN");
    const tables = new Set(
      database
        ? rows(database, "SELECT name FROM sqlite_master WHERE type = 'table'").map(
            (row) => row.name,
          )
        : [],
    );
    const { projects, legacyIds } = mergeLegacyProjects(
      database ? readDatabaseProjects(database, tables) : [],
      state,
      [sourceHome, home, configuredHome, sqliteHome],
    );
    const sessions = database
      ? readDatabaseSessions(database, tables, state, legacyIds, projects)
      : [];
    return { sourceHome, projects, sessions };
  } catch (error) {
    if (error instanceof CodexProjectImportError) throw error;
    throw new CodexProjectImportError(
      "unreadable",
      "Could not read local Codex project metadata.",
      { cause: error },
    );
  } finally {
    database?.close();
  }
}
