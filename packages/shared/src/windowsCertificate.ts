// FILE: windowsCertificate.ts
// Purpose: Normalizes Windows certificate distinguished names for consistent signer checks.
// Layer: Shared desktop/release security utilities

export function parseDistinguishedName(sequence: string): Map<string, string> {
  let quoted = false;
  let key: string | null = null;
  let token = "";
  let nextNonSpace = 0;
  const result = new Map<string, string>();
  const trimmed = sequence.trim();

  for (let i = 0; i <= trimmed.length; i += 1) {
    if (i === trimmed.length) {
      if (key !== null) {
        result.set(key, token);
      }
      break;
    }
    const ch = trimmed[i];
    if (quoted) {
      if (ch === '"') {
        quoted = false;
        continue;
      }
    } else {
      if (ch === '"') {
        quoted = true;
        continue;
      }
      if (ch === "\\") {
        i += 1;
        const ord = Number.parseInt(trimmed.slice(i, i + 2), 16);
        if (Number.isNaN(ord)) {
          token += trimmed[i] ?? "";
        } else {
          i += 1;
          token += String.fromCharCode(ord);
        }
        continue;
      }
      if (key === null && ch === "=") {
        key = token;
        token = "";
        continue;
      }
      if (ch === "," || ch === ";" || ch === "+") {
        if (key !== null) {
          result.set(key, token);
        }
        key = null;
        token = "";
        continue;
      }
    }
    if (ch === " " && !quoted) {
      if (token.length === 0) {
        continue;
      }
      if (i > nextNonSpace) {
        let j = i;
        while (trimmed[j] === " ") {
          j += 1;
        }
        nextNonSpace = j;
      }
      if (
        nextNonSpace >= trimmed.length ||
        trimmed[nextNonSpace] === "," ||
        trimmed[nextNonSpace] === ";" ||
        (key === null && trimmed[nextNonSpace] === "=") ||
        (key !== null && trimmed[nextNonSpace] === "+")
      ) {
        i = nextNonSpace - 1;
        continue;
      }
    }
    token += ch;
  }

  return result;
}

export function matchesDistinguishedName(expected: string, actual: string): boolean {
  const expectedFields = parseDistinguishedName(expected);
  if (!expectedFields.has("CN") || expectedFields.size < 2) {
    return false;
  }
  const actualFields = parseDistinguishedName(actual);
  return Array.from(expectedFields).every(
    ([key, expectedValue]) => actualFields.get(key) === expectedValue,
  );
}
