import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ProviderAgentDescriptor } from "@t3tools/contracts";

interface PiSubagentDefinition {
  readonly name: string;
  readonly description?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly source: "global" | "project";
}

function expandHome(input: string): string {
  return input === "~" || input.startsWith("~/") ? path.join(homedir(), input.slice(2)) : input;
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function parseDefinitionFile(
  filePath: string,
  source: PiSubagentDefinition["source"],
): PiSubagentDefinition | null {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;

  const frontmatter = match[1] ?? "";
  if (frontmatterValue(frontmatter, "enabled") === "false") return null;

  const fallbackName = path.basename(filePath, ".md");
  const name = frontmatterValue(frontmatter, "name") ?? fallbackName;
  const description = frontmatterValue(frontmatter, "description");
  const model = frontmatterValue(frontmatter, "model");
  const thinking = frontmatterValue(frontmatter, "thinking");

  return {
    name,
    source,
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function readAgentDirectory(
  dir: string,
  source: PiSubagentDefinition["source"],
): PiSubagentDefinition[] {
  const resolvedDir = expandHome(dir);
  if (!existsSync(resolvedDir)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(resolvedDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const definition = parseDefinitionFile(path.join(resolvedDir, entry.name), source);
      return definition ? [definition] : [];
    });
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | undefined {
  let currentDir = path.resolve(expandHome(cwd));
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return undefined;
    currentDir = parentDir;
  }
}

function displayNameFromAgentName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || name;
}

function modelWithThinking(definition: PiSubagentDefinition): string | undefined {
  if (!definition.model) return undefined;
  if (!definition.thinking || definition.model.includes(":")) return definition.model;
  return `${definition.model}:${definition.thinking}`;
}

export function listPiSubagentDefinitions(input: {
  readonly agentDir: string;
  readonly cwd: string;
}): ProviderAgentDescriptor[] {
  const agents = new Map<string, PiSubagentDefinition>();
  for (const definition of readAgentDirectory(path.join(input.agentDir, "agents"), "global")) {
    agents.set(definition.name, definition);
  }
  const projectAgentsDir = findNearestProjectAgentsDir(input.cwd);
  if (projectAgentsDir) {
    for (const definition of readAgentDirectory(projectAgentsDir, "project")) {
      agents.set(definition.name, definition);
    }
  }

  return [...agents.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((definition) => {
      const model = modelWithThinking(definition);
      return {
        name: definition.name,
        displayName: displayNameFromAgentName(definition.name),
        scope: definition.source,
        ...(definition.description ? { description: definition.description } : {}),
        ...(model ? { model } : {}),
      };
    });
}
