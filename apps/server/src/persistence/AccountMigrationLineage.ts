import { createHash } from "node:crypto";

/** Private account builds; these are whole lineages, not interchangeable aliases. */
export const ACCOUNT_MIGRATION_LINEAGES = [
  {
    // Remote trial builds before released ProjectSourceFolders occupied 131–135.
    prefix: 130,
    tail: [
      "AccountUsageSync",
      "AccountUsageSyncIdentity",
      "RemoteDeviceTrust",
      "RemoteConnectionPreferences",
      "RemoteAccessControls",
    ],
  },
  { prefix: 89, tail: ["AccountUsageSync"] },
  { prefix: 90, tail: ["AccountUsageSync"] },
  { prefix: 90, tail: ["AccountUsageSync", "AccountUsageSyncIdentity"] },
  { prefix: 98, tail: ["AccountUsageSync", "AccountUsageSyncIdentity"] },
  { prefix: 99, tail: ["AccountUsageSync", "AccountUsageSyncIdentity"] },
  {
    prefix: 108,
    tail: [
      "AccountUsageSync",
      "AccountUsageSyncIdentity",
      "RemoteDeviceTrust",
      "RemoteConnectionPreferences",
    ],
  },
  {
    // Private remote builds after the main sidechat-context migration used 127–130.
    prefix: 126,
    tail: [
      "AccountUsageSync",
      "AccountUsageSyncIdentity",
      "RemoteDeviceTrust",
      "RemoteConnectionPreferences",
    ],
  },
] as const;

export type MigrationIdentity = { readonly migration_id: number; readonly name: string };
export const migrationTrackerFingerprint = (rows: readonly MigrationIdentity[]): string =>
  createHash("sha256")
    .update(JSON.stringify(rows.map((r) => [r.migration_id, r.name])))
    .digest("hex");

export function classifyAccountMigrationLineage(
  rows: readonly MigrationIdentity[],
  canonical: ReadonlyMap<number, string>,
) {
  const privateRows = rows.filter(
    (row) =>
      row.name.startsWith("AccountUsageSync") && canonical.get(row.migration_id) !== row.name,
  );
  if (privateRows.length === 0) return null;
  for (const lineage of ACCOUNT_MIGRATION_LINEAGES) {
    const tailLength = rows.length - lineage.prefix;
    if (tailLength < 1 || tailLength > lineage.tail.length) continue;
    const matches = rows.every((row, index) => {
      const id = index + 1;
      const expected =
        id <= lineage.prefix ? canonical.get(id) : lineage.tail[id - lineage.prefix - 1];
      // The two supported legacy metadata repairs are normalized only for comparison.
      const name =
        id === 32 &&
        rows
          .slice(0, 31)
          .every((r, i) => r.migration_id === i + 1 && r.name === canonical.get(i + 1))
          ? canonical.get(32)
          : id === 54 && row.name === "ProjectPullRequestPins"
            ? canonical.get(54)
            : row.name;
      return row.migration_id === id && name === expected;
    });
    if (matches)
      return {
        resumeAfter: lineage.prefix,
        removeTrackerRows: rows.slice(lineage.prefix),
        fingerprint: migrationTrackerFingerprint(rows),
        requiresIdentity: rows.some((r) => r.name === "AccountUsageSyncIdentity"),
      };
  }
  throw new Error("Unrecognized private account migration lineage; no tracker changes were made.");
}

/** Shared by live migration, backup inspection, and staged Beta imports. */
export function validateAccountMigrationSchema(
  columns: readonly Record<string, unknown>[],
  rows: readonly Record<string, unknown>[],
  requiresIdentity: boolean,
): void {
  const byName = new Map(columns.map((c) => [c.name, c]));
  const names = ["id", "watermark_minute", "last_failure_at"];
  if (requiresIdentity || byName.has("account_identity")) names.push("account_identity");
  if (
    columns.length !== names.length ||
    names.some((name) => {
      const column = byName.get(name);
      return (
        !column ||
        String(column.type).toUpperCase() !== (name === "id" ? "INTEGER" : "TEXT") ||
        (name === "id" ? column.pk !== 1 : column.notnull !== 0)
      );
    }) ||
    rows.length !== 1 ||
    rows[0]?.id !== 1 ||
    names.slice(1).some((name) => rows[0]?.[name] !== null && typeof rows[0]?.[name] !== "string")
  ) {
    throw new Error(
      "Private account migration schema or singleton is incompatible; restore a verified backup.",
    );
  }
}
