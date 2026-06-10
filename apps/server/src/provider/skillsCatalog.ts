// FILE: skillsCatalog.ts
// Purpose: Generic Agent Skill discovery primitives (frontmatter parsing, SKILL.md
//          walking) plus the unified cross-provider skills catalog backing Synara
//          portable skills. Aggregates `~/.synara/skills` with every provider-native
//          skills folder, deduping by name with provider-native copies winning for
//          the active provider.
// Layer: Server provider discovery helper
// Exports: parseSkillFrontmatter, collectSkillsFromRoots, discoverSkillsCatalog,
//          mergeSkillsIntoCatalog, filterDisabledSkills, ensureSynaraSkillsDir

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { ProviderKind, ProviderSkillDescriptor } from "@t3tools/contracts";

type FrontmatterValue = string | boolean;

export interface SkillRoot {
  readonly path: string;
  readonly scope: string;
}

// ── Frontmatter parsing ──────────────────────────────────────────────

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

// ── Filesystem walking ───────────────────────────────────────────────

export function ancestorsFromDeepest(cwd: string): string[] {
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

async function readdirOrEmpty(path: string): Promise<import("node:fs").Dirent[]> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Skills may be nested one namespace deep, e.g. `.cursor/skills/skills-sh/find-skills`.
// Subdirectories are visited concurrently but results are flattened in sorted name
// order so name-dedup always picks the same winner across runs.
export async function collectSkillMarkdownPaths(rootPath: string): Promise<string[]> {
  async function visit(dir: string, depth: number): Promise<string[]> {
    const skillPath = nodePath.join(dir, "SKILL.md");
    try {
      const stat = await fs.stat(skillPath);
      if (stat.isFile()) {
        return [skillPath];
      }
    } catch {
      // Keep walking; this directory may be a namespace rather than a skill.
    }

    if (depth >= 2) {
      return [];
    }

    const dirents = await readdirOrEmpty(dir);
    const subdirNames = dirents
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort();
    const nested = await Promise.all(
      subdirNames.map((name) => visit(nodePath.join(dir, name), depth + 1)),
    );
    return nested.flat();
  }

  return visit(rootPath, 0);
}

export async function readSkillDescriptor(input: {
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

export function skillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

// Scans all roots concurrently, then dedupes by name in root order so earlier
// roots keep precedence. Within a root, SKILL.md path order is preserved.
export async function collectSkillsFromRoots(
  roots: ReadonlyArray<SkillRoot>,
): Promise<ProviderSkillDescriptor[]> {
  const skillsPerRoot = await Promise.all(
    roots.map(async (root) => {
      const skillPaths = await collectSkillMarkdownPaths(root.path);
      const descriptors = await Promise.all(
        skillPaths.map((skillPath) => readSkillDescriptor({ skillPath, scope: root.scope })),
      );
      return descriptors.filter((skill) => skill !== null);
    }),
  );

  const byName = new Map<string, ProviderSkillDescriptor>();
  for (const rootSkills of skillsPerRoot) {
    for (const skill of rootSkills) {
      const key = skillNameKey(skill.name);
      if (!byName.has(key)) {
        byName.set(key, skill);
      }
    }
  }
  return [...byName.values()];
}

// ── Unified cross-provider catalog ───────────────────────────────────

export interface SkillsCatalogDiscoveryInput {
  /** Optional workspace cwd; when present, project-level skill folders are included. */
  readonly cwd?: string | null;
  readonly homeDir: string;
  /** Synara base dir (usually `~/.synara`); skills live in `{base}/skills`. */
  readonly synaraBaseDir: string;
  /** Provider whose native copies should win when the same skill exists in several roots. */
  readonly provider?: ProviderKind | null;
  /** Bypass the short-lived discovery cache. */
  readonly forceReload?: boolean;
}

const HOME_ORIGIN_ORDER = ["synara", "codex", "claude", "cursor", "agents"] as const;
export type SkillsCatalogOrigin = (typeof HOME_ORIGIN_ORDER)[number] | "project";

// Composer skill pickers refetch aggressively (per keystroke, per provider); a
// short TTL absorbs that burst while still picking up new skill files quickly.
const SKILLS_CATALOG_CACHE_TTL_MS = 15_000;
const SKILLS_CATALOG_CACHE_MAX_ENTRIES = 64;

interface SkillsCatalogCacheEntry {
  readonly at: number;
  readonly skills: ReadonlyArray<ProviderSkillDescriptor>;
}

const skillsCatalogCache = new Map<string, SkillsCatalogCacheEntry>();

export function clearSkillsCatalogCacheForTests(): void {
  skillsCatalogCache.clear();
}

export function synaraSkillsDir(synaraBaseDir: string): string {
  return nodePath.join(synaraBaseDir, "skills");
}

// Creates the portable skills folder on first use so users have a drop-in target.
export async function ensureSynaraSkillsDir(synaraBaseDir: string): Promise<string> {
  const dir = synaraSkillsDir(synaraBaseDir);
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // Discovery still works without the folder; reads simply return nothing.
  }
  return dir;
}

function homeRootsForOrigin(
  origin: (typeof HOME_ORIGIN_ORDER)[number],
  input: SkillsCatalogDiscoveryInput,
): string[] {
  switch (origin) {
    case "synara":
      return [synaraSkillsDir(input.synaraBaseDir)];
    case "codex":
      return [nodePath.join(input.homeDir, ".codex", "skills")];
    case "claude":
      return [nodePath.join(input.homeDir, ".claude", "skills")];
    case "cursor":
      return [
        nodePath.join(input.homeDir, ".cursor", "skills-cursor"),
        nodePath.join(input.homeDir, ".cursor", "skills"),
      ];
    case "agents":
      return [nodePath.join(input.homeDir, ".agents", "skills")];
  }
}

function projectRootNamesForOrigin(origin: (typeof HOME_ORIGIN_ORDER)[number]): string[] {
  switch (origin) {
    case "synara":
      return [".synara"];
    case "codex":
      return [".codex"];
    case "claude":
      return [".claude"];
    case "cursor":
      return [".cursor"];
    case "agents":
      return [".agents"];
  }
}

// Native copies first so an agent keeps using its own skill, then Synara as the
// portable fallback, then the remaining provider homes for cross-provider reuse.
function preferredOriginsForProvider(
  provider: ProviderKind | null | undefined,
): ReadonlyArray<(typeof HOME_ORIGIN_ORDER)[number]> {
  switch (provider) {
    case "codex":
      return ["codex"];
    case "claudeAgent":
      return ["claude"];
    case "cursor":
      return ["cursor", "agents"];
    default:
      return [];
  }
}

function orderedOriginsForProvider(
  provider: ProviderKind | null | undefined,
): Array<(typeof HOME_ORIGIN_ORDER)[number]> {
  const preferred = preferredOriginsForProvider(provider);
  const ordered = [...preferred];
  if (!ordered.includes("synara")) {
    ordered.push("synara");
  }
  for (const origin of HOME_ORIGIN_ORDER) {
    if (!ordered.includes(origin)) {
      ordered.push(origin);
    }
  }
  return ordered;
}

export function skillsCatalogRoots(input: SkillsCatalogDiscoveryInput): SkillRoot[] {
  const orderedOrigins = orderedOriginsForProvider(input.provider);

  const homeRoots = orderedOrigins.flatMap((origin) =>
    homeRootsForOrigin(origin, input).map((path) => ({ path, scope: origin })),
  );
  const homeRootPaths = new Set(homeRoots.map((root) => nodePath.resolve(root.path)));

  const projectRoots: SkillRoot[] = [];
  const cwd = input.cwd?.trim();
  if (cwd) {
    for (const ancestor of ancestorsFromDeepest(cwd)) {
      const seenRootNames = new Set<string>();
      for (const origin of orderedOrigins) {
        for (const rootName of projectRootNamesForOrigin(origin)) {
          if (seenRootNames.has(rootName)) {
            continue;
          }
          seenRootNames.add(rootName);
          const rootPath = nodePath.join(ancestor, rootName, "skills");
          // A cwd under the home dir reaches the home skill folders as
          // "project ancestors"; skip them here so each folder is scanned once
          // and keeps its true origin scope. Precedence is unchanged because
          // project and home roots share the same origin ordering.
          if (homeRootPaths.has(nodePath.resolve(rootPath))) {
            continue;
          }
          projectRoots.push({ path: rootPath, scope: "project" });
        }
      }
    }
  }

  return [...projectRoots, ...homeRoots];
}

export async function discoverSkillsCatalog(
  input: SkillsCatalogDiscoveryInput,
): Promise<ProviderSkillDescriptor[]> {
  const cacheKey = [
    input.cwd?.trim() ?? "",
    input.provider ?? "",
    input.homeDir,
    input.synaraBaseDir,
  ].join("\u0000");

  if (!input.forceReload) {
    const entry = skillsCatalogCache.get(cacheKey);
    if (entry && Date.now() - entry.at <= SKILLS_CATALOG_CACHE_TTL_MS) {
      return [...entry.skills];
    }
  }

  await ensureSynaraSkillsDir(input.synaraBaseDir);
  const skills = await collectSkillsFromRoots(skillsCatalogRoots(input));

  skillsCatalogCache.delete(cacheKey);
  skillsCatalogCache.set(cacheKey, { at: Date.now(), skills });
  while (skillsCatalogCache.size > SKILLS_CATALOG_CACHE_MAX_ENTRIES) {
    const oldestKey = skillsCatalogCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    skillsCatalogCache.delete(oldestKey);
  }
  return skills;
}

// Provider-native discovery results win on name conflicts; catalog entries fill the gaps.
export function mergeSkillsIntoCatalog(input: {
  readonly native: ReadonlyArray<ProviderSkillDescriptor>;
  readonly catalog: ReadonlyArray<ProviderSkillDescriptor>;
}): ProviderSkillDescriptor[] {
  const byName = new Map<string, ProviderSkillDescriptor>();
  for (const skill of [...input.native, ...input.catalog]) {
    const key = skillNameKey(skill.name);
    if (!byName.has(key)) {
      byName.set(key, skill);
    }
  }
  return [...byName.values()];
}

export function filterDisabledSkills(
  skills: ReadonlyArray<ProviderSkillDescriptor>,
  disabledNames: ReadonlyArray<string>,
): ProviderSkillDescriptor[] {
  if (disabledNames.length === 0) {
    return [...skills];
  }
  const disabled = new Set(disabledNames.map((name) => skillNameKey(name)));
  return skills.filter((skill) => !disabled.has(skillNameKey(skill.name)));
}
