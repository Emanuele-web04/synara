import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsFile = "apps/server/src/persistence/Migrations.ts";

/** Shipped (id,name) pairs are immutable: the runtime treats a mismatched name as foreign lineage and replays the schema, corrupting every database from that release. Only pairs the runtime repairs (MIGRATION_LINEAGE_ALIASES / known divergences) are exempt. */

export interface MigrationLineageEntry {
  readonly id: number;
  readonly name: string;
}

export interface MigrationLineageViolation {
  readonly id: number;
  readonly releasedName: string;
  readonly currentName: string | null;
}

/** Released (id,name) pair whose divergence the runtime repairs. */
export interface MigrationLineageAllowance {
  readonly id: number;
  readonly name: string;
}

/** Shipped divergences repaired by a mechanism other than MIGRATION_LINEAGE_ALIASES; every entry must name what makes upgrade safe. */
const HANDLED_RELEASED_DIVERGENCES: readonly MigrationLineageAllowance[] = [
  // v0.0.15 and older recorded these two at 17/18 before the slots were reused
  // LAST_SHARED_LINEAGE_MIGRATION_ID sits at 16 because of them: divergences above it replay, and every migration past 16 is idempotent
  { id: 17, name: "ProjectionThreadsArchivedAt" },
  { id: 18, name: "ProjectionThreadsArchivedAtIndex" },
  // renamed in place during the Synara cutover; reconcile restores the canonical name when the rows below are canonical
  { id: 32, name: "ReconcileLegacyT3SchemaImport" },
];

const entriesBlockPattern = /export const migrationEntries\s*=\s*\[([\s\S]*?)\]\s*as const;/u;
const entryPattern = /\[\s*(\d+)\s*,\s*"([^"]+)"/gu;
const aliasesBlockPattern = /export const MIGRATION_LINEAGE_ALIASES[^=]*=\s*\[([\s\S]*?)\n\];/u;
const aliasPattern = /historicalId:\s*(\d+),\s*(?:\/\/[^\n]*\n\s*)*historicalName:\s*"([^"]+)"/gu;

export function parseMigrationLineage(source: string): MigrationLineageEntry[] {
  const block = entriesBlockPattern.exec(source);
  if (block === null || block[1] === undefined) {
    throw new Error(`Could not locate the migrationEntries array in ${migrationsFile}.`);
  }
  const entries: MigrationLineageEntry[] = [];
  for (const match of block[1].matchAll(entryPattern)) {
    entries.push({ id: Number(match[1]), name: match[2]! });
  }
  if (entries.length === 0) {
    throw new Error(`Parsed zero migrations from ${migrationsFile}; the guard cannot verify it.`);
  }
  return entries;
}

/** (id,name) pairs the reconciler repairs without replaying a schema; absent block is the normal state. */
export function parseMigrationLineageAllowances(source: string): MigrationLineageAllowance[] {
  const block = aliasesBlockPattern.exec(source);
  if (block === null || block[1] === undefined) {
    return [];
  }
  return [...block[1].matchAll(aliasPattern)].map((match) => ({
    id: Number(match[1]),
    name: match[2]!,
  }));
}

/** Structural defects that void lineage: duplicate ids (Effect rejects outright) and out-of-order entries. */
export function findLineageStructureViolations(
  entries: readonly MigrationLineageEntry[],
): string[] {
  const problems: string[] = [];
  const seen = new Map<number, string>();
  let previousId = 0;
  for (const entry of entries) {
    const duplicate = seen.get(entry.id);
    if (duplicate !== undefined) {
      problems.push(
        `Migration ${entry.id} is declared twice ("${duplicate}" and "${entry.name}").`,
      );
    }
    seen.set(entry.id, entry.name);
    if (entry.id <= previousId) {
      problems.push(`Migration ${entry.id} ("${entry.name}") is out of ascending order.`);
    }
    previousId = entry.id;
  }
  return problems;
}

export function findReleasedLineageViolations(
  released: readonly MigrationLineageEntry[],
  current: readonly MigrationLineageEntry[],
  allowances: readonly MigrationLineageAllowance[] = [],
): MigrationLineageViolation[] {
  const currentNamesById = new Map(current.map((entry) => [entry.id, entry.name]));
  const allowed = new Set(allowances.map((allowance) => `${allowance.id}:${allowance.name}`));
  const violations: MigrationLineageViolation[] = [];
  for (const entry of released) {
    const currentName = currentNamesById.get(entry.id);
    if (currentName === entry.name) continue;
    if (allowed.has(`${entry.id}:${entry.name}`)) continue;
    violations.push({
      id: entry.id,
      releasedName: entry.name,
      currentName: currentName ?? null,
    });
  }
  return violations;
}

