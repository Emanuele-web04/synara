// FILE: providerTerminalProfiles.ts
// Purpose: Derive shell-neutral terminal CLI profiles from provider instances.
// Layer: Terminal runtime utility

import path from "node:path";

import type { ProviderKind, ServerSettings } from "@synara/contracts";
import {
  PROVIDER_CLI_COMMAND_BY_KIND,
  providerCliCommandName,
} from "@synara/shared/providerCliProfiles";
import { deriveProviderInstances } from "@synara/shared/providerInstances";

import { buildCodexProcessEnv } from "../codexProcessEnv.ts";
import { resolveExecutable } from "../executableLookup.ts";
import { expandProviderAccountHomePath } from "../providerAccountHomePath.ts";
import { buildClaudeInstanceProcessEnv } from "../provider/claudeEnvironment.ts";
import { buildProviderProcessEnv } from "../provider/providerProcessEnv.ts";
import type { ManagedTerminalProfile } from "./managedTerminalWrappers.ts";

const GENERIC_DRIVER_BY_PROVIDER = {
  cursor: "cursor",
  antigravity: "gemini",
  grok: "grok",
  droid: "kilo",
  opencode: "opencode",
  pi: "pi",
} as const;

const PROFILE_ENVIRONMENT_KEYS = new Set([
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "CURSOR_CONFIG_DIR",
  "GROK_AUTH_PATH",
  "GROK_HOME",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "USERPROFILE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);

function readConfigString(config: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nonSensitiveEnvironment(
  instance: ReturnType<typeof deriveProviderInstances>[number],
): Record<string, string> {
  return Object.fromEntries(
    (instance.raw.environment ?? []).flatMap((variable) => {
      const name = variable.name.trim();
      return name && typeof variable.value === "string" && variable.sensitive !== true &&
        variable.valueRedacted !== true
        ? [[name, variable.value ?? ""]]
        : [];
    }),
  );
}

function selectedProfileEnvironment(
  generated: Readonly<NodeJS.ProcessEnv>,
  configured: Readonly<Record<string, string>>,
): Record<string, string> {
  const selected = new Set([...PROFILE_ENVIRONMENT_KEYS, ...Object.keys(configured)]);
  return Object.fromEntries(
    Object.entries(generated).filter(
      (entry): entry is [string, string] => selected.has(entry[0]) && entry[1] !== undefined,
    ),
  );
}

function binaryPathForProvider(
  provider: ProviderKind,
  config: Readonly<Record<string, unknown>>,
  baseEnv: NodeJS.ProcessEnv,
): string | null {
  const configured = readConfigString(config, "binaryPath");
  return resolveExecutable(configured ?? PROVIDER_CLI_COMMAND_BY_KIND[provider], { env: baseEnv });
}

export async function deriveManagedTerminalProfiles(input: {
  readonly settings: ServerSettings;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly stateDir: string;
}): Promise<ManagedTerminalProfile[]> {
  const profiles: ManagedTerminalProfile[] = [];
  const commandNames = new Set<string>();

  for (const instance of deriveProviderInstances(input.settings)) {
    if (!instance.enabled) continue;
    const commandName = providerCliCommandName({
      provider: instance.driver,
      instanceId: instance.instanceId,
      config: instance.config,
    });
    if (commandNames.has(commandName)) continue;
    const targetPath = binaryPathForProvider(instance.driver, instance.config, input.baseEnv);
    if (!targetPath) continue;

    const configuredEnvironment = nonSensitiveEnvironment(instance);
    const profileDir = readConfigString(instance.config, "profileDir");
    const profileEnvironment =
      profileDir && !["codex", "claudeAgent", "pi"].includes(instance.driver)
        ? instance.driver === "cursor"
          ? { CURSOR_CONFIG_DIR: expandProviderAccountHomePath(profileDir, input.homeDir) }
          : instance.driver === "grok"
            ? { GROK_HOME: expandProviderAccountHomePath(profileDir, input.homeDir) }
            : { HOME: expandProviderAccountHomePath(profileDir, input.homeDir) }
        : {};
    Object.assign(configuredEnvironment, profileEnvironment);
    const isolated = !instance.isDefault || instance.raw.environment !== undefined;
    let environment: Record<string, string> = configuredEnvironment;

    if (instance.driver === "codex") {
      const homePath = readConfigString(instance.config, "homePath") ?? profileDir;
      const shadowHomePath = readConfigString(instance.config, "shadowHomePath");
      const accountId =
        readConfigString(instance.config, "accountId") ??
        (!instance.isDefault && !shadowHomePath ? String(instance.instanceId) : undefined);
      if (isolated || homePath || shadowHomePath || accountId) {
        const generated = await buildCodexProcessEnv({
          env: { ...input.baseEnv, ...configuredEnvironment },
          ...(homePath ? { homePath } : {}),
          ...(shadowHomePath ? { shadowHomePath } : {}),
          ...(accountId ? { accountId } : {}),
          explicitProviderEnvironment: configuredEnvironment,
          isolateProviderCredentials: true,
        });
        environment = selectedProfileEnvironment(generated, configuredEnvironment);
      }
    } else if (instance.driver === "claudeAgent") {
      const configured = {
        ...configuredEnvironment,
        ...(readConfigString(instance.config, "configDir") ?? profileDir
          ? {
              CLAUDE_CONFIG_DIR: expandProviderAccountHomePath(
                (readConfigString(instance.config, "configDir") ?? profileDir)!,
                input.homeDir,
              ),
            }
          : {}),
        ...(readConfigString(instance.config, "secureStorageDir")
          ? {
              CLAUDE_SECURESTORAGE_CONFIG_DIR: expandProviderAccountHomePath(
                readConfigString(instance.config, "secureStorageDir")!,
                input.homeDir,
              ),
            }
          : {}),
      };
      const generated = buildClaudeInstanceProcessEnv(
        readConfigString(instance.config, "homePath"),
        isolated || Object.keys(configured).length > 0 ? configured : undefined,
        {
          homeDir: input.homeDir,
          isolationRootDir: input.stateDir,
          providerInstanceId: instance.instanceId,
          baseEnvironment: input.baseEnv,
        },
      );
      environment = selectedProfileEnvironment(generated, configured);
    } else if (instance.driver !== "devin") {
      const genericDriver = GENERIC_DRIVER_BY_PROVIDER[instance.driver];
      const generated = buildProviderProcessEnv({
        driver: genericDriver,
        env: input.baseEnv,
        ...(isolated ? { environment: configuredEnvironment } : {}),
        instanceId: instance.instanceId,
        homeDir: input.homeDir,
        isolationRootDir: input.stateDir,
      });
      environment = selectedProfileEnvironment(generated, configuredEnvironment);
      if (instance.driver === "pi") {
        const agentDir = readConfigString(instance.config, "agentDir") ?? profileDir;
        if (agentDir) {
          environment.PI_CODING_AGENT_DIR = expandProviderAccountHomePath(agentDir, input.homeDir);
        }
      }
    } else if (!instance.isDefault) {
      const homePath = path.join(
        input.stateDir,
        "provider-homes",
        "devin",
        `instance-${Buffer.from(String(instance.instanceId), "utf8").toString("hex")}`,
      );
      environment = { ...configuredEnvironment, HOME: homePath };
    }

    profiles.push({
      commandName,
      targetPath,
      environment,
      isolateEnvironment: isolated,
      omittedSensitiveEnvironmentNames: (instance.raw.environment ?? [])
        .filter((variable) => variable.sensitive === true || variable.valueRedacted === true)
        .map((variable) => variable.name.trim())
        .filter(Boolean),
    });
    commandNames.add(commandName);
  }

  return profiles;
}
