import { Effect } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  resolveGrokAcpAuthMethodId,
  resolveGrokAcpAuthMethodIdForEnv,
} from "./GrokAcpSupport.ts";

function initializeWithAuthMethods(ids: ReadonlyArray<string>): EffectAcpSchema.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("buildGrokAcpSpawnInput", () => {
  it("builds the default Grok ACP command", () => {
    expect(buildGrokAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "grok",
      args: ["agent", "--no-leader", "stdio"],
      cwd: "/tmp/project",
      providerEnvironment: { driver: "grok" },
    });
  });

  it("uses the configured Grok binary path", () => {
    expect(buildGrokAcpSpawnInput({ binaryPath: "/usr/local/bin/grok" }, "/tmp/project")).toEqual({
      command: "/usr/local/bin/grok",
      args: ["agent", "--no-leader", "stdio"],
      cwd: "/tmp/project",
      providerEnvironment: { driver: "grok" },
    });
  });

  it("passes model and reasoning effort as Grok agent startup options", () => {
    expect(
      buildGrokAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/grok",
          model: "grok-build",
          reasoningEffort: "high",
          alwaysApprove: true,
        },
        "/tmp/project",
      ),
    ).toEqual({
      command: "/usr/local/bin/grok",
      args: [
        "agent",
        "--no-leader",
        "--always-approve",
        "-m",
        "grok-build",
        "--reasoning-effort",
        "high",
        "stdio",
      ],
      cwd: "/tmp/project",
      providerEnvironment: { driver: "grok" },
    });
  });
});

describe("resolveGrokAcpAuthMethodId", () => {
  const previousXaiApiKey = process.env.XAI_API_KEY;
  const previousApiKey = process.env.GROK_CODE_XAI_API_KEY;

  afterEach(() => {
    if (previousXaiApiKey === undefined) {
      delete process.env.XAI_API_KEY;
    } else {
      process.env.XAI_API_KEY = previousXaiApiKey;
    }
    if (previousApiKey === undefined) {
      delete process.env.GROK_CODE_XAI_API_KEY;
    } else {
      process.env.GROK_CODE_XAI_API_KEY = previousApiKey;
    }
  });

  it("prefers the xAI API key auth method when XAI_API_KEY is present", async () => {
    process.env.XAI_API_KEY = "xai-test-key";

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("xai.api_key");
  });

  it("still accepts the legacy Grok API key env var", async () => {
    delete process.env.XAI_API_KEY;
    process.env.GROK_CODE_XAI_API_KEY = "xai-test-key";

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("xai.api_key");
  });

  it("uses the selected legacy key without inheriting an ambient XAI_API_KEY alias", async () => {
    process.env.XAI_API_KEY = "ambient-account-a";
    delete process.env.GROK_CODE_XAI_API_KEY;

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodIdForEnv(
          { GROK_CODE_XAI_API_KEY: "selected-account-b" },
          "grok_work",
        )(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("xai.api_key");
  });

  it("falls back to cached token auth when no API key is configured", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;

    await expect(
      Effect.runPromise(
        resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["cached_token", "xai.api_key"])),
      ),
    ).resolves.toBe("cached_token");
  });

  it("fails clearly when Grok exposes no supported ACP auth method", async () => {
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_CODE_XAI_API_KEY;

    const error = await Effect.runPromise(
      resolveGrokAcpAuthMethodId(initializeWithAuthMethods(["browser_login"])).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(EffectAcpErrors.AcpRequestError);
    expect(error.message).toBe("Grok ACP authentication is unavailable.");
  });
});

describe("applyGrokAcpModelSelection", () => {
  it("does not call Grok's unsupported ACP config-option method", async () => {
    const calls: Array<
      { type: "model"; value: string } | { type: "config"; id: string; value: string }
    > = [];
    const runtime = {
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      getConfigOptions: Effect.succeed([
        {
          id: "reasoning_effort",
          name: "Reasoning Effort",
          category: "model_config",
          type: "select",
          currentValue: "low",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ] as ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setConfigOption: (id: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", id, value: String(value) });
          return { configOptions: [] };
        }),
    };

    await Effect.runPromise(
      applyGrokAcpModelSelection({
        runtime,
        model: "grok-build",
        options: { reasoningEffort: "high" },
        mapError: (context) => context,
      }),
    );

    expect(calls).toEqual([]);
  });
});
