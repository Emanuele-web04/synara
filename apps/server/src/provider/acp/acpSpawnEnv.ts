/**
 * Shared allowlist for building a restricted child-process environment for ACP
 * stdio providers. Prevents secret leakage from the parent process env while
 * keeping the vars ACP CLIs need to run (PATH, HOME, proxy, TLS, XDG, Windows
 * equivalents). Provider-specific prefixed vars (e.g. `DEVIN_`, `CURSOR_`) are
 * passed through on top.
 *
 * @module acpSpawnEnv
 */

/** Common env var names required by ACP CLIs (OS, shell, TLS, proxy, XDG). */
const COMMON_ACP_ENV_NAMES: ReadonlySet<string> = new Set([
  "PATH",
  "Path",
  "HOME",
  "USER",
  "SHELL",
  "LANG",
  "TERM",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "all_proxy",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  // Windows equivalents
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "SystemRoot",
  "PATHEXT",
  "COMSPEC",
]);

/**
 * Builds a restricted env for an ACP child process by allowlisting the parent
 * env. Keeps common OS/shell/TLS/proxy vars plus any vars whose names start
 * with one of `extraPrefixes` or appear in `extraNames`. Extra vars (e.g.
 * `CURSOR_AGENT_BROWSERLESS_ENV`) are merged on top.
 */
export function buildAcpSpawnEnv(input: {
  readonly extraPrefixes?: ReadonlyArray<string>;
  readonly extraNames?: ReadonlySet<string>;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): Record<string, string> {
  const extraNames = input.extraNames ?? new Set<string>();
  const extraPrefixes = input.extraPrefixes ?? [];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (
      COMMON_ACP_ENV_NAMES.has(key) ||
      extraNames.has(key) ||
      extraPrefixes.some((prefix) => key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  if (input.extraEnv) {
    for (const [key, value] of Object.entries(input.extraEnv)) {
      env[key] = value;
    }
  }
  return env;
}
