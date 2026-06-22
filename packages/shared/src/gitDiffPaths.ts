const DIFF_HEADER_PREFIX = "diff --git ";
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

export function stripGitPatchPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function pushUtf8(bytes: number[], value: string): void {
  bytes.push(...textEncoder.encode(value));
}

export function readQuotedGitPath(
  input: string,
  startIndex: number,
): { value: string; endIndex: number } | null {
  if (input[startIndex] !== '"') {
    return null;
  }

  const bytes: number[] = [];
  let index = startIndex + 1;
  while (index < input.length) {
    const char = input[index];
    if (char === '"') {
      return { value: textDecoder.decode(new Uint8Array(bytes)), endIndex: index + 1 };
    }
    if (char === "\\") {
      const next = input[index + 1];
      if (next === undefined) {
        return null;
      }
      if (/[0-7]/.test(next)) {
        let octal = next;
        let octalIndex = index + 2;
        while (octal.length < 3 && /[0-7]/.test(input[octalIndex] ?? "")) {
          octal += input[octalIndex];
          octalIndex += 1;
        }
        bytes.push(Number.parseInt(octal, 8));
        index = octalIndex;
        continue;
      }
      const escaped =
        next === "n"
          ? "\n"
          : next === "t"
            ? "\t"
            : next === "r"
              ? "\r"
              : next === "b"
                ? "\b"
                : next === "f"
                  ? "\f"
                  : next;
      pushUtf8(bytes, escaped);
      index += 2;
      continue;
    }

    pushUtf8(bytes, char ?? "");
    index += 1;
  }
  return null;
}

export function unquoteGitPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith('"')) {
    return trimmed;
  }
  const parsed = readQuotedGitPath(trimmed, 0);
  return parsed?.endIndex === trimmed.length ? parsed.value : trimmed;
}

export function normalizeGitPatchPath(path: string): string {
  return stripGitPatchPrefix(unquoteGitPath(path));
}

function readQuotedDiffHeaderPath(body: string): string | null {
  const oldPath = readQuotedGitPath(body, 0);
  if (!oldPath) {
    return null;
  }
  const nextStart = body.slice(oldPath.endIndex).search(/\S/);
  if (nextStart < 0) {
    return null;
  }
  const newPath = readQuotedGitPath(body, oldPath.endIndex + nextStart);
  return newPath ? stripGitPatchPrefix(newPath.value) : null;
}

function readMatchingUnquotedDiffHeaderPath(body: string): string | null {
  if (!body.startsWith("a/")) {
    return null;
  }
  const rest = body.slice(2);
  let separatorIndex = rest.indexOf(" b/");
  while (separatorIndex >= 0) {
    const oldPath = rest.slice(0, separatorIndex);
    const newPath = rest.slice(separatorIndex + 3);
    if (oldPath === newPath) {
      return newPath;
    }
    separatorIndex = rest.indexOf(" b/", separatorIndex + 1);
  }
  return null;
}

export function parseGitDiffHeaderPath(headerLine: string): string | null {
  if (!headerLine.startsWith(DIFF_HEADER_PREFIX)) {
    return null;
  }
  const body = headerLine.slice(DIFF_HEADER_PREFIX.length).trim();
  if (body.startsWith('"')) {
    return readQuotedDiffHeaderPath(body);
  }
  const matchingPath = readMatchingUnquotedDiffHeaderPath(body);
  if (matchingPath) {
    return matchingPath;
  }
  const separatorIndex = body.indexOf(" b/");
  if (separatorIndex < 0) {
    return null;
  }
  return normalizeGitPatchPath(body.slice(separatorIndex + 1));
}

export function gitDiffHeaderMatchesPath(headerLine: string, filePath: string): boolean {
  const body = headerLine.slice(DIFF_HEADER_PREFIX.length).trim();
  if (body.startsWith('"')) {
    return parseGitDiffHeaderPath(headerLine) === filePath;
  }
  return body.endsWith(` b/${filePath}`);
}
