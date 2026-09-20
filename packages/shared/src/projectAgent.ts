// FILE: projectAgent.ts
// Purpose: Path, graph, and context-budget helpers for the Project Coordinator domain.
// Layer: Shared domain helper (schema-only contracts live in @synara/contracts)

import type { ProjectTaskId } from "@synara/contracts";
import {
  PROJECT_AGENT_CONTEXT_BUDGET_CHARS,
  PROJECT_AGENT_WORKER_INBOX_PREFIX,
} from "@synara/contracts";

const WINDOWS_DRIVE = /^[a-zA-Z]:/;

export class ProjectAgentPathError extends Error {
  readonly code: "traversal" | "empty" | "absolute" | "symlink-escape";
  constructor(code: ProjectAgentPathError["code"], message: string) {
    super(message);
    this.name = "ProjectAgentPathError";
    this.code = code;
  }
}

export function normalizeProjectDocumentPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/\\/g, "/");
  if (trimmed.length === 0) {
    throw new ProjectAgentPathError("empty", "Document path is empty.");
  }
  if (trimmed.startsWith("/") || WINDOWS_DRIVE.test(trimmed) || trimmed.startsWith("//")) {
    throw new ProjectAgentPathError("absolute", "Document path must be relative.");
  }
  const segments = trimmed.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0) {
    throw new ProjectAgentPathError("empty", "Document path is empty.");
  }
  for (const segment of segments) {
    if (segment === ".." || segment.includes("\0")) {
      throw new ProjectAgentPathError("traversal", `Document path rejects segment "${segment}".`);
    }
  }
  return segments.join("/");
}

export function isInboxDocumentPath(logicalPath: string): boolean {
  return logicalPath.startsWith(PROJECT_AGENT_WORKER_INBOX_PREFIX);
}

export function isUserOwnedDocumentPath(logicalPath: string): boolean {
  return logicalPath === "instructions.md" || logicalPath === "notes.md";
}

export function isCoordinatorCuratedDocumentPath(logicalPath: string): boolean {
  return logicalPath === "decisions.md" || logicalPath.startsWith("docs/");
}

export function isGeneratedDocumentPath(logicalPath: string): boolean {
  return logicalPath === "overview.md" || logicalPath === "archived.md";
}

export const MEMORY_DOCUMENT_PREFIX = "memory/";
export const MEMORY_AUTO_DOCUMENT_PATH = "memory/MEMORY.md";

export function isMemoryDocumentPath(logicalPath: string): boolean {
  return normalizeProjectDocumentPath(logicalPath).startsWith(MEMORY_DOCUMENT_PREFIX);
}

export const PROJECT_CONTEXT_PREVIEW_DOCUMENTS = [
  { logicalPath: "instructions.md", label: "Instructions", editable: true },
  { logicalPath: "notes.md", label: "Notes", editable: true },
  { logicalPath: "decisions.md", label: "Decisions", editable: false },
  { logicalPath: "docs/project-bot.md", label: "Playbook", editable: false },
] as const;

export function isProjectContextPreviewPath(logicalPath: string): boolean {
  return PROJECT_CONTEXT_PREVIEW_DOCUMENTS.some((document) => document.logicalPath === logicalPath);
}

export const INITIAL_PROJECT_DIGEST_SUMMARY = "Coordinator is ready.";

const GOAL_GATE_DIGEST_SENTENCES = [
  /Start a goal to begin bounded coordination\.?/gi,
  /Assigned work starts only after a goal is started\.?/gi,
  /\s*[^.]*?\band\b[^.]*?both reported failure, while .*?written\./gi,
  /No worker completion is confirmed\.?/gi,
];

export function sanitizeProjectDigestSummary(summary: string | null | undefined): string | null {
  if (summary == null) return null;
  let next = summary.trim();
  if (next.length === 0) return null;
  for (const pattern of GOAL_GATE_DIGEST_SENTENCES) {
    next = next.replace(pattern, "");
  }
  next = next
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\./g, ".")
    .trim();
  if (next === "Coordinator is configured." || next === "Coordinator is configured") {
    return INITIAL_PROJECT_DIGEST_SUMMARY;
  }
  return next.length > 0 ? next : INITIAL_PROJECT_DIGEST_SUMMARY;
}

export function sanitizeProjectDigestFocusTitle(title: string): string {
  return title.replace(/\s+reported failed\.?$/i, "").trim();
}

export function detectProjectTaskDependencyCycle(input: {
  readonly taskId: ProjectTaskId;
  readonly dependsOnTaskIds: ReadonlyArray<ProjectTaskId>;
  readonly edges: ReadonlyMap<ProjectTaskId, ReadonlyArray<ProjectTaskId>>;
}): boolean {
  const adjacency = new Map(input.edges);
  adjacency.set(input.taskId, input.dependsOnTaskIds);
  const visiting = new Set<ProjectTaskId>();
  const visited = new Set<ProjectTaskId>();
  const visit = (node: ProjectTaskId): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return visit(input.taskId);
}

export function truncateToContextBudget(
  sections: ReadonlyArray<{ readonly label: string; readonly text: string }>,
  budget = PROJECT_AGENT_CONTEXT_BUDGET_CHARS,
): {
  readonly packet: string;
  readonly characterCount: number;
  readonly truncated: boolean;
} {
  const full = sections.map((section) => `## ${section.label}\n${section.text}`).join("\n\n");
  if (full.length <= budget) {
    return { packet: full, characterCount: full.length, truncated: false };
  }
  const marker = "\n\n[truncated]";
  const keep = Math.max(0, budget - marker.length);
  const packet = `${full.slice(0, keep)}${marker}`;
  return {
    packet: packet.slice(0, budget),
    characterCount: Math.min(packet.length, budget),
    truncated: true,
  };
}

export function encodeProjectAgentListCursor(input: {
  readonly createdAt: string;
  readonly id: string;
}): string {
  return Buffer.from(`${input.createdAt}\t${input.id}`, "utf8").toString("base64url");
}

export function decodeProjectAgentListCursor(
  cursor: string | undefined,
): { readonly createdAt: string; readonly id: string } | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const split = decoded.indexOf("\t");
    if (split <= 0) return null;
    return { createdAt: decoded.slice(0, split), id: decoded.slice(split + 1) };
  } catch {
    return null;
  }
}