function git(args: readonly string[]): { readonly status: number; readonly stdout: string } {
  const result = spawnSync("git", [...args], { cwd: repoRoot, encoding: "utf8" });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

const defaultListTags = (pattern: string): readonly string[] => {
  const result = git(["tag", "--list", pattern, "--sort=-v:refname"]);
  return result.status === 0
    ? result.stdout
        .split("\n")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
};

/** Every reachable release tag, newest first; empty on shallow clones/forks — degrade to a warning, never a hard failure. */
export function resolveReleaseTags(
  listTags: (pattern: string) => readonly string[] = defaultListTags,
): string[] {
  return [...listTags("v[0-9]*")];
}

interface TaggedViolation {
  readonly violation: MigrationLineageViolation;
  readonly tags: string[];
}

export function groupViolationsByPair(
  perTag: ReadonlyArray<{
    readonly tag: string;
    readonly violations: readonly MigrationLineageViolation[];
  }>,
): TaggedViolation[] {
  const grouped = new Map<string, TaggedViolation>();
  for (const { tag, violations } of perTag) {
    for (const violation of violations) {
      const key = `${violation.id}:${violation.releasedName}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.tags.push(tag);
        continue;
      }
      grouped.set(key, { violation, tags: [tag] });
    }
  }
  return [...grouped.values()].toSorted((left, right) => left.violation.id - right.violation.id);
}

function main(): void {
  const currentSource = readFileSync(resolve(repoRoot, migrationsFile), "utf8");
  const currentEntries = parseMigrationLineage(currentSource);
  const allowances = [
    ...parseMigrationLineageAllowances(currentSource),
    ...HANDLED_RELEASED_DIVERGENCES,
  ];

  const structureProblems = findLineageStructureViolations(currentEntries);
  if (structureProblems.length > 0) {
    console.error("Migration lineage is malformed:");
    for (const problem of structureProblems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }

  const tags = resolveReleaseTags();
  if (tags.length === 0) {
    console.warn(
      "Migration lineage check skipped: no release tag is reachable from this checkout. " +
        "Fetch tags (actions/checkout with fetch-depth: 0) to enable it.",
    );
    return;
  }

  const checked: string[] = [];
  const skipped: string[] = [];
  const perTag: Array<{ tag: string; violations: readonly MigrationLineageViolation[] }> = [];
  for (const tag of tags) {
    const released = git(["show", `${tag}:${migrationsFile}`]);
    if (released.status !== 0) {
      // tag predates this file or history is too shallow — no verifiable lineage claim
      skipped.push(tag);
      continue;
    }
    let releasedEntries: MigrationLineageEntry[];
    try {
      releasedEntries = parseMigrationLineage(released.stdout);
    } catch {
      // an unparseable release predates this guard's shape; failing on it would block every future change
      skipped.push(tag);
      continue;
    }
    checked.push(tag);
    const violations = findReleasedLineageViolations(releasedEntries, currentEntries, allowances);
    if (violations.length > 0) perTag.push({ tag, violations });
  }

  if (checked.length === 0) {
    console.warn(
      `Migration lineage check skipped: ${migrationsFile} is not readable at any of the ` +
        `${tags.length} release tags. Fetch full history to enable it.`,
    );
    return;
  }

  const skippedNote = skipped.length === 0 ? "" : ` (${skipped.length} unreadable tags skipped)`;
  if (perTag.length === 0) {
    console.log(
      `Migration lineage check passed: all migrations shipped across ${checked.length} release ` +
        `tags (${checked[checked.length - 1]}..${checked[0]}) keep their released (id, name)` +
        `${skippedNote}.`,
    );
    return;
  }

  console.error(
    "Migration lineage changed for migrations that were already shipped. " +
      "Released (id, name) pairs are recorded in every user's effect_sql_migrations table; " +
      "changing one makes the reconciler treat those databases as a foreign lineage and replay " +
      "their schema. Append a new migration instead of renumbering or renaming a shipped one, " +
      "or declare a reviewed MIGRATION_LINEAGE_ALIASES entry if the change already shipped.",
  );
  for (const { violation, tags: shippedIn } of groupViolationsByPair(perTag)) {
    console.error(
      `- migration ${violation.id}: ${shippedIn.join(", ")} shipped ` +
        `"${violation.releasedName}", ${migrationsFile} now has ${
          violation.currentName === null ? "no entry" : `"${violation.currentName}"`
        }.`,
    );
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
