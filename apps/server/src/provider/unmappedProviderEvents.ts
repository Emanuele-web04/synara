import type { ProviderEvent } from "@synara/contracts";

export const MAX_UNMAPPED_PROVIDER_DATA_JSON_CHARS = 16_000;

const MAX_UNMAPPED_PROVIDER_DETAIL_CHARS = 500;
const MAX_UNMAPPED_PROVIDER_NATIVE_TYPE_CHARS = 200;
const MAX_UNMAPPED_PROVIDER_PREVIEW_CHARS = 2_000;
const REDACTED_VALUE = "[REDACTED]";
const BURST_METHOD_SUFFIX = /(?:delta|progress|partial|chunk|update|updated)$/iu;
const COOKIE_HEADER_PATTERN = /\b((?:set[-_ ]?cookie|cookie)\s*:\s*)[^\r\n]+/giu;
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]*:[^/\s@]+@/giu;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b((?:(?:proxy[-_ ]?)?authorization|api[-_ ]?key|private[-_ ]?key|(?:set[-_ ]?)?cookie|(?:access|refresh|session)[-_ ]?token|token|password|passwd|passphrase|client[-_ ]?secret|(?:aws[-_ ]?)?secret(?:[-_ ]?(?:access[-_ ]?)?key)?|credentials?)\s*(?::|=)\s*)(?:bearer\s+)?(?:\$'(?:\\[\s\S]|[^'\\])*(?:'|$)|"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|(?:\\[\s\S]|[^\s,;\\])+)/giu;
const ENV_CREDENTIAL_ASSIGNMENT_PREFIX_PATTERN =
  /(?<![A-Za-z0-9_])((["']?)([A-Za-z_][A-Za-z0-9_]*)\2\s*(?::|=)\s*)/giu;
const ENV_CREDENTIAL_TUPLE_PREFIX_PATTERN =
  /((?:^|,|\[)\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\2\s*,\s*)/giu;
const SHALLOW_JSON_OBJECT_PATTERN = /\{(?:"(?:\\[\s\S]|[^"\\])*"|[^{}"])*\}/gu;
const INCOMPLETE_SHALLOW_JSON_OBJECT_PATTERN = /\{(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|[^{}"])*$/gu;
const JSON_NAME_FIELD_PATTERN = /"name"\s*:\s*"((?:\\[\s\S]|[^"\\])*)"/iu;
const JSON_VALUE_FIELD_PATTERN =
  /("value"\s*:\s*)(?:"(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|[^\s,;}]+)/iu;
const BEARER_CREDENTIAL_PATTERN = /\b(bearer\s+)[A-Za-z0-9._~+/=-]+/giu;
const EXACT_SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "awsaccesskeyid",
  "password",
  "passphrase",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "privatekey",
]);
const SENSITIVE_TERMINAL_TOKENS = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "passphrase",
  "password",
  "secret",
  "token",
]);
const SENSITIVE_ENV_NAME_SUFFIXES = [
  "accesskeyid",
  "apikey",
  "password",
  "passwd",
  "passphrase",
  "privatekey",
  "secretkey",
  "secret",
  "token",
] as const;

function redactText(value: string): string {
  const preRedacted = value
    .replace(COOKIE_HEADER_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(URL_CREDENTIAL_PATTERN, `$1${REDACTED_VALUE}@`);
  const structured = redactSerializedJsonContainers(preRedacted)
    .replace(SHALLOW_JSON_OBJECT_PATTERN, redactNamedValueObject)
    .replace(INCOMPLETE_SHALLOW_JSON_OBJECT_PATTERN, redactNamedValueObject);
  return redactEnvironmentAssignments(redactEnvironmentTuples(structured))
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(BEARER_CREDENTIAL_PATTERN, `$1${REDACTED_VALUE}`);
}

function credentialValueEnd(value: string, valueStart: number): number {
  let index = valueStart;
  const bearerPrefix = /^bearer\s+/iu.exec(value.slice(index))?.[0];
  if (bearerPrefix) {
    index += bearerPrefix.length;
  }

  let quote: "'" | '"' | undefined;
  if (value.startsWith("$'", index)) {
    quote = "'";
    index += 2;
  } else if (value[index] === "'" || value[index] === '"') {
    quote = value[index];
    index += 1;
  }

  while (index < value.length) {
    if (value[index] === "\\" && index + 1 < value.length) {
      index += 2;
    } else if (quote && value[index] === quote) {
      quote = undefined;
      index += 1;
    } else if (quote) {
      index += 1;
    } else if (value[index] === "'" || value[index] === '"') {
      quote = value[index];
      index += 1;
    } else if (/\s|[,;}\]]/u.test(value[index] ?? "")) {
      break;
    } else {
      index += 1;
    }
  }
  return index;
}

