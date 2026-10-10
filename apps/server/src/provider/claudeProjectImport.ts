import type { SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { loadClaudeAgentSdk } from "./claudeAgentSdk.ts";
import type { NativeProjectImportCatalog } from "./projectImportTypes.ts";

const SESSION_FILE_NAME = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i;
const MAX_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_LINE_BYTES = 8 * 1024 * 1024;
const METADATA_CONCURRENCY = 4;

interface ClaudeProjectImportInput {
  readonly configDir?: string;
  readonly listSessions?: () => Promise<ReadonlyArray<SDKSessionInfo>>;
}

interface TranscriptMetadata {
  readonly cwd?: string;
  readonly createdAt?: string;
}

function isoDate(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function absoluteCwd(value: unknown): string | undefined {
  return typeof value === "string" && path.isAbsolute(value) ? path.normalize(value) : undefined;
}

async function directoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function sessionFiles(configDir: string): Promise<Map<string, string>> {
  const projectsDir = path.join(configDir, "projects");
  const files = new Map<string, string>();
  for (const project of await directoryEntries(projectsDir)) {
    if (!project.isDirectory()) continue;
    const directory = path.join(projectsDir, project.name);
    for (const file of await directoryEntries(directory)) {
      // Subagents and tool output live below session directories. Never recurse.
      if (!file.isFile() || !SESSION_FILE_NAME.test(file.name)) continue;
      const id = file.name.slice(0, -6);
      const filePath = path.join(directory, file.name);
      const previous = files.get(id);
      if (previous) {
        const [previousStat, currentStat] = await Promise.all([stat(previous), stat(filePath)]);
        if (previousStat.mtimeMs >= currentStat.mtimeMs) continue;
      }
      files.set(id, filePath);
    }
  }
  return files;
}

function parseTranscriptEntry(line: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(line) > MAX_METADATA_LINE_BYTES) return undefined;
  try {
    const entry: unknown = JSON.parse(line);
    return entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function* readTranscriptEntries(file: string, maxBytes?: number) {
  const stream = createReadStream(file, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
    ...(maxBytes ? { end: maxBytes - 1 } : {}),
  });
  let pending = "";
  let skippingLine = false;
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (skippingLine) {
          skippingLine = false;
          continue;
        }
        const entry = parseTranscriptEntry(line);
        if (entry) yield entry;
      }
      if (Buffer.byteLength(pending) > MAX_METADATA_LINE_BYTES) {
        pending = "";
        skippingLine = true;
      }
    }
    if (!skippingLine) {
      const entry = parseTranscriptEntry(pending);
      if (entry) yield entry;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    stream.destroy();
  }
}

async function readTranscriptMetadata(file: string): Promise<TranscriptMetadata> {
  // the SDK's 64KiB head read misses cwd after a large first message — bound both the scan and individual records
  let cwd: string | undefined;
  let createdAt: string | undefined;
  for await (const entry of readTranscriptEntries(file, MAX_METADATA_BYTES)) {
    if (entry.isSidechain === true) continue;
    cwd ??= absoluteCwd(entry.cwd);
    if (typeof entry.timestamp === "string") createdAt ??= isoDate(entry.timestamp);
    if (cwd && createdAt) break;
  }
  return { ...(cwd ? { cwd } : {}), ...(createdAt ? { createdAt } : {}) };
}

function claudeConfigDir(configDir?: string): string {
  return path.resolve(
    configDir?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), ".claude"),
  );
}

export async function findClaudeSessionTranscriptPath(input: {
  readonly sessionId: string;
  readonly configDir?: string;
}): Promise<string | undefined> {
  const files = await sessionFiles(claudeConfigDir(input.configDir));
  return files.get(input.sessionId);
}

export async function readClaudeImportMessageDates(input: {
  readonly sessionId: string;
  readonly configDir?: string;
}): Promise<ReadonlyMap<string, string>> {
  const dates = new Map<string, string>();
  const files = await sessionFiles(claudeConfigDir(input.configDir));
  const file = files.get(input.sessionId);
  if (!file) return dates;
  for await (const entry of readTranscriptEntries(file)) {
    if (entry.isSidechain === true || typeof entry.uuid !== "string") continue;
    const timestamp = typeof entry.timestamp === "string" ? isoDate(entry.timestamp) : undefined;
    if (timestamp) dates.set(entry.uuid, timestamp);
  }
  return dates;
}

export async function discoverClaudeProjects(
  input: ClaudeProjectImportInput = {},
): Promise<NativeProjectImportCatalog> {
  const configuredHome = claudeConfigDir();
  const sourceHome = claudeConfigDir(input.configDir);
  if (sourceHome !== configuredHome && !input.listSessions) {
    throw new Error("Claude project discovery must use the configured CLAUDE_CONFIG_DIR.");
  }
  const files = await sessionFiles(sourceHome);
  if (files.size === 0) return { sourceHome, projects: [], sessions: [] };
  const listSessions =
    input.listSessions ?? (async () => (await loadClaudeAgentSdk()).listSessions());
  const metadata = await listSessions();
  const sessions: NativeProjectImportCatalog["sessions"][number][] = [];
  const projects = new Map<string, NativeProjectImportCatalog["projects"][number]>();
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(METADATA_CONCURRENCY, metadata.length) }, async () => {
      while (nextIndex < metadata.length) {
        const info = metadata[nextIndex++];
        if (!info) continue;
        const file = files.get(info.sessionId);
        if (!file) continue;
        const metadataCwd = absoluteCwd(info.cwd);
        const metadataCreatedAt = isoDate(info.createdAt);
        const fallback =
          !metadataCwd || !metadataCreatedAt ? await readTranscriptMetadata(file) : {};
        const cwd = metadataCwd ?? fallback.cwd;
        if (!cwd) continue;
        const updatedAt = isoDate(info.lastModified) ?? fallback.createdAt ?? metadataCreatedAt;
        if (!updatedAt) continue;
        const createdAt = metadataCreatedAt ?? fallback.createdAt ?? updatedAt;
        projects.set(cwd, { id: cwd, title: path.basename(cwd) || cwd, roots: [cwd] });
        sessions.push({
          id: info.sessionId,
          title: info.customTitle?.trim() || info.summary.trim() || path.basename(cwd),
          cwd,
          projectId: cwd,
          createdAt,
          updatedAt,
          archived: false,
        });
      }
    }),
  );
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return {
    sourceHome,
    projects: [...projects.values()].toSorted((a, b) => a.id.localeCompare(b.id)),
    sessions,
  };
}
