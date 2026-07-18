import type { DiffFile, DiffLine } from "../domain";

export function parseUnifiedDiff(diff: string): readonly DiffFile[] {
  const files: Array<{ path: string; additions: number; deletions: number; lines: DiffLine[] }> = [];
  let current: (typeof files)[number] | null = null;
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(text);
      current = {
        path: match?.[2] ?? "Changed file",
        additions: 0,
        deletions: 0,
        lines: [],
      };
      files.push(current);
      oldLine = undefined;
      newLine = undefined;
      continue;
    }
    if (!current) continue;

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      current.lines.push({ kind: "header", text });
    } else if (text.startsWith("+") && !text.startsWith("+++")) {
      current.additions += 1;
      current.lines.push({
        kind: "addition",
        ...(newLine === undefined ? {} : { newLine }),
        text: text.slice(1),
      });
      if (newLine !== undefined) newLine += 1;
    } else if (text.startsWith("-") && !text.startsWith("---")) {
      current.deletions += 1;
      current.lines.push({
        kind: "deletion",
        ...(oldLine === undefined ? {} : { oldLine }),
        text: text.slice(1),
      });
      if (oldLine !== undefined) oldLine += 1;
    } else {
      current.lines.push({
        kind: "context",
        ...(oldLine === undefined ? {} : { oldLine }),
        ...(newLine === undefined ? {} : { newLine }),
        text: text.startsWith(" ") ? text.slice(1) : text,
      });
      if (text.startsWith(" ")) {
        if (oldLine !== undefined) oldLine += 1;
        if (newLine !== undefined) newLine += 1;
      }
    }
  }
  return files;
}
