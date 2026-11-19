// FILE: providerAuthentication.ts
// Purpose: Resolve authentication in the same account environment used by managed sessions.
// Layer: Provider/terminal runtime boundary

import path from "node:path";
import type { ServerSettings, ServerSettingsPatch } from "@synara/contracts";
import { PROVIDER_AUTHENTICATION } from "@synara/shared/providerCliProfiles";
import { deriveProviderInstances } from "@synara/shared/providerInstances";
import {
  buildProviderChildEnvironment,
  providerCredentialKeysFor,
} from "../providerChildEnvironment";
import { expandProviderAccountHomePath } from "../providerAccountHomePath";
import { providerHomeEnvironment } from "../provider/providerProcessEnv";
import { ensurePrivateDirectorySync } from "../privatePathPermissions";
import { runProcess } from "../processRunner";
import { buildProviderProfileProcessEnv } from "./managedTerminalWrappers";
import { deriveManagedTerminalProfiles } from "./providerTerminalProfiles";

export interface ProviderAuthenticationLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

// Subcommands and flags that switch an agent CLI into ACP daemon mode. Sign-in
// launches the agent's normal interactive CLI instead, so these tokens are
// stripped from the configured argv while the executable or package spec is
// kept. Tokens seen in the official ACP registry launch definitions.
const ACP_MODE_ARG_TOKENS = new Set([
  "acp",
  "acp-daemon",
  "serve",
  "agent",
  "exec",
  "stdio",
  "daemon",
  "-x",
]);
// Flags that consume a separate value token (skipped together with it); the
// `=`-joined forms are dropped by the same entries.
const ACP_MODE_VALUE_FLAGS = new Set(["--mode", "--output-format", "--agent-engine", "--uid"]);

export function acpAuthenticationArgs(args: readonly string[]): readonly string[] {
  const launch: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const normalized = arg.trim().toLowerCase();
    const flag = normalized.split("=")[0]!;
    if (ACP_MODE_VALUE_FLAGS.has(flag)) {
      if (!normalized.includes("=")) index += 1;
      continue;
    }
    if (normalized.startsWith("--acp") || normalized === "--experimental-acp") continue;
    if (ACP_MODE_ARG_TOKENS.has(normalized)) continue;
    launch.push(arg);
  }
  return launch;
}

export function prepareProviderAuthenticationSettings(input: {
  readonly settings: ServerSettings;
  readonly instanceId: string;
  readonly homeDir: string;
  readonly stateDir: string;
}): ServerSettingsPatch | null {
  const instance = deriveProviderInstances(input.settings).find(
    (candidate) => candidate.instanceId === input.instanceId,
  );
  if (!instance?.enabled) throw new Error("This provider account is missing or disabled.");
  if (instance.driver === "opencode" && instance.config.serverUrl) {
    throw new Error(
      "This account uses an external OpenCode server. Authenticate on that server, then refresh status.",
    );
  }
  // These native adapters consume the configured environment directly. Save
  // their account roots before login so probes and later sessions read the same
  // credentials, rather than logging into a terminal-only synthetic home.
  if (
    (instance.isDefault && !instance.config.profileDir && instance.raw.environment === undefined) ||
    !["devin", "antigravity", "droid"].includes(instance.driver)
  ) {
    return null;
  }
  const profileDir =
    typeof instance.config.profileDir === "string" ? instance.config.profileDir.trim() : "";
  const directoryKind =
    instance.driver === "antigravity" ? "gemini" : instance.driver === "droid" ? "kilo" : "devin";
  const platform = process.platform;
  const normalizeName = (name: string) =>
    platform === "win32" ? name.trim().toUpperCase() : name.trim();
  const selectedEnvironment = Object.fromEntries(
    Object.entries(instance.environment).map(([name, value]) => [normalizeName(name), value]),
  );
  const home =
    profileDir ||
    selectedEnvironment.HOME ||
    selectedEnvironment.USERPROFILE ||
    path.join(
      input.stateDir,
      "provider-homes",
      directoryKind,
      `instance-${Buffer.from(input.instanceId).toString("hex")}`,
    );
  const nativeDriver =
    instance.driver === "devin" ? "devin" : instance.driver === "droid" ? "droid" : "antigravity";
  const defaults = {
    ...providerHomeEnvironment(expandProviderAccountHomePath(home, input.homeDir), platform),
    ...(instance.driver === "antigravity" ? { GEMINI_FORCE_FILE_STORAGE: "true" } : {}),
    // Block ambient API credentials in the native adapters as well as in the
    // terminal. Explicitly configured credentials continue to take precedence.
    ...Object.fromEntries(providerCredentialKeysFor(nativeDriver).map((name) => [name, ""])),
    ...(nativeDriver === "devin" && platform !== "win32" ? { windsurf_api_key: "" } : {}),
  };
  const configuredNames = new Set(
    (instance.raw.environment ?? []).map(({ name }) => normalizeName(name)),
  );
  const additions = Object.entries(defaults).flatMap(([name, value]) =>
    configuredNames.has(normalizeName(name)) || value === undefined
      ? []
      : [{ name, value, sensitive: false }],
  );
  if (additions.length === 0) return null;
  return {
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: {
        ...instance.raw,
        environment: [...additions, ...(instance.raw.environment ?? [])],
      },
    },
  };
}

