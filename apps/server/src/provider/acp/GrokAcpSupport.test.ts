import { Effect } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyGrokAcpModelSelection,
  buildGrokAcpSpawnInput,
  resolveGrokAcpAuthMethodId,
  runGrokAcpCompactionCommand,
} from "./GrokAcpSupport.ts";

function initializeWithAuthMethods(ids: ReadonlyArray<string>): Acp.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("buildGrokAcpSpawnInput", () => {
  it("builds the default Grok ACP command", () => {
    expect(buildGrokAcpSpawnInput(undefined, "/tmp/project")).toMatchObject({
      command: "grok",
      args: ["--permission-mode", "default", "agent", "--no-leader", "stdio"],
      cwd: "/tmp/project",
    });
  });

  it("uses the configured Grok binary path", () => {
    expect(
      buildGrokAcpSpawnInput({ binaryPath: "/usr/local/bin/grok" }, "/tmp/project"),
    ).toMatchObject({
      command: "/usr/local/bin/grok",
      args: ["--permission-mode", "default", "agent", "--no-leader", "stdio"],
      cwd: "/tmp/project",
    });
  });

  it("passes model and reasoning effort without process-wide approval overrides", () => {
    const spawn = buildGrokAcpSpawnInput(
      {
        binaryPath: "/usr/local/bin/grok",
        model: "grok-build",
        reasoningEffort: "high",
      },
      "/tmp/project",
    );

    expect(spawn).toMatchObject({
      command: "/usr/local/bin/grok",
      args: [
        "--permission-mode",
        "default",
        "agent",
        "--no-leader",
        "-m",
        "grok-build",
        "--reasoning-effort",
        "high",
        "stdio",
      ],
      cwd: "/tmp/project",
    });
    expect(spawn.args).not.toContain("--always-approve");
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

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
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
      ] as ReadonlyArray<Acp.SessionConfigOption>),
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

describe("runGrokAcpCompactionCommand", () => {
  it("runs Grok's advertised /compact command explicitly in agent mode", async () => {
    const prompts: Array<Omit<Acp.PromptRequest, "sessionId">> = [];
    const runtime = {
      getAvailableCommands: Effect.succeed([
        {
          name: "compact",
          description: "Compress conversation history to save context window",
        },
      ]),
      prompt: (payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          prompts.push(payload);
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    await expect(Effect.runPromise(runGrokAcpCompactionCommand(runtime))).resolves.toEqual({
      stopReason: "end_turn",
    });
    expect(prompts).toEqual([
      {
        prompt: [{ type: "text", text: "/compact" }],
        _meta: { mode: "agent" },
      },
    ]);
  });

  it("keeps /compact compatible when an older Grok ACP advertises no commands", async () => {
    const prompts: Array<Omit<Acp.PromptRequest, "sessionId">> = [];
    const runtime = {
      getAvailableCommands: Effect.succeed([]),
      prompt: (payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          prompts.push(payload);
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    await Effect.runPromise(runGrokAcpCompactionCommand(runtime));

    expect(prompts).toHaveLength(1);
  });

  it("fails clearly when Grok advertises commands without /compact", async () => {
    let promptCalled = false;
    const runtime = {
      getAvailableCommands: Effect.succeed([
        {
          name: "review",
          description: "Review changes",
        },
      ]),
      prompt: (_payload: Omit<Acp.PromptRequest, "sessionId">) =>
        Effect.sync(() => {
          promptCalled = true;
          return { stopReason: "end_turn" } satisfies Acp.PromptResponse;
        }),
    };

    const error = await Effect.runPromise(runGrokAcpCompactionCommand(runtime).pipe(Effect.flip));

    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
    expect(error.message).toContain("does not advertise the /compact command");
    expect(promptCalled).toBe(false);
  });
});
