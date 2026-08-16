const ENV_ASSIGNMENT_START_PATTERN = /(^|\s)([A-Za-z_][A-Za-z0-9_]*)=/g;
const SENSITIVE_ENV_NAME =
  /^(?:API_?KEY|ACCESS_TOKEN|AUTH_TOKEN|AUTHORIZATION|KEY|PASSWORD|PASSPHRASE|SECRET|TOKEN)$/;
const SENSITIVE_ENV_NAME_SUFFIX =
  /_(?:API_?KEY|ACCESS_TOKEN|AUTH_TOKEN|AUTHORIZATION|KEY|PASSWORD|PASSPHRASE|SECRET|TOKEN)$/;

function redactSensitiveEnvironmentRemainder(args: string): string {
  for (const match of args.matchAll(ENV_ASSIGNMENT_START_PATTERN)) {
    const name = match[2]?.toUpperCase();
    if (!name || (!SENSITIVE_ENV_NAME.test(name) && !SENSITIVE_ENV_NAME_SUFFIX.test(name))) {
      continue;
    }

    // Process-table APIs flatten argv into one string and may discard the
    // quotes around a value containing spaces. Once a secret assignment
    // starts, its true boundary is therefore unknowable; fail closed instead
    // of exposing a suffix of the credential in diagnostics.
    return `${args.slice(0, match.index + match[0].length)}[redacted]`;
  }
  return args;
}

export function redactSensitiveProcessArgs(args: string): string {
  return redactSensitiveEnvironmentRemainder(args)
    .replace(
      /(--?(?:api[-_]?key|auth|authorization|key|password|secret|token)(?:=|\s+))(\S+)/gi,
      "$1[redacted]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bsyn_(?:pair|mcp)_v1_[A-Za-z0-9_-]+\b/g, "[redacted]");
}
