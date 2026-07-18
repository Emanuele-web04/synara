const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(?:(?:sk|pk)[-_]|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password)\s*[:=]\s*(?:["'][^"']+["']|[^\s,;]+)/gi,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/gi,
];

const ABSOLUTE_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|[^A-Za-z0-9])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|?*]+/g,
  /(^|[\s("'=])\/(?:Users|home|root|var|tmp|private|Volumes|mnt|opt|srv|etc)(?:\/[^\s"'<>]*)?/g,
];

function stripStackTrace(value: string): string {
  const kept: Array<string> = [];
  for (const line of value.split(/\r?\n/)) {
    if (
      /^\s*(?:at\s+\S+|Traceback\b|File\s+"[^"]+",\s+line\s+\d+)/i.test(line)
    ) {
      break;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function redactSensitiveText(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, "[redacted]");
  result = result.replace(ABSOLUTE_PATH_PATTERNS[0]!, "$1[path]");
  result = result.replace(ABSOLUTE_PATH_PATTERNS[1]!, "$1[path]");
  return result;
}

/** Sanitizes server-generated diagnostics before exposing them to a Companion client. */
export function sanitizeCompanionDiagnostic(
  value: unknown,
  maxChars: number,
): string | null {
  if (typeof value !== "string" || maxChars <= 0) return null;
  const normalized = redactSensitiveText(stripStackTrace(value))
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Produces the only free-form text allowed to leave the host in a push payload.
 * Fenced code is removed because it can contain file or terminal output.
 */
export function sanitizeCompanionPreview(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const withoutCodeBlocks = value.replace(/```[\s\S]*?(?:```|$)/g, " ");
  return sanitizeCompanionDiagnostic(withoutCodeBlocks, 160) ?? undefined;
}
