// Purpose: Gemini CLI process launch (thinking-model system-settings file preparation + ACP child-process spawn).
// Layer: pure standalone Effect functions; no captured factory state.
// Exports: prepareGeminiLaunchConfig, spawnGeminiProcess.

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import { MODEL_OPTIONS_BY_PROVIDER, type ThreadId } from "@t3tools/contracts";
import { Effect } from "effect";

import { ProviderAdapterProcessError } from "../Errors.ts";
import { PROVIDER, SYNARA_GEMINI_SETTINGS_DIR } from "./GeminiAdapter.config.ts";
import { toMessage } from "./GeminiAdapter.events.ts";
import { buildGeminiThinkingModelConfigAliases } from "./GeminiAdapter.models.ts";

export const prepareGeminiLaunchConfig = Effect.fn("prepareGeminiLaunchConfig")(function* (input: {
  readonly threadId: ThreadId;
  readonly selectedModel?: string;
}) {
  const candidateModels = [
    ...MODEL_OPTIONS_BY_PROVIDER.gemini.map((option) => option.slug),
    ...(input.selectedModel ? [input.selectedModel] : []),
  ];
  const aliases = buildGeminiThinkingModelConfigAliases(candidateModels);

  if (Object.keys(aliases).length === 0) {
    return {
      env: process.env,
      systemSettingsPath: undefined,
    };
  }

  const systemSettingsPath = path.join(
    SYNARA_GEMINI_SETTINGS_DIR,
    `${input.threadId}-${crypto.randomUUID()}.json`,
  );
  yield* Effect.tryPromise({
    try: async () => {
      await fs.mkdir(SYNARA_GEMINI_SETTINGS_DIR, { recursive: true });
      await fs.writeFile(
        systemSettingsPath,
        JSON.stringify(
          {
            modelConfigs: {
              aliases,
            },
          },
          null,
          2,
        ),
        "utf8",
      );
    },
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: input.threadId,
        detail: `Failed to prepare Gemini thinking settings: ${toMessage(cause, "write failed")}`,
        cause,
      }),
  });

  return {
    systemSettingsPath,
    env: {
      ...process.env,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: systemSettingsPath,
    },
  };
});

export const spawnGeminiProcess = Effect.fn("spawnGeminiProcess")(function* (
  threadId: ThreadId,
  binaryPath: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
) {
  return yield* Effect.try({
    try: () =>
      spawn(binaryPath, ["--acp"], {
        cwd,
        env: env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      }),
    catch: (cause) =>
      new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId,
        detail: `Failed to spawn Gemini CLI: ${toMessage(cause, "spawn failed")}`,
        cause,
      }),
  });
});
