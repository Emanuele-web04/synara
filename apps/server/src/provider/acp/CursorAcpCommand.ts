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

// Resolves persisted/default Cursor binary settings into the executable Synara should spawn.
export function resolveCursorAgentBinaryPath(binaryPath: string | null | undefined): string {
  const configuredBinaryPath = binaryPath?.trim();
  return !configuredBinaryPath || configuredBinaryPath === LEGACY_CURSOR_AGENT_BINARY
    ? DEFAULT_CURSOR_AGENT_BINARY
    : configuredBinaryPath;
}