function redactEnvironmentAssignments(value: string): string {
  let redacted = "";
  let cursor = 0;
  for (const match of value.matchAll(ENV_CREDENTIAL_ASSIGNMENT_PREFIX_PATTERN)) {
    const name = match[3];
    if (
      !name ||
      !isSensitiveEnvironmentName(name) ||
      match.index === undefined ||
      match.index < cursor
    ) {
      continue;
    }
    const valueStart = match.index + match[0].length;
    const valueEnd = credentialValueEnd(value, valueStart);
    redacted += value.slice(cursor, match.index) + match[0] + REDACTED_VALUE;
    cursor = valueEnd;
  }
  return redacted + value.slice(cursor);
}

function redactEnvironmentTuples(value: string): string {
  let redacted = "";
  let cursor = 0;
  for (const match of value.matchAll(ENV_CREDENTIAL_TUPLE_PREFIX_PATTERN)) {
    const name = match[3];
    if (
      !name ||
      !isSensitiveEnvironmentName(name) ||
      match.index === undefined ||
      match.index < cursor
    ) {
      continue;
    }
    const valueStart = match.index + match[0].length;
    if (value.startsWith(REDACTED_VALUE, valueStart)) {
      continue;
    }
    const valueEnd = credentialValueEnd(value, valueStart);
    redacted += value.slice(cursor, match.index) + match[0] + REDACTED_VALUE;
    cursor = valueEnd;
  }
  return redacted + value.slice(cursor);
}

function redactSerializedJsonContainers(value: string): string {
  let redacted = "";
  let cursor = 0;
  let containerStart = -1;
  const closingCharacters: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (closingCharacters.length === 0) {
      if (character === "{" || character === "[") {
        containerStart = index;
        closingCharacters.push(character === "{" ? "}" : "]");
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{" || character === "[") {
      closingCharacters.push(character === "{" ? "}" : "]");
    } else if (character === closingCharacters.at(-1)) {
      closingCharacters.pop();
      if (closingCharacters.length === 0 && containerStart >= 0) {
        const serializedValue = value.slice(containerStart, index + 1);
        redacted += value.slice(cursor, containerStart) + redactParsedJsonValue(serializedValue);
        cursor = index + 1;
        containerStart = -1;
      }
    } else if (character === "}" || character === "]") {
      closingCharacters.length = 0;
      containerStart = -1;
    }
  }

  return redacted + value.slice(cursor);
}

function redactParsedJsonValue(serializedValue: string): string {
  try {
    const parsed: unknown = JSON.parse(serializedValue);
    const result = redactParsedEnvironmentValue(parsed);
    return result.changed ? JSON.stringify(result.value) : serializedValue;
  } catch {
    return serializedValue;
  }
}

function redactParsedEnvironmentValue(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    if (isSensitiveEnvironmentTuple(value)) {
      return {
        value: [value[0], REDACTED_VALUE],
        changed: value[1] !== REDACTED_VALUE,
      };
    }
    let changed = false;
    const entries = value.map((entry) => {
      const result = redactParsedEnvironmentValue(entry);
      changed ||= result.changed;
      return result.value;
    });
    return { value: entries, changed };
  }
  if (typeof value === "string") {
    const redacted = redactText(value);
    return { value: redacted, changed: redacted !== value };
  }
  if (value === null || typeof value !== "object") {
    return { value, changed: false };
  }

  const record = value as Record<string, unknown>;
  const namedValueIsSensitive =
    typeof record.name === "string" && isSensitiveEnvironmentName(record.name);
  let changed = false;
  const entries = Object.entries(record).map(([key, entry]) => {
    if (isSensitiveEnvironmentName(key) || (namedValueIsSensitive && key === "value")) {
      changed ||= entry !== REDACTED_VALUE;
      return [key, REDACTED_VALUE] as const;
    }
    const result = redactParsedEnvironmentValue(entry);
    changed ||= result.changed;
    return [key, result.value] as const;
  });
  return { value: Object.fromEntries(entries), changed };
}

function sanitizeText(value: string, maxChars: number): string {
  const redacted = redactText(value);
  return redacted.length <= maxChars
    ? redacted
    : `${redacted.slice(0, Math.max(0, maxChars - 3))}...`;
}

function keyTokens(key: string): ReadonlyArray<string> {
  return (
    key
      .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/gu) ?? []
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (EXACT_SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  const tokens = keyTokens(key);
  const terminal = tokens.at(-1);
  return (
    terminal !== undefined &&
    (SENSITIVE_TERMINAL_TOKENS.has(terminal) ||
      (terminal === "key" &&
        tokens.slice(0, -1).some((token) => ["api", "private", "secret"].includes(token))))
  );
}

function isSensitiveEnvironmentName(name: string): boolean {
  if (isSensitiveKey(name)) {
    return true;
  }
  const tokens = keyTokens(name);
  if (tokens.length > 1 && tokens.at(-1) === "key") {
    return true;
  }
  const normalized = name.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return SENSITIVE_ENV_NAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function isSensitiveEnvironmentTuple(value: ReadonlyArray<unknown>): boolean {
  return value.length === 2 && typeof value[0] === "string" && isSensitiveEnvironmentName(value[0]);
}

function redactNamedValueObject(serializedObject: string): string {
  const name = JSON_NAME_FIELD_PATTERN.exec(serializedObject)?.[1];
  if (!name || !isSensitiveEnvironmentName(name)) {
    return serializedObject;
  }
  return serializedObject.replace(JSON_VALUE_FIELD_PATTERN, `$1${REDACTED_VALUE}`);
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value !== "object") return null;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    if (isSensitiveEnvironmentTuple(value)) {
      return [value[0], REDACTED_VALUE];
    }
    return value.map((entry) => redactValue(entry, seen));
  }

  const namedValueIsSensitive =
    "name" in value && typeof value.name === "string" && isSensitiveEnvironmentName(value.name);
  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] =
      isSensitiveEnvironmentName(key) || (namedValueIsSensitive && key === "value")
        ? REDACTED_VALUE
        : redactValue(entry, seen);
  }
  return redacted;
}

