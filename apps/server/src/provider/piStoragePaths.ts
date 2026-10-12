/**
 * Pi agent-directory resolution shared by the Pi adapter and Pi health checks.
 *
 * Kept free of Pi SDK imports so provider health refreshes can locate the
 * agent dir without loading the SDK (and its native clipboard module).
 */
import * as OS from "node:os";
import path from "node:path";

import { expandHomePath } from "@synara/shared/synaraHome";

import { providerIsolatedHomePath } from "./providerProcessEnv.ts";

const PROVIDER = "pi" as const;

function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Mirrors the Pi SDK's `getAgentDir()` (`PI_CODING_AGENT_DIR`, else
 * `~/.pi/agent`) for callers that must not import the SDK.
 */
export function defaultPiSdkAgentDir(
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  homeDir: string = OS.homedir(),
): string {
  const envDir = env.PI_CODING_AGENT_DIR;
  return envDir ? expandHomePath(envDir, homeDir) : path.join(homeDir, ".pi", "agent");
}

export function makePiStoragePaths(input: {
  readonly agentDir?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly instanceId?: string | undefined;
  readonly stateDir?: string | undefined;
  readonly homeDir: string;
  readonly sdkAgentDir: string;
}): { readonly agentDir: string; readonly sessionDir?: string } {
  const boundary =
    input.environment !== undefined ||
    (input.instanceId !== undefined && input.instanceId !== PROVIDER);
  const selectedAbsolutePath = (value: string | undefined) => {
    const selected = trimToUndefined(value);
    return selected && path.isAbsolute(selected) ? selected : undefined;
  };
  const selectedEnvironmentValue = (name: string) =>
    Object.entries(input.environment ?? {}).find(
      ([candidate]) => candidate.toUpperCase() === name,
    )?.[1];
  const selectedHome = selectedAbsolutePath(
    selectedEnvironmentValue("HOME") ?? selectedEnvironmentValue("USERPROFILE"),
  );
  const isolatedHome = providerIsolatedHomePath({
    driver: PROVIDER,
    instanceId: input.instanceId,
    homeDir: input.homeDir,
    isolationRootDir: input.stateDir,
  });
  const expansionHome = boundary ? (selectedHome ?? isolatedHome) : (selectedHome ?? input.homeDir);
  const expandHome = (value: string) =>
    value === "~" || value.startsWith("~/")
      ? path.join(expansionHome, value.slice(value === "~" ? 1 : 2))
      : value;
  const rawConfiguredAgentDir = trimToUndefined(input.agentDir);
  const configuredAgentDir = rawConfiguredAgentDir
    ? rawConfiguredAgentDir === "~" || rawConfiguredAgentDir.startsWith("~/")
      ? expandHome(rawConfiguredAgentDir)
      : !boundary || path.isAbsolute(rawConfiguredAgentDir)
        ? rawConfiguredAgentDir
        : undefined
    : undefined;
  const selectedAgentDir = selectedAbsolutePath(selectedEnvironmentValue("PI_CODING_AGENT_DIR"));
  if (!boundary && !configuredAgentDir && !selectedAgentDir) {
    return { agentDir: input.sdkAgentDir };
  }
  const agentDir =
    configuredAgentDir ??
    selectedAgentDir ??
    path.join(selectedHome ?? isolatedHome, ".pi", "agent");
  const selectedSessionDir = selectedAbsolutePath(
    selectedEnvironmentValue("PI_CODING_AGENT_SESSION_DIR"),
  );
  return {
    agentDir,
    sessionDir: expandHome(selectedSessionDir ?? path.join(agentDir, "sessions")),
  };
}
