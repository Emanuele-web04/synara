// FILE: claudeAppLaunch.ts
// Purpose: Claude desktop app launch spec and plan builder (plan sections 8.2, 27).
// Layer: Server service internals
// Exports: resolveClaudeDesktopExecutable, buildClaudeDesktopLaunchPlan
//          (also self-registers the app launch spec for "claudeAgent").

import { join } from "node:path";

import type { ProviderAccountLaunchContext, ProviderAppLaunchPlan } from "@synara/contracts";
import { supportLevelFor } from "@synara/shared/providerAccounts/capabilities";

import { registerProviderAppLaunchSpec } from "./appLaunch";

export interface ClaudeDesktopPlatform {
  readonly platform: NodeJS.Platform;
  readonly localAppData?: string;
}

const currentPlatform = (): ClaudeDesktopPlatform => ({
  platform: process.platform,
  ...(process.env.LOCALAPPDATA !== undefined ? { localAppData: process.env.LOCALAPPDATA } : {}),
});

/**
 * Resolves the official Claude desktop app executable for the host platform.
 * Returns undefined where no official desktop build exists: launch must stay
 * unavailable rather than guessing at a binary (plan section 8.2).
 */
export function resolveClaudeDesktopExecutable(
  host: ClaudeDesktopPlatform = currentPlatform(),
): string | undefined {
  if (host.platform === "darwin") {
    return "/Applications/Claude.app/Contents/MacOS/Claude";
  }
  if (host.platform === "win32" && host.localAppData !== undefined) {
    return join(host.localAppData, "AnthropicClaude", "claude.exe");
  }
  return undefined;
}

export interface ClaudeDesktopLaunchPlanInput {
  readonly ordinal: number;
  readonly accountLaunch?: ProviderAccountLaunchContext;
  readonly host?: ClaudeDesktopPlatform;
}

/**
 * Builds the Claude desktop app launch plan. Managed accounts carry the
 * resolved app-surface environment (CLAUDE_CONFIG_DIR pinned to the account
 * app data dir with conflicting inherited auth stripped); account 0 opens the
 * official app with no environment overrides.
 */
export function buildClaudeDesktopLaunchPlan(
  input: ClaudeDesktopLaunchPlanInput,
): ProviderAppLaunchPlan | undefined {
  const executable = resolveClaudeDesktopExecutable(input.host ?? currentPlatform());
  if (executable === undefined) {
    return undefined;
  }
  return {
    provider: "claudeAgent",
    ordinal: input.ordinal,
    appGeneration: input.accountLaunch?.generation ?? 1,
    executable,
    args: [],
    environment: input.accountLaunch?.environment ?? {},
    supportLevel: input.ordinal > 0 ? supportLevelFor("claudeAgent", "app", "oauth") : "supported",
  } satisfies ProviderAppLaunchPlan;
}

registerProviderAppLaunchSpec("claudeAgent", () => {
  const executable = resolveClaudeDesktopExecutable();
  return executable === undefined ? undefined : { executable };
});
