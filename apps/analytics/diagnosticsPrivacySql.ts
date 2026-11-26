// Historical diagnostics use the same closed metadata before grouping, filtering or limits.
import { DesktopUpdateFailureReason } from "@synara/contracts";
import {
  DIAGNOSTIC_PROCESSES,
  DIAGNOSTIC_CRASH_REASONS,
  DIAGNOSTIC_SIGNALS,
  diagnosticPayloadKind,
} from "@synara/shared/diagnosticsRedaction";

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const list = (values: Iterable<string>): string => [...values].map(literal).join(", ");
const category = (column: string, values: Iterable<string>, fallback = ""): string =>
  `CASE WHEN ${column} IN (${list(values)}) THEN ${column} ELSE ${literal(fallback)} END`;

// SQLite has no built-in regexp. Validate the complete release grammar, including the suffix.
function version(column: string, fallback: string): string {
  const base = `(CASE WHEN instr(${column}, '-') > 0 THEN substr(${column}, 1, instr(${column}, '-') - 1) ELSE ${column} END)`;
  const suffixes = ["beta", "remote", "canary"].map((tag) => {
    const prefix = `${base} || '-${tag}.'`;
    const number = `substr(${column}, length(${base}) + ${tag.length + 3})`;
    return `(substr(${column}, 1, length(${base}) + ${tag.length + 2}) = ${prefix}
      AND length(${number}) > 0 AND ${number} NOT GLOB '*[^0-9]*')`;
  });
  return `CASE WHEN length(${column}) BETWEEN 1 AND 32
    AND instr(${column}, char(0)) = 0
    AND ${base} NOT GLOB '*[^0-9.]*'
    AND length(${base}) - length(replace(${base}, '.', '')) = 2
    AND ${base} NOT LIKE '.%' AND ${base} NOT LIKE '%.' AND ${base} NOT LIKE '%..%'
    AND (${column} = ${base} OR ${suffixes.join(" OR ")})
    THEN ${column} ELSE ${literal(fallback)} END`;
}

const crashEvents = "event IN ('app.renderer-crash', 'app.child-process-crash')";
const process = category("process_type", DIAGNOSTIC_PROCESSES, "unknown");
const exitCode = "substr(reason, 6, instr(reason || ' ', ' ') - 6)";
const exitDigits = `(CASE WHEN substr(${exitCode}, 1, 1) = '-' THEN substr(${exitCode}, 2) ELSE ${exitCode} END)`;
const exitSignal = "substr(reason, instr(reason, ' ') + 1)";
const numericExit = `substr(reason, 1, 5) = 'code='
  AND (${process}) IN ('backend', 'server')
  AND (${exitCode} = 'null' OR (length(${exitDigits}) BETWEEN 1 AND 10 AND ${exitDigits} NOT GLOB '*[^0-9]*'))
  AND (instr(reason, ' ') = 0 OR ${exitSignal} IN (${list(["signal=null", ...[...DIAGNOSTIC_SIGNALS].map((signal) => `signal=${signal}`)])}))`;
const crashReason = `CASE
  WHEN reason IN (${list(DIAGNOSTIC_CRASH_REASONS)}) THEN reason
  WHEN ${numericExit} THEN 'code=' || CASE WHEN ${exitCode} = 'null' THEN 'null' ELSE CAST(CAST(${exitCode} AS INTEGER) AS TEXT) END
    || CASE WHEN instr(reason, ' ') = 0 THEN '' ELSE ' ' || ${exitSignal} END
  ELSE 'unknown' END`;

/** Shared projection/UPDATE expressions keep pending cleanup and historical readers consistent. */
export function diagnosticMetadataSql(events: ReadonlySet<string>): Record<string, string> {
  return {
    ts: "COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', ts), strftime('%Y-%m-%dT%H:%M:%fZ', received_at), '1970-01-01T00:00:00.000Z')",
    app_version: version("app_version", "0.0.0"),
    target_version: version("target_version", ""),
    event: category("event", events),
    kind: `CASE event ${[...events].map((event) => `WHEN ${literal(event)} THEN ${literal(diagnosticPayloadKind(event) ?? "")}`).join(" ")} ELSE '' END`,
    outcome: `CASE WHEN event = 'beta.installed' THEN ${category("outcome", ["imported", "import-failed", "fresh"], "unknown")}
      WHEN event = 'beta.left' THEN ${category("outcome", ["trash", "keep"], "unknown")}
      ELSE ${category("outcome", ["ok", "error"], "unknown")} END`,
    platform: category("platform", ["darwin", "win32", "linux"], "unknown"),
    arch: category("arch", ["arm64", "x64", "ia32", "arm"], "unknown"),
    source: category("source", ["main", "renderer"]),
    flavor: category("flavor", ["beta", "remote"], "unknown"),
    process_type: `CASE WHEN ${crashEvents} THEN ${process} ELSE '' END`,
    reason: `CASE WHEN ${crashEvents} THEN ${crashReason}
      WHEN event = 'update.error' THEN ${category("reason", DesktopUpdateFailureReason.literals, "unknown")}
      ELSE '' END`,
    error_context: category("error_context", ["check", "download", "install"]),
  };
}

/** Canonical issue keys are constructed before aggregation and are reused by detail lookups. */
export function diagnosticReadCteSql(metadata: Record<string, string>): string {
  const unchanged = [
    "id",
    "received_at",
    "install_id",
    "duration_ms",
    "client_id",
    "os_version",
    "locale",
    "projects",
    "active_threads",
    "message",
    "stack",
  ];
  return `WITH diagnostic_metadata AS (
    SELECT ${unchanged.join(", ")}, NULL AS log_tail,
      CASE WHEN length(fingerprint) BETWEEN 8 AND 32 AND instr(fingerprint, char(0)) = 0 AND fingerprint NOT GLOB '*[^0-9a-fA-F]*'
        THEN fingerprint ELSE '0000000000000000' END AS fingerprint,
      ${Object.entries(metadata)
        .map(([column, expression]) => `${expression} AS ${column}`)
        .join(",\n")}
    FROM events
  ), diagnostic_events AS (
    SELECT diagnostic_metadata.*, CASE
      WHEN event = 'app.error' THEN 'err:' || fingerprint
      WHEN ${crashEvents} THEN 'crash:' || process_type || ':' || reason
      WHEN event = 'update.error' THEN 'update:' || error_context END AS issue_key
    FROM diagnostic_metadata
  )`;
}
