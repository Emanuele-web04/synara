// FILE: cursorSkillsDiscovery.ts
// Purpose: Finds Cursor-compatible Agent Skill folders from project and user skill roots.
// Layer: Server provider discovery helper
// Exports: discoverCursorSkills plus frontmatter parsing helpers for tests.

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { ProviderSkillDescriptor } from "@t3tools/contracts";

type FrontmatterValue = string | boolean;

export interface CursorSkillDiscoveryInput {
  readonly cwd: string;
  readonly homeDir: string;
}

interface SkillRoot {
  readonly path: string;
  readonly scope: string;
}

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseYamlScalar(value: string): FrontmatterValue {
  const unquoted = stripYamlQuotes(value);
  const normalized = unquoted.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return unquoted;
}

// Parses the small scalar frontmatter subset used by Agent Skills without pulling in YAML.
export function parseSkillFrontmatter(markdown: string): Record<string, FrontmatterValue> {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(normalized);
  if (!match) {
    return {};
  }

  const record: Record<string, FrontmatterValue> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }
    record[key] = parseYamlScalar(value);
  }
  return record;
}

function readStringField(
  frontmatter: Record<string, FrontmatterValue>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readBooleanField(
  frontmatter: Record<string, FrontmatterValue>,
  keys: ReadonlyArray<string>,
): boolean | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function ancestorsFromDeepest(cwd: string): string[] {
  const resolved = nodePath.resolve(cwd);
  const ancestors: string[] = [];
  let current = resolved;
  while (true) {
    ancestors.push(current);
    const parent = nodePath.dirname(current);
    if (parent === current) {
      return ancestors;
    }
    current = parent;
  }
}

function cursorSkillRoots(input: CursorSkillDiscoveryInput): SkillRoot[] {
  const projectRootNames = [".cursor", ".agents", ".claude", ".codex"] as const;
  const projectRoots = ancestorsFromDeepest(input.cwd).flatMap((ancestor) =>
    projectRootNames.map((rootName) => ({
      path: nodePath.join(ancestor, rootName, "skills"),
      scope: "project",
    })),
  );

  return [
    ...projectRoots,
    { path: nodePath.join(input.homeDir, ".cursor", "skills-cursor"), scope: "cursor" },
    { path: nodePath.join(input.homeDir, ".cursor", "skills"), scope: "personal" },
    { path: nodePath.join(input.homeDir, ".agents", "skills"), scope: "personal" },
    { path: nodePath.join(input.homeDir, ".claude", "skills"), scope: "personal" },
    { path: nodePath.join(input.homeDir, ".codex", "skills"), scope: "personal" },
  ];
}

async function readdirOrEmpty(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Cursor skills may be nested one namespace deep, e.g. `.cursor/skills/skills-sh/find-skills`.
async function collectSkillMarkdownPaths(rootPath: string): Promise<string[]> {
  const skillPaths: string[] = [];

  async function visit(dir: string, depth: number): Promise<void> {
    const skillPath = nodePath.join(dir, "SKILL.md");
    try {
      const stat = await fs.stat(skillPath);
      if (stat.isFile()) {
        skillPaths.push(skillPath);
        return;
      }
    } catch {
      // Keep walking; this directory may be a namespace rather than a skill.
    }

    if (depth >= 2) {
      return;
    }

    const dirents = await readdirOrEmpty(dir);
    await Promise.all(
      dirents
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => visit(nodePath.join(dir, dirent.name), depth + 1)),
    );
  }

  await visit(rootPath, 0);
  return skillPaths;
}

async function readSkillDescriptor(input: {
  readonly skillPath: string;
  readonly scope: string;
}): Promise<ProviderSkillDescriptor | null> {
  let raw: string;
  try {
    raw = await fs.readFile(input.skillPath, "utf8");
  } catch {
    return null;
  }

  const frontmatter = parseSkillFrontmatter(raw);
  const fallbackName = nodePath.basename(nodePath.dirname(input.skillPath));
  const name = readStringField(frontmatter, ["name"]) ?? fallbackName;
  const description = readStringField(frontmatter, ["description"]);
  const displayName = readStringField(frontmatter, ["display-name", "displayName", "title"]);
  const shortDescription = readStringField(frontmatter, [
    "short-description",
    "shortDescription",
    "summary",
  ]);
  const disabled =
    readBooleanField(frontmatter, ["disable-model-invocation", "disableModelInvocation"]) === true;

  return {
    name,
    ...(description ? { description } : {}),
    path: input.skillPath,
    enabled: !disabled,
    scope: input.scope,
    ...(displayName || shortDescription
      ? {
          interface: {
            ...(displayName ? { displayName } : {}),
            ...(shortDescription ? { shortDescription } : {}),
          },
        }
      : {}),
  };
}

export async function discoverCursorSkills(
  input: CursorSkillDiscoveryInput,
): Promise<ProviderSkillDescriptor[]> {
  const byName = new Map<string, ProviderSkillDescriptor>();

  for (const root of cursorSkillRoots(input)) {
    const skillPaths = await collectSkillMarkdownPaths(root.path);
    for (const skillPath of skillPaths) {
      const skill = await readSkillDescriptor({ skillPath, scope: root.scope });
      if (!skill) {
        continue;
      }
      const key = skill.name.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, skill);
      }
    }
  }

  return [...byName.values()];
}
