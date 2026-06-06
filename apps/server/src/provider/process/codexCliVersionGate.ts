import { spawnSync } from "node:child_process";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "../codexCliVersion.ts";
import { buildCodexProcessEnv } from "../../codexProcessEnv.ts";

const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;

/**
 * Local-only Codex CLI version gate. Lives on the local-process path so the
 * session manager stays off `node:child_process`; a remote execution target
 * cannot run `codex --version` against this host and skips or relocates it.
 */
export function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): void {
  const result = spawnSync(input.binaryPath, ["--version"], {
    cwd: input.cwd,
    env: buildCodexProcessEnv(input.homePath ? { homePath: input.homePath } : {}),
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CODEX_VERSION_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`);
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }
}
