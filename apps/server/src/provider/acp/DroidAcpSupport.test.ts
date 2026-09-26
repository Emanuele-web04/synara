// FILE: DroidAcpSupport.test.ts
// Purpose: Verifies Droid ACP spawn, auth, mode, model, and discovery behavior.
// Layer: Provider ACP support tests

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import * as AcpErrors from "./AcpErrors.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AcpSessionRuntime } from "./AcpSessionRuntime.ts";
import type { AcpSessionRuntimeOptions, AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import {
  applyDroidAcpInteractionMode,
  applyDroidAcpModelSelection,
  buildDroidAcpSpawnInput,
  discoverDroidAcpModels,
  makeDroidAcpRuntime,
  resolveDroidAcpAuthMethodId,
  resolveDroidCliBinaryPath,
} from "./DroidAcpSupport.ts";

function initializeWithAuthMethods(ids: ReadonlyArray<string>): Acp.InitializeResponse {
  return {
    protocolVersion: 1,
    authMethods: ids.map((id) => ({ id, name: id })),
  };
}

describe("resolveDroidCliBinaryPath", () => {
  it("prefers ~/.local/bin/droid when it exists", () => {
    const localBin = join(homedir(), ".local", "bin", "droid");
    const resolved = resolveDroidCliBinaryPath("");
    expect(resolved).toBe(existsSync(localBin) ? localBin : "droid");
  });
});

describe("buildDroidAcpSpawnInput", () => {
  it("builds the default Droid ACP command", () => {
    const spawn = buildDroidAcpSpawnInput(undefined, "/tmp/project");
    expect(spawn.args).toEqual(["exec", "--output-format", "acp"]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(spawn.command.length).toBeGreaterThan(0);
    expect(spawn.env).toBeDefined();
  });

  it("passes model, reasoning effort, and an appended system prompt without bypassing permissions", () => {
    const spawn = buildDroidAcpSpawnInput(
      {
        appendSystemPrompt: "Run heavyweight validators serially.",
        binaryPath: "/usr/local/bin/droid",
        model: "claude-opus-4-8",
        reasoningEffort: "high",
      },
      "/tmp/project",
    );

    expect(spawn.command).toBe("/usr/local/bin/droid");
    expect(spawn.args).toEqual([
      "exec",
      "--output-format",
      "acp",
      "--append-system-prompt",
      "Run heavyweight validators serially.",
      "-m",
      "claude-opus-4-8",
      "-r",
      "high",
    ]);
    expect(spawn.cwd).toBe("/tmp/project");
    expect(spawn.env).toBeDefined();
  });
});

describe("makeDroidAcpRuntime", () => {
  it("selects on-demand authentication so session start never re-opens the OAuth login page", async () => {
    const fakeRuntime = {} as AcpSessionRuntimeShape;
    let capturedOptions: AcpSessionRuntimeOptions | undefined;
    const layerSpy = vi.spyOn(AcpSessionRuntime, "layer").mockImplementation((options) => {
      capturedOptions = options;
      return Layer.succeed(AcpSessionRuntime, fakeRuntime);
    });

    try {
      const runtime = await Effect.runPromise(
        makeDroidAcpRuntime({
          childProcessSpawner: {} as ChildProcessSpawner.ChildProcessSpawner["Service"],
          droidSettings: undefined,
          cwd: "/tmp/project",
          clientInfo: { name: "Synara", version: "0.0.0" },
        }).pipe(Effect.scoped),
      );

      expect(runtime).toBe(fakeRuntime);
      expect(capturedOptions?.authPolicy).toBe("on-demand");
      expect(capturedOptions?.authenticateMeta).toEqual({ headless: true });
    } finally {
      layerSpy.mockRestore();
    }
  });
});

describe("applyDroidAcpModelSelection", () => {
  function recordingRuntime(failFor?: string) {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    return {
      calls,
      runtime: {
        setConfigOption: (configId: string, value: string | boolean) => {
          if (configId === failFor) {
            return Effect.fail(
              new AcpErrors.AcpRequestError({
                code: -32602,
                errorMessage: `Unknown config option: ${configId}`,
              }),
            );
          }
          calls.push({ configId, value });
          return Effect.succeed({ configOptions: [] });
        },
      },
    };
  }

  it("sets the model before the reasoning effort", async () => {
    const { calls, runtime } = recordingRuntime();
    await Effect.runPromise(
      applyDroidAcpModelSelection({
        runtime,
        model: "minimax-m3",
        reasoningEffort: "high",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([
      { configId: "model", value: "minimax-m3" },
      { configId: "reasoning_effort", value: "high" },
    ]);
  });

  it("skips the reasoning effort RPC when no effort is requested", async () => {
    const { calls, runtime } = recordingRuntime();
    await Effect.runPromise(
      applyDroidAcpModelSelection({
        runtime,
        model: "claude-opus-4-8",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([{ configId: "model", value: "claude-opus-4-8" }]);
  });

  it("maps set_config_option failures through mapError", async () => {
    const { runtime } = recordingRuntime("model");
    const error = await Effect.runPromise(
      applyDroidAcpModelSelection({
        runtime,
        model: "claude-opus-4-8",
        mapError: ({ method }) => new Error(`failed:${method}`),
      }).pipe(Effect.flip),
    );
    expect(error.message).toBe("failed:session/set_config_option");
  });
});

describe("applyDroidAcpInteractionMode", () => {
  it("uses native spec mode for Plan and restores Full Access on the next turn", async () => {
    const calls: string[] = [];
    const runtime = {
      setMode: (modeId: string) => {
        calls.push(modeId);
        return Effect.succeed({});
      },
      setConfigOption: () => Effect.succeed({ configOptions: [] }),
    };

    await Effect.runPromise(
      applyDroidAcpInteractionMode({
        runtime,
        interactionMode: "plan",
        runtimeMode: "full-access",
        mapError: ({ cause }) => cause,
      }),
    );
    await Effect.runPromise(
      applyDroidAcpInteractionMode({
        runtime,
        interactionMode: "default",
        runtimeMode: "full-access",
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual(["spec", "auto-high"]);
  });

  it("falls back to Droid's autonomy config for older ACP mode responses", async () => {
    const calls: Array<{ configId: string; value: string | boolean }> = [];
    const runtime = {
      setMode: () =>
        Effect.fail(
          new AcpErrors.AcpRequestError({ code: -32601, errorMessage: "mode unavailable" }),
        ),
      setConfigOption: (configId: string, value: string | boolean) => {
        calls.push({ configId, value });
        return Effect.succeed({ configOptions: [] });
      },
    };

    await Effect.runPromise(
      applyDroidAcpInteractionMode({
        runtime,
        interactionMode: "plan",
        mapError: ({ cause }) => cause,
      }),
    );
    expect(calls).toEqual([{ configId: "autonomy_level", value: "spec" }]);
  });
});

describe("discoverDroidAcpModels", () => {
  it("reads each model's reasoning choices from session config options", async () => {
    let currentModel = "model-a";
    const configOptions = (): ReadonlyArray<Acp.SessionConfigOption> => [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModel,
        options: [
          {
            value: "model-a",
            name: "Model A",
            description: "0.4x Factory token rate",
          },
          { value: "model-b", name: "Model B" },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning",
        category: "thought_level",
        type: "select",
        currentValue: currentModel === "model-a" ? "medium" : "max",
        options:
          currentModel === "model-a"
            ? [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
              ]
            : [
                { value: "high", name: "High" },
                { value: "max", name: "Max" },
              ],
      },
    ];
    const runtime = {
      getConfigOptions: Effect.sync(configOptions),
      setConfigOption: (configId: string, value: string | boolean) => {
        if (configId === "model") {
          currentModel = String(value);
        }
        return Effect.succeed({ configOptions: [...configOptions()] });
      },
    };

    const result = await Effect.runPromise(discoverDroidAcpModels(runtime));
    expect(result.models).toEqual([
      expect.objectContaining({
        slug: "model-a",
        description: "0.4x Factory token rate",
        optionDescriptors: [
          expect.objectContaining({ id: "reasoningEffort", currentValue: "medium" }),
        ],
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
        ],
      }),
      expect.objectContaining({
        slug: "model-b",
        optionDescriptors: [
          expect.objectContaining({ id: "reasoningEffort", currentValue: "max" }),
        ],
        supportedReasoningEfforts: [
          { value: "high", label: "High" },
          { value: "max", label: "Max" },
        ],
      }),
    ]);
    expect(result.models[1]).not.toHaveProperty("description");
    expect(currentModel).toBe("model-a");
  });
});

describe("resolveDroidAcpAuthMethodId", () => {
  const previousFactoryApiKey = process.env.FACTORY_API_KEY;

  afterEach(() => {
    if (previousFactoryApiKey === undefined) {
      delete process.env.FACTORY_API_KEY;
    } else {
      process.env.FACTORY_API_KEY = previousFactoryApiKey;
    }
  });

  it("prefers factory-api-key when FACTORY_API_KEY is set", async () => {
    process.env.FACTORY_API_KEY = "fk-test";
    const id = await Effect.runPromise(
      resolveDroidAcpAuthMethodId(initializeWithAuthMethods(["factory-api-key", "device-pairing"])),
    );
    expect(id).toBe("factory-api-key");
  });

  it("falls back to device-pairing", async () => {
    delete process.env.FACTORY_API_KEY;
    const id = await Effect.runPromise(
      resolveDroidAcpAuthMethodId(initializeWithAuthMethods(["device-pairing"])),
    );
    expect(id).toBe("device-pairing");
  });

  it("fails when no auth method is available", async () => {
    delete process.env.FACTORY_API_KEY;
    const error = await Effect.runPromise(
      resolveDroidAcpAuthMethodId(initializeWithAuthMethods([])).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(AcpErrors.AcpRequestError);
  });
});
