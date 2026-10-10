import { compareSemverVersions } from "./providerMaintenance.ts";

// Auto permission mode required `--enable-auto-mode` (never passed by Synara) before 2.1.111.
export const MINIMUM_CLAUDE_AUTO_MODE_CLI_VERSION = "2.1.111";

export function isClaudeAutoModeCliVersionSupported(version: string | null): boolean {
  return (
    version !== null && compareSemverVersions(version, MINIMUM_CLAUDE_AUTO_MODE_CLI_VERSION) >= 0
  );
}
