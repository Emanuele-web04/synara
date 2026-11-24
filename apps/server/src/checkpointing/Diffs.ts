// FILE: Diffs.ts
// Purpose: Parses unified diffs into checkpoint file summaries in a single pass.
// Layer: Server checkpointing helper
// Exports: checkpoint file parser used by capture and provider live-diff ingestion

import type { OrchestrationCheckpointFile } from "@synara/contracts";
import { Effect } from "effect";

type FileKind = "added" | "deleted" | "modified" | "renamed";

interface ActiveFile {
  path: string;
  oldPath: string;
  kind: FileKind;
  additions: number;
  deletions: number;
  oldRemaining: number;
  newRemaining: number;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const inner = trimmed.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i]!;
      if (ch === "\\" && i + 1 < inner.length) {
        const next = inner[i + 1]!;
        if (next >= "0" && next <= "7" && i + 3 < inner.length) {
          const oct = inner.slice(i + 1, i + 4);
          if (/^[0-7]{3}$/.test(oct)) {
            bytes.push(Number.parseInt(oct, 8));
            i += 3;
            continue;
          }
        }
        i += 1;
        switch (next) {
          case "n":
            bytes.push(0x0a);
            break;
          case "r":
            bytes.push(0x0d);
            break;
          case "t":
            bytes.push(0x09);
            break;
          case "b":
            bytes.push(0x08);
            break;
          case "f":
            bytes.push(0x0c);
            break;
          case "\\":
            bytes.push(0x5c);
            break;
          case '"':
            bytes.push(0x22);
            break;
          default:
            bytes.push(...Buffer.from(next, "utf8"));
            break;
        }
      } else {
        bytes.push(...Buffer.from(ch, "utf8"));
      }
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return trimmed;
}

function stripDiffPrefix(rawPath: string): string {
  const unquoted = unquoteGitPath(rawPath);
  if (unquoted.startsWith("a/") || unquoted.startsWith("b/")) {
    return unquoted.slice(2);
  }
  return unquoted;
}

function parseDiffGitHeader(line: string): { oldPath: string; newPath: string } | null {
  const rest = line.slice("diff --git ".length);
  // Handle quoted paths: "a/..." "b/..."
  if (rest.startsWith('"')) {
    let endA = 1;
    while (endA < rest.length) {
      if (rest[endA] === "\\" && endA + 1 < rest.length) {
        endA += 2;
        continue;
      }
      if (rest[endA] === '"') break;
      endA += 1;
    }
    const partA = rest.slice(0, endA + 1);
    const partB = rest.slice(endA + 2).trim();
    return { oldPath: stripDiffPrefix(partA), newPath: stripDiffPrefix(partB) };
  }
  const splitIndex = rest.indexOf(" b/");
  if (splitIndex !== -1) {
    return {
      oldPath: stripDiffPrefix(rest.slice(0, splitIndex)),
      newPath: stripDiffPrefix(rest.slice(splitIndex + 1)),
    };
  }
  const spaceIndex = rest.indexOf(" ");
  if (spaceIndex === -1) return null;
  return {
    oldPath: stripDiffPrefix(rest.slice(0, spaceIndex)),
    newPath: stripDiffPrefix(rest.slice(spaceIndex + 1)),
  };
}

function parseHeaderFilePath(line: string): string {
  // Header lines (`--- a/path\t2026-...` or `+++ b/path`) may carry a tab-separated timestamp.
  const value = line.slice(4);
  const tabIndex = value.indexOf("\t");
  const raw = tabIndex === -1 ? value : value.slice(0, tabIndex);
  return unquoteGitPath(raw);
}

/**
 * Single-pass unified diff summary parser. Avoids loading `@pierre/diffs`
 * (which pulls in Shiki grammar/theme tables) and allocating line-level AST
 * hunks when only per-file kinds and +/- totals are needed.
 */
