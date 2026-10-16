export interface HostEditFixture {
  text: string;
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
}

/** Test-only application of actual provider edits; never used as a file writer. */
export function applyHostEditFixture(contents: string, edits: readonly HostEditFixture[]): string {
  const lines = contents.split("\n");
  const offset = (line: number, column: number) => {
    if (
      !Number.isSafeInteger(line) ||
      !Number.isSafeInteger(column) ||
      line < 1 ||
      line > lines.length ||
      column < 1 ||
      column > lines[line - 1]!.length + 1
    ) {
      throw new Error("Provider returned an invalid fixture edit position.");
    }
    return (
      lines.slice(0, line - 1).reduce((size, value) => size + value.length + 1, 0) + column - 1
    );
  };
  const normalized = edits
    .map((edit) => ({
      start: offset(edit.range.startLineNumber, edit.range.startColumn),
      end: offset(edit.range.endLineNumber, edit.range.endColumn),
      text: edit.text,
    }))
    .sort((a, b) => a.start - b.start);
  let previousEnd = 0;
  for (const edit of normalized) {
    if (edit.start < previousEnd || edit.end < edit.start)
      throw new Error("Provider returned overlapping or reversed fixture edits.");
    previousEnd = edit.end;
  }
  return normalized
    .reverse()
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), contents);
}
