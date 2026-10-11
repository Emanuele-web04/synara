import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  findLineageStructureViolations,
  findReleasedLineageViolations,
  groupViolationsByPair,
  parseMigrationLineage,
  parseMigrationLineageAllowances,
  resolveReleaseTags,
} from "./check-migration-lineage";

const migrationsSource = () =>
  readFileSync(
    fileURLToPath(new URL("../apps/server/src/persistence/Migrations.ts", import.meta.url)),
    "utf8",
  );

const sourceFor = (entries: readonly (readonly [number, string])[]) =>
  `export const migrationEntries = [\n${entries
    .map(([id, name]) => `  [${id}, "${name}", Migration],`)
    .join("\n")}\n] as const;\n`;

const released = [
  [1, "OrchestrationEvents"],
  [53, "BackfillThreadActivitySequence"],
  [54, "ProjectPullRequestPins"],
] as const;

describe("migration lineage guard", () => {
  it("parses ids and names, ignoring comments around the entries", () => {
    const source = `
      // [99, "NotAnEntry"] in a comment above the array
      export const migrationEntries = [
        [1, "OrchestrationEvents", Migration0001],
        // A note about the next slot.
        [2, "OrchestrationCommandReceipts", Migration0002],
      ] as const;
    `;
    expect(parseMigrationLineage(source)).toEqual([
      { id: 1, name: "OrchestrationEvents" },
      { id: 2, name: "OrchestrationCommandReceipts" },
    ]);
  });

  it("throws when the entries array is missing or empty", () => {
    expect(() => parseMigrationLineage("export const other = [];")).toThrow(/migrationEntries/u);
    expect(() => parseMigrationLineage("export const migrationEntries = [] as const;")).toThrow(
      /zero migrations/u,
    );
  });

  it("passes when new migrations are appended", () => {
    const current = parseMigrationLineage(
      sourceFor([...released, [55, "ManagedAttachments"], [56, "CommandReceiptFingerprints"]]),
    );
    expect(
      findReleasedLineageViolations(parseMigrationLineage(sourceFor(released)), current),
    ).toEqual([]);
  });

  it("fails and names the pair when a shipped migration is renumbered", () => {
    // The v0.6.0 regression: 54 became a different migration and the pins
    // migration moved to 69.
    const current = parseMigrationLineage(
      sourceFor([
        [1, "OrchestrationEvents"],
        [53, "BackfillThreadActivitySequence"],
        [54, "DurableProviderCommandDelivery"],
        [69, "ProjectPullRequestPins"],
      ]),
    );
    expect(
      findReleasedLineageViolations(parseMigrationLineage(sourceFor(released)), current),
    ).toEqual([
      {
        id: 54,
        releasedName: "ProjectPullRequestPins",
        currentName: "DurableProviderCommandDelivery",
      },
    ]);
  });

  it("fails when a shipped migration is renamed in place or dropped", () => {
    const renamed = parseMigrationLineage(
      sourceFor([
        [1, "OrchestrationEvents"],
        [53, "BackfillThreadActivitySequence"],
        [54, "ProjectPullRequestPinsV2"],
      ]),
    );
    expect(
      findReleasedLineageViolations(parseMigrationLineage(sourceFor(released)), renamed),
    ).toEqual([
      { id: 54, releasedName: "ProjectPullRequestPins", currentName: "ProjectPullRequestPinsV2" },
    ]);

    const dropped = parseMigrationLineage(
      sourceFor([
        [1, "OrchestrationEvents"],
        [53, "BackfillThreadActivitySequence"],
      ]),
    );
    expect(
      findReleasedLineageViolations(parseMigrationLineage(sourceFor(released)), dropped),
    ).toEqual([{ id: 54, releasedName: "ProjectPullRequestPins", currentName: null }]);
  });

  it("rejects duplicate and out-of-order ids", () => {
    expect(
      findLineageStructureViolations(
        parseMigrationLineage(
          sourceFor([
            [1, "A"],
            [2, "B"],
          ]),
        ),
      ),
    ).toEqual([]);
    expect(
      findLineageStructureViolations(
        parseMigrationLineage(
          sourceFor([
            [1, "A"],
            [1, "B"],
          ]),
        ),
      ),
    ).toHaveLength(2);
    expect(
      findLineageStructureViolations(
        parseMigrationLineage(
          sourceFor([
            [2, "A"],
            [1, "B"],
          ]),
        ),
      ),
    ).toHaveLength(1);
  });

  it("checks every release tag, newest first, and degrades to an empty list", () => {
    // Users skip versions: a database is wedged by the release it was created
    // under, not by the newest one.
    expect(resolveReleaseTags(() => ["v0.6.0", "v0.5.5", "v0.5.4"])).toEqual([
      "v0.6.0",
      "v0.5.5",
      "v0.5.4",
    ]);
    expect(resolveReleaseTags(() => [])).toEqual([]);
  });

  it("exempts a divergence the runtime declares it can repair", () => {
    const current = parseMigrationLineage(
      sourceFor([
        [1, "OrchestrationEvents"],
        [54, "DurableProviderCommandDelivery"],
        [69, "ProjectPullRequestPins"],
      ]),
    );
    const shipped = parseMigrationLineage(sourceFor(released));

    expect(findReleasedLineageViolations(shipped, current)).toHaveLength(2);
    expect(
      findReleasedLineageViolations(shipped, current, [
        { id: 53, name: "BackfillThreadActivitySequence" },
        { id: 54, name: "ProjectPullRequestPins" },
      ]),
    ).toEqual([]);
  });

  it("reads the alias allowances this repository actually declares", () => {
    // The v0.6.0 renumber is repaired at runtime, so the guard must not keep
    // failing on it forever.
    expect(parseMigrationLineageAllowances(migrationsSource())).toContainEqual({
      id: 54,
      name: "ProjectPullRequestPins",
    });
    expect(parseMigrationLineageAllowances("export const other = [];")).toEqual([]);
  });

  it("reports one line per broken pair, listing every tag that shipped it", () => {
    const violation = { id: 54, releasedName: "ProjectPullRequestPins", currentName: null };
    expect(
      groupViolationsByPair([
        { tag: "v0.5.5", violations: [violation] },
        { tag: "v0.5.4", violations: [violation] },
      ]),
    ).toEqual([{ violation, tags: ["v0.5.5", "v0.5.4"] }]);
  });

  it("holds for this repository's own lineage", () => {
    const entries = parseMigrationLineage(migrationsSource());
    expect(findLineageStructureViolations(entries)).toEqual([]);
    expect(entries.length).toBeGreaterThan(50);
  });
});
