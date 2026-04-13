/**
 * Codex config helpers.
 *
 * Parses the small subset of `CODEX_HOME/config.toml` we need for provider
 * discovery without pulling in a full TOML dependency.
 */
import OS from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function readQuotedAssignmentValue(trimmedLine: string, key: string): string | undefined {
  const match = trimmedLine.match(new RegExp(`^${key}\\s*=\\s*(?:"([^"]+)"|'([^']+)')`));
  return match?.[1] ?? match?.[2];
}

function readModelProviderSectionName(trimmedLine: string): string | undefined {
  const match = trimmedLine.match(
    /^\[\s*model_providers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]$/,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

export function parseCodexConfigModelProvider(content: string): string | undefined {
  let inTopLevel = true;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) {
      inTopLevel = false;
      continue;
    }
    if (!inTopLevel) continue;

    const provider = readQuotedAssignmentValue(trimmed, "model_provider");
    if (provider) return provider;
  }

  return undefined;
}

export function parseCodexConfigProviderEnvKey(
  content: string,
  provider: string,
): string | undefined {
  let currentProviderSection: string | undefined;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (trimmed.startsWith("[")) {
      currentProviderSection = readModelProviderSectionName(trimmed);
      continue;
    }

    if (currentProviderSection !== provider) continue;

    const envKey = readQuotedAssignmentValue(trimmed, "env_key");
    if (envKey) return envKey;
  }

  return undefined;
}

export function parseCodexConfigActiveProviderEnvKey(content: string): string | undefined {
  const provider = parseCodexConfigModelProvider(content);
  if (!provider || provider === "openai") {
    return undefined;
  }

  return parseCodexConfigProviderEnvKey(content, provider);
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim();
  return configured && configured.length > 0 ? configured : join(OS.homedir(), ".codex");
}

export function readCodexConfigContent(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configPath = join(resolveCodexHome(env), "config.toml");
  if (!existsSync(configPath)) {
    return undefined;
  }

  return readFileSync(configPath, "utf8");
}

export function readActiveCodexProviderEnvKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const content = readCodexConfigContent(env);
  if (content === undefined) {
    return undefined;
  }

  return parseCodexConfigActiveProviderEnvKey(content);
}
