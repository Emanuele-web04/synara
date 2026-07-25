// FILE: launcherProtocol.ts
// Purpose: Environment protocol between the global launcher and provider processes.
// Layer: Cross-package pure utility

export const SYNARA_LAUNCHER_BYPASS = "SYNARA_LAUNCHER_BYPASS";
export const SYNARA_LAUNCHER_BYPASS_VALUE = "1";
export const SYNARA_ACCOUNT_OVERRIDE = "SYNARA_ACCOUNT_OVERRIDE";

export function isLauncherBypass(env: NodeJS.ProcessEnv): boolean {
  return env[SYNARA_LAUNCHER_BYPASS] === SYNARA_LAUNCHER_BYPASS_VALUE;
}

// Launcher control variables stripped from the environment before exec-ing the
// real provider binary, so they never leak into provider child processes.
export const launcherControlEnvVars: readonly string[] = [
  SYNARA_LAUNCHER_BYPASS,
  SYNARA_ACCOUNT_OVERRIDE,
];