export function sanitizeUnmappedProviderData(value: unknown): unknown {
  const redacted = redactValue(value);
  const serialized = JSON.stringify(redacted) ?? "null";
  if (serialized.length <= MAX_UNMAPPED_PROVIDER_DATA_JSON_CHARS) {
    return redacted;
  }
  return {
    __synaraTruncated: true,
    originalJsonChars: serialized.length,
    preview: `${serialized.slice(0, MAX_UNMAPPED_PROVIDER_PREVIEW_CHARS - 3)}...`,
  };
}

export function sanitizeUnmappedProviderDetail(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeText(value, MAX_UNMAPPED_PROVIDER_DETAIL_CHARS);
}

export function sanitizeUnmappedProviderNativeType(value: string): string {
  return sanitizeText(value, MAX_UNMAPPED_PROVIDER_NATIVE_TYPE_CHARS);
}

export function sanitizeUnmappedProviderEvent(event: ProviderEvent): ProviderEvent {
  return {
    ...event,
    method: sanitizeUnmappedProviderNativeType(event.method),
    ...(event.message !== undefined
      ? { message: sanitizeText(event.message, MAX_UNMAPPED_PROVIDER_DETAIL_CHARS) }
      : {}),
    ...(event.textDelta !== undefined
      ? { textDelta: sanitizeText(event.textDelta, MAX_UNMAPPED_PROVIDER_DETAIL_CHARS) }
      : {}),
    ...(event.payload !== undefined
      ? { payload: sanitizeUnmappedProviderData(event.payload) }
      : {}),
  };
}

export function makeUnmappedProviderEventGate(maxTrackedBursts = 128) {
  const surfacedBursts = new Set<string>();
  return (event: ProviderEvent): boolean => {
    if (!BURST_METHOD_SUFFIX.test(event.method)) return true;
    const generation = event.lifecycleGeneration?.slice(0, 200) ?? "session";
    const key = `${event.threadId}\u0000${generation}\u0000${sanitizeUnmappedProviderNativeType(event.method)}`;
    if (surfacedBursts.has(key)) return false;
    if (surfacedBursts.size >= Math.max(1, maxTrackedBursts)) {
      const oldest = surfacedBursts.values().next().value;
      if (oldest !== undefined) surfacedBursts.delete(oldest);
    }
    surfacedBursts.add(key);
    return true;
  };
}
