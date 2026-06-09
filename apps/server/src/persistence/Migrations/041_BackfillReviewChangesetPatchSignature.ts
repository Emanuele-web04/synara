import { createHash } from "node:crypto";

import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

interface ReviewDiffCacheRow {
  readonly repositoryId: string;
  readonly reference: string;
  readonly headSha: string;
  readonly payloadJson: string;
}

function patchSignature(patch: string): string {
  return createHash("sha256").update(patch).digest("hex").slice(0, 16);
}

function backfillPayload(payloadJson: string): string | null {
  const parsed: unknown = JSON.parse(payloadJson);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const patch = record["patch"];
  if (typeof patch !== "string") {
    return null;
  }
  const existingPatchSignature = record["patchSignature"];
  const patchSource = record["patchSource"];
  const next = {
    ...record,
    patchSignature:
      typeof existingPatchSignature === "string" && existingPatchSignature.trim().length > 0
        ? existingPatchSignature
        : patchSignature(patch),
    patchSource:
      patchSource === "github" ||
      patchSource === "localFallback" ||
      patchSource === "localBranchRange"
        ? patchSource
        : record["pullRequest"] !== undefined
          ? "github"
          : "localBranchRange",
  };
  return JSON.stringify(next);
}

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'review_cache_pr_diff'
  `;
  if (tables.length === 0) {
    return;
  }

  const rows = yield* sql<ReviewDiffCacheRow>`
    SELECT
      repository_id AS "repositoryId",
      reference,
      head_sha AS "headSha",
      payload_json AS "payloadJson"
    FROM review_cache_pr_diff
    WHERE instr(payload_json, '"patchSignature"') = 0
       OR instr(payload_json, '"patchSource"') = 0
  `;

  for (const row of rows) {
    const payloadJson = yield* Effect.try({
      try: () => backfillPayload(row.payloadJson),
      catch: () => null,
    });
    if (payloadJson === null) {
      continue;
    }
    yield* sql`
      UPDATE review_cache_pr_diff
      SET payload_json = ${payloadJson}
      WHERE repository_id = ${row.repositoryId}
        AND reference = ${row.reference}
        AND head_sha = ${row.headSha}
    `;
  }
});