export function parseCheckpointFilesFromUnifiedDiffSync(
  diff: string,
): OrchestrationCheckpointFile[] {
  const length = diff.length;
  if (length === 0) return [];

  const filesByPath = new Map<string, OrchestrationCheckpointFile>();
  let current: ActiveFile | null = null;

  const flush = () => {
    if (!current || !current.path) return;
    const existing = filesByPath.get(current.path);
    filesByPath.set(current.path, {
      path: current.path,
      kind: current.kind,
      additions: (existing?.additions ?? 0) + current.additions,
      deletions: (existing?.deletions ?? 0) + current.deletions,
    });
    current = null;
  };

  let start = 0;
  while (start < length) {
    let end = diff.indexOf("\n", start);
    if (end === -1) end = length;
    const lineEnd = end > start && diff.charCodeAt(end - 1) === 13 ? end - 1 : end;
    const line = diff.slice(start, lineEnd);
    start = end + 1;

    if (line.startsWith("diff --git ")) {
      flush();
      const parsed = parseDiffGitHeader(line);
      current = {
        path: parsed?.newPath ?? "",
        oldPath: parsed?.oldPath ?? "",
        kind: "modified",
        additions: 0,
        deletions: 0,
        oldRemaining: 0,
        newRemaining: 0,
      };
      continue;
    }

    if (current && (current.oldRemaining > 0 || current.newRemaining > 0)) {
      const code = line.charCodeAt(0);
      if (code === 43 /* '+' */) {
        current.additions += 1;
        if (current.newRemaining > 0) current.newRemaining -= 1;
        continue;
      }
      if (code === 45 /* '-' */) {
        current.deletions += 1;
        if (current.oldRemaining > 0) current.oldRemaining -= 1;
        continue;
      }
      if (code === 32 /* ' ' */ || line.length === 0) {
        if (current.oldRemaining > 0) current.oldRemaining -= 1;
        if (current.newRemaining > 0) current.newRemaining -= 1;
        continue;
      }
      if (code === 92 /* '\\' */) {
        continue;
      }
      // Malformed/truncated hunk header fallback: leave hunk state and re-parse line as header.
      current.oldRemaining = 0;
      current.newRemaining = 0;
    }

    if (line.startsWith("@@ ")) {
      if (current) {
        const match = HUNK_HEADER_RE.exec(line);
        if (match) {
          current.oldRemaining = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
          current.newRemaining = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
        }
      }
      continue;
    }

    if (line.startsWith("--- ")) {
      const rawPath = parseHeaderFilePath(line);
      if (!current) {
        current = {
          path: rawPath === "/dev/null" ? "" : stripDiffPrefix(rawPath),
          oldPath: rawPath === "/dev/null" ? "" : stripDiffPrefix(rawPath),
          kind: rawPath === "/dev/null" ? "added" : "modified",
          additions: 0,
          deletions: 0,
          oldRemaining: 0,
          newRemaining: 0,
        };
      } else if (rawPath === "/dev/null") {
        current.kind = "added";
      } else if (!current.oldPath) {
        current.oldPath = stripDiffPrefix(rawPath);
      }
      continue;
    }

    if (line.startsWith("+++ ")) {
      const rawPath = parseHeaderFilePath(line);
      if (current) {
        if (rawPath === "/dev/null") {
          current.kind = "deleted";
          if (!current.path && current.oldPath) {
            current.path = current.oldPath;
          }
        } else {
          current.path = stripDiffPrefix(rawPath);
        }
      }
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file mode ")) {
      current.kind = "added";
    } else if (line.startsWith("deleted file mode ")) {
      current.kind = "deleted";
      if (current.oldPath) current.path = current.oldPath;
    } else if (line.startsWith("rename from ")) {
      current.kind = "renamed";
      current.oldPath = unquoteGitPath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) {
      current.kind = "renamed";
      current.path = unquoteGitPath(line.slice("rename to ".length));
    }
  }

  flush();

  return Array.from(filesByPath.values()).toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
}

/**
 * Effectful wrapper matching the existing checkpoint diff query contract.
 */
export function parseCheckpointFilesFromUnifiedDiff(
  diff: string,
): Effect.Effect<OrchestrationCheckpointFile[]> {
  return Effect.sync(() => parseCheckpointFilesFromUnifiedDiffSync(diff));
}
