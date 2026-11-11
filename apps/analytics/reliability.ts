import {
  isReliabilityChannel,
  isReliabilityCode,
  isReliabilityDay,
  isReliabilityPlatform,
  isReliabilityReleaseVersion,
  type ReliabilityRecord,
} from "@synara/contracts/reliability";

const DAY_MS = 86_400_000;
export const RELIABILITY_RECEIPT_RETENTION_DAYS = 14;
export const RELIABILITY_TOTAL_RETENTION_DAYS = 90;
const MAX_AGGREGATE_ROWS = 1_000;

export async function storeReliabilityRecords(
  db: D1Database,
  records: ReadonlyArray<ReliabilityRecord>,
  receivedDay: string,
): Promise<string[]> {
  await db.batch(
    records.map((record) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO reliability_receipts
         (receipt_id, received_day, day, channel, app_version, platform, code)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          record.id.toLowerCase(),
          receivedDay,
          record.day,
          record.channel,
          record.appVersion,
          record.platform,
          record.code,
        ),
    ),
  );
  // A duplicate is acknowledged only after the transaction confirms the original receipt.
  return [...new Set(records.map((record) => record.id))];
}

const filters = [
  ["channel", "channel", isReliabilityChannel],
  ["platform", "platform", isReliabilityPlatform],
  ["version", "app_version", isReliabilityReleaseVersion],
  ["code", "code", isReliabilityCode],
] as const;

export async function readReliabilityTotals(db: D1Database, url: URL): Promise<Response> {
  const now = Date.now();
  const exactDay = url.searchParams.get("day");
  if (exactDay !== null && (url.searchParams.has("from") || url.searchParams.has("to"))) {
    return new Response("bad reliability day range", { status: 400 });
  }
  const from =
    exactDay ??
    url.searchParams.get("from") ??
    new Date(now - 6 * DAY_MS).toISOString().slice(0, 10);
  const to = exactDay ?? url.searchParams.get("to") ?? new Date(now).toISOString().slice(0, 10);
  if (
    !isReliabilityDay(from) ||
    !isReliabilityDay(to) ||
    from > to ||
    Date.parse(to) - Date.parse(from) >= RELIABILITY_TOTAL_RETENTION_DAYS * DAY_MS
  ) {
    return new Response("bad reliability day range", { status: 400 });
  }

  const clauses = ["day BETWEEN ? AND ?"];
  const binds = [from, to];
  for (const [parameter, column, accepts] of filters) {
    const value = url.searchParams.get(parameter);
    if (value === null) continue;
    if (!accepts(value)) return new Response("bad reliability filter", { status: 400 });
    clauses.push(`${column} = ?`);
    binds.push(value);
  }
  const { results } = await db
    .prepare(
      `SELECT day, channel, app_version AS appVersion, platform, code, count
       FROM reliability_daily
       WHERE ${clauses.join(" AND ")}
       ORDER BY day DESC, channel, app_version, platform, code
       LIMIT ?`,
    )
    .bind(...binds, MAX_AGGREGATE_ROWS + 1)
    .all();
  return Response.json({
    from,
    to,
    rows: results.slice(0, MAX_AGGREGATE_ROWS),
    truncated: results.length > MAX_AGGREGATE_ROWS,
  });
}
