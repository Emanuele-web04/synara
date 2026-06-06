/**
 * Shared parser for `git status --porcelain=v1 -z`.
 *
 * The `-z` form is NUL-delimited and never quotes/escapes paths, so a path with
 * spaces or unusual bytes parses unambiguously. Each record is `XY<space>path`;
 * a rename/copy (`R`/`C` in either column) carries a second NUL-separated origin
 * path, which is skipped — the entry reports the new path.
 *
 * @module gitPorcelain
 */

export interface GitPorcelainEntry {
  readonly path: string;
  readonly status: string;
}

export const parsePorcelainZEntries = (output: string): ReadonlyArray<GitPorcelainEntry> => {
  const entries: GitPorcelainEntry[] = [];
  const records = output.split("\0");
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record === undefined || record.length === 0) {
      continue;
    }
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (status.charAt(0) === "R" || status.charAt(0) === "C") {
      i += 1;
    }
    entries.push({ path, status });
  }
  return entries;
};

export const parsePorcelainZPaths = (output: string): ReadonlyArray<string> =>
  parsePorcelainZEntries(output).map((entry) => entry.path);
