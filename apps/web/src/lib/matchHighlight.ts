// client-side approximation of the server ranking in workspaceEntries.ts — NOT guaranteed to reproduce the server's exact runs; callers must pass a query normalized with normalizeWorkspaceEntrySearchQuery

export interface MatchSegment {
  text: string;
  matched: boolean;
  start: number;
}

function findSubsequenceIndices(haystack: string, needle: string): number[] | null {
  const indices: number[] = [];
  let needleIndex = 0;

  for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
    if (haystack[index] === needle[needleIndex]) {
      indices.push(index);
      needleIndex += 1;
    }
  }

  return needleIndex === needle.length ? indices : null;
}

function segmentsFromIndices(text: string, indices: number[]): MatchSegment[] {
  const segments: MatchSegment[] = [];
  let cursor = 0;
  let position = 0;

  while (position < indices.length) {
    const start = indices[position] as number;
    let end = start + 1;
    while (position + 1 < indices.length && indices[position + 1] === end) {
      end += 1;
      position += 1;
    }
    position += 1;

    if (start > cursor) {
      segments.push({ text: text.slice(cursor, start), matched: false, start: cursor });
    }
    segments.push({ text: text.slice(start, end), matched: true, start });
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), matched: false, start: cursor });
  }

  return segments;
}

export function buildMatchSegments(text: string, query: string): MatchSegment[] | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0 || text.length === 0) return null;

  const normalizedText = text.toLowerCase();
  // some code points change length when lowercased (İ) which would desync indices from the original — rare enough to skip emphasis
  if (normalizedText.length !== text.length) return null;

  const contiguousStart = normalizedText.indexOf(normalizedQuery);
  if (contiguousStart !== -1) {
    const indices: number[] = [];
    for (let offset = 0; offset < normalizedQuery.length; offset += 1) {
      indices.push(contiguousStart + offset);
    }
    return segmentsFromIndices(text, indices);
  }

  const subsequenceIndices = findSubsequenceIndices(normalizedText, normalizedQuery);
  return subsequenceIndices ? segmentsFromIndices(text, subsequenceIndices) : null;
}
