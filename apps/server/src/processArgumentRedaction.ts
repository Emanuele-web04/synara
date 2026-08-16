const SENSITIVE_ENV_ASSIGNMENT_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:API_?KEY|(?:ACCESS|PRIVATE|SECRET)_KEY|ACCESS_TOKEN|AUTH_TOKEN|AUTHORIZATION|PASSWORD|PASSPHRASE|SECRET|TOKEN)=)(?:"(?:\\.|[^"\\])*"|'[^']*'|\\[^\r\n]|[^\s"'\\;&|()<>])+/gi;

export function redactSensitiveProcessArgs(args: string): string {
  return args
    .replace(
      /(--?(?:api[-_]?key|auth|authorization|key|password|secret|token)(?:=|\s+))(\S+)/gi,
      "$1[redacted]",
    )
    .replace(SENSITIVE_ENV_ASSIGNMENT_PATTERN, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(/\bsyn_(?:pair|mcp)_v1_[A-Za-z0-9_-]+\b/g, "[redacted]");
}