export async function resolveProviderAuthenticationLaunch(input: {
  readonly settings: ServerSettings;
  readonly instanceId: string;
  readonly homeDir: string;
  readonly stateDir: string;
  readonly baseEnv: NodeJS.ProcessEnv;
}): Promise<ProviderAuthenticationLaunch> {
  const instance = deriveProviderInstances(input.settings).find(
    (candidate) => candidate.instanceId === input.instanceId,
  );
  if (!instance?.enabled) throw new Error("This provider account is missing or disabled.");
  const profile = (
    await deriveManagedTerminalProfiles({
      ...input,
      onlyInstanceId: input.instanceId,
      includeSensitiveEnvironment: true,
    })
  ).find((candidate) => candidate.instanceId === input.instanceId);
  if (!profile)
    throw new Error(
      "The provider CLI was not found. Install it or check its configured binary path.",
    );
  const cwd = path.join(
    input.stateDir,
    "provider-auth",
    Buffer.from(input.instanceId).toString("hex"),
  );
  ensurePrivateDirectorySync(cwd);
  const env = buildProviderChildEnvironment({
    provider: instance.driver === "claudeAgent" ? "claude" : instance.driver,
    baseEnv: buildProviderProfileProcessEnv(profile, input.baseEnv),
  });
  let args: readonly string[] = PROVIDER_AUTHENTICATION[instance.driver].args;
  if (instance.driver === "acp") {
    // ACP instances carry the agent's daemon argv in config; sign-in drops the
    // ACP-mode tokens so the agent's own interactive CLI (and its native
    // login) starts instead of the protocol server.
    const configured = instance.config.args;
    args = acpAuthenticationArgs(
      Array.isArray(configured)
        ? configured.filter((arg): arg is string => typeof arg === "string")
        : [],
    );
  }
  if (instance.driver === "opencode") {
    const help = await runProcess(profile.targetPath, [...args, "--help"], {
      env,
      cwd,
      timeoutMs: 5_000,
      maxBufferBytes: 64 * 1024,
      allowNonZeroExit: true,
    });
    if (help.timedOut || help.signal)
      throw new Error("Unable to check OpenCode's supported sign-in options. Retry signing in.");
    if (/^\s*--standalone(?:\s|$)/m.test(`${help.stdout}\n${help.stderr}`))
      args = [...args, "--standalone"];
  }
  return {
    command: profile.targetPath,
    args,
    env,
    cwd,
  };
}
