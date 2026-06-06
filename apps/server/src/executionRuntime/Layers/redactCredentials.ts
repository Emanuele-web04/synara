/**
 * Credential redaction for execution-runtime logs and errors.
 *
 * Two leakage paths this guards: a tokenized clone URL
 * (`https://user:TOKEN@host/...`) and a raw secret value appearing verbatim in
 * command output. Neither may reach a log line, an error detail, or persisted
 * runtime metadata. The redacted form keeps enough shape (scheme + host + path)
 * to stay debuggable without the secret.
 *
 * @module redactCredentials
 */

/** Replace `user:secret@` userinfo in any URL with `***@`. */
export const redactUrlCredentials = (value: string): string =>
  // Matches the userinfo segment of a URL authority: scheme://USERINFO@host.
  // The non-greedy userinfo capture stops at the first `@`, so a path that
  // happens to contain `@` is untouched.
  value.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/@\s]+@/g, "$1***@");

/**
 * Redact tokenized URLs everywhere in a string, then mask any of the supplied
 * raw secret values that survived (e.g. a token echoed by a failing command).
 * Empty/whitespace secrets are ignored so they cannot blank the whole string.
 */
export const redactSecrets = (value: string, secrets: ReadonlyArray<string>): string => {
  let redacted = redactUrlCredentials(value);
  for (const secret of secrets) {
    if (secret.trim().length === 0) {
      continue;
    }
    redacted = redacted.split(secret).join("***");
  }
  return redacted;
};
