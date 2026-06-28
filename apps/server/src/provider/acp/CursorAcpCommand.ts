/**
 * CursorAcpCommand - shared command resolution for Cursor's ACP-capable CLI.
 *
 * Keeps the ambiguous legacy `agent` default from colliding with Grok's `agent`
 * executable while still honoring explicit custom Cursor binary paths.
 *
 * @module CursorAcpCommand
 */

export const DEFAULT_CURSOR_AGENT_BINARY = "cursor-agent";
export const LEGACY_CURSOR_AGENT_BINARY = "agent";
export const CURSOR_AGENT_BROWSERLESS_ENV = {
  NO_BROWSER: "true",
  BROWSER: "www-browser",
} as const satisfies Readonly<Record<string, string>>;
export const CURSOR_AGENT_HEADLESS_PROBE_ENV = {
  ...CURSOR_AGENT_BROWSERLESS_ENV,
  CI: "true",
  DEBIAN_FRONTEND: "noninteractive",
} as const satisfies Readonly<Record<string, string>>;

// Resolves persisted/default Cursor binary settings into the executable Synara should spawn.
export function resolveCursorAgentBinaryPath(binaryPath: string | null | undefined): string {
  const configuredBinaryPath = binaryPath?.trim();
  return !configuredBinaryPath || configuredBinaryPath === LEGACY_CURSOR_AGENT_BINARY
    ? DEFAULT_CURSOR_AGENT_BINARY
    : configuredBinaryPath;
}

// Cursor auth/status probes must stay headless so provider refreshes never open login browsers.
export function buildCursorAgentHeadlessEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    ...CURSOR_AGENT_HEADLESS_PROBE_ENV,
  };
}
