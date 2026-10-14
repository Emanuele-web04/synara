// FILE: projectImportSources.ts
// Purpose: Resolve every enabled Codex/Claude account (provider instance) into the
//          local storage project import scans, using the same account environment
//          the runtime launches that account with.
// Layer: Server orchestration (project import)

import { homedir } from "node:os";
import nodePath from "node:path";

import type {
  ProjectImportProvider,
  ProviderInstanceId,
  ProviderStartOptions,
  ServerSettings,
} from "@synara/contracts";
import {
  deriveProviderInstances,
  providerStartOptionsFromInstance,
  type ResolvedProviderInstance,
} from "@synara/shared/providerInstances";

import { claudeHistoricalSessionEnvironment } from "./importThreadRoute";
import { canonicalImportPath } from "./projectImportPaths";
import { resolveCodexProjectImportHome } from "../provider/codexProjectImport";

export interface ProjectImportSource {
  readonly provider: ProjectImportProvider;
  readonly instanceId: ProviderInstanceId;
  readonly isDefault: boolean;
  /** Display name of a non-default account. */
  readonly accountLabel?: string;
  /** Settings-derived launch options for this account. */
  readonly providerOptions: ProviderStartOptions | undefined;
  /** Codex account home override; history lives in this (base) home. */
  readonly codexHomePath?: string;
  /** Environment the account's Codex/Claude runtime is launched with. */
  readonly environment: NodeJS.ProcessEnv;
  /**
   * Claude accounts whose config dir differs from the server process's own must
   * be read through a child process: the SDK only reads process.env.
   */
  readonly claudeEnvironment?: NodeJS.ProcessEnv;
  readonly claudeConfigDir?: string;
}

function ambientClaudeConfigDir(): string {
  return nodePath.resolve(
    process.env.CLAUDE_CONFIG_DIR?.trim() || nodePath.join(homedir(), ".claude"),
  );
}

/**
 * Default accounts first, so a store shared by several accounts is attributed to
 * the default. A disabled default stays listed (import refuses it with a clear
 * error); disabled non-default accounts are not scanned.
 */
export function resolveProjectImportSources(
  settings: ServerSettings,
  providers: ReadonlyArray<ProjectImportProvider>,
  paths: { readonly homeDir?: string | undefined; readonly stateDir?: string | undefined } = {},
): ReadonlyArray<ProjectImportSource> {
  const requested = new Set<string>(providers);
  const instances = deriveProviderInstances(settings)
    .filter(
      (instance): instance is typeof instance & { driver: ProjectImportProvider } =>
        (instance.enabled || instance.isDefault) && requested.has(instance.driver),
    )
    .toSorted(
      (left, right) =>
        providers.indexOf(left.driver) - providers.indexOf(right.driver) ||
        Number(right.isDefault) - Number(left.isDefault),
    );
  return instances.map(projectImportSourceFor(paths));
}

function projectImportSourceFor(paths: {
  readonly homeDir?: string | undefined;
  readonly stateDir?: string | undefined;
}) {
  return (
    instance: ResolvedProviderInstance & { readonly driver: ProjectImportProvider },
  ): ProjectImportSource => {
    const providerOptions = providerStartOptionsFromInstance(instance);
    const base = {
      instanceId: instance.instanceId,
      isDefault: instance.isDefault,
      ...(instance.isDefault ? {} : { accountLabel: instance.displayName }),
      providerOptions,
    };
    if (instance.driver === "codex") {
      const codex = providerOptions?.codex;
      const source: ProjectImportSource = {
        ...base,
        provider: "codex",
        environment: { ...process.env, ...codex?.environment },
      };
      return codex?.homePath ? { ...source, codexHomePath: codex.homePath } : source;
    }
    const claudeEnvironment = claudeHistoricalSessionEnvironment(providerOptions, {
      ...(paths.homeDir ? { homeDir: paths.homeDir } : {}),
      ...(paths.stateDir ? { isolationRootDir: paths.stateDir } : {}),
      ...(instance.isDefault ? {} : { providerInstanceId: instance.instanceId }),
    });
    const environment = claudeEnvironment ?? process.env;
    const configDir = nodePath.resolve(
      environment.CLAUDE_CONFIG_DIR?.trim() ||
        nodePath.join(environment.HOME?.trim() || homedir(), ".claude"),
    );
    const source: ProjectImportSource = {
      ...base,
      provider: "claudeAgent",
      environment,
      claudeConfigDir: configDir,
    };
    return configDir === ambientClaudeConfigDir() || !claudeEnvironment
      ? source
      : { ...source, claudeEnvironment };
  };
}

/** The storage identity a source was discovered from; import revalidates it. */
export function resolveProjectImportSourceHome(source: ProjectImportSource): Promise<string> {
  return source.provider === "codex"
    ? resolveCodexProjectImportHome({
        env: source.environment,
        ...(source.codexHomePath ? { homePath: source.codexHomePath } : {}),
      })
    : canonicalImportPath(source.claudeConfigDir ?? ambientClaudeConfigDir());
}
