import { Effect } from "effect";
import type * as Acp from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";

import {
  applyKiroAcpEffortSelection,
  applyKiroAcpModelSelection,
  applyKiroAcpSessionMode,
  buildKiroAcpSpawnInput,
  discoverKiroAcpModels,
  readKiroLegacyModelState,
  readKiroModelEffortOption,
  resolveKiroAcpAuthMethodId,
} from "./KiroAcpSupport.ts";

const modelConfig = (currentValue: string): Acp.SessionConfigOption => ({
  id: "model",
  name: "Model",
  category: "model",
  type: "select",
  currentValue,
  options: [
    { value: "auto", name: "Auto" },
    { value: "claude-sonnet-4.5", name: "Claude Sonnet 4.5" },
  ],
});

const effortConfig: Acp.SessionConfigOption = {
  id: "effortLevel",
  name: "Effort",
  category: "thought_level",
  type: "select",
  currentValue: "medium",
  options: [
    { value: "low", name: "Low" },
    { value: "medium", name: "Medium" },
    { value: "high", name: "High" },
  ],
};

const legacySetup = {
  sessionId: "kiro-session",
  models: {
    currentModelId: "auto",
    availableModels: [
      { modelId: "auto", name: "Auto" },
      { modelId: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", description: "Balanced" },
      { name: "missing id" },
    ],
  },
} as unknown as Acp.NewSessionResponse;

function fakeRuntime(configOptions: ReadonlyArray<Acp.SessionConfigOption>) {
  const calls: Array<{ readonly method: string; readonly args: ReadonlyArray<unknown> }> = [];
  return {
    calls,
    runtime: {
      getConfigOptions: Effect.succeed(configOptions),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ method: "setConfigOption", args: [configId, value] });
          return { configOptions: [] } as Acp.SetSessionConfigOptionResponse;
        }),
      setMode: (modeId: string) =>
        Effect.sync(() => {
          calls.push({ method: "setMode", args: [modeId] });
          return {} as Acp.SetSessionModeResponse;
        }),
      request: (method: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push({ method, args: [payload] });
          return {};
        }),
    },
  };
}

describe("buildKiroAcpSpawnInput", () => {
  it("starts plain `kiro-cli acp`", () => {
    expect(buildKiroAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
      providerEnvironment: { driver: "kiro" },
    });
  });

  // kiro-cli 3.0.0 never answers session/new when launched with --model or
  // --effort, so the selection must stay out of the command line.
  it("keeps model and effort out of the launch command", () => {
    expect(
      buildKiroAcpSpawnInput(
        {
          binaryPath: "/opt/kiro/bin/kiro-cli",
          instanceId: "kiro_work",
          environment: { KIRO_PROFILE: "work" },
          homeDir: "/home/test",
          isolationRootDir: "/state",
        },
        "/tmp/project",
      ),
    ).toEqual({
      command: "/opt/kiro/bin/kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
      providerEnvironment: {
        driver: "kiro",
        instanceId: "kiro_work",
        environment: { KIRO_PROFILE: "work" },
        homeDir: "/home/test",
        isolationRootDir: "/state",
      },
    });
  });
});

describe("resolveKiroAcpAuthMethodId", () => {
  it("asks the user to sign in instead of authenticating headlessly", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        resolveKiroAcpAuthMethodId({
          protocolVersion: 1,
          authMethods: [{ id: "kiro-login", name: "Kiro login" }],
        }),
      ),
    );
    expect(error._tag).toBe("AcpRequestError");
    expect(error.message).toContain("kiro-cli login");
  });
});

describe("readKiroLegacyModelState", () => {
  it("reads the pre-1.0 ACP models block and skips malformed entries", () => {
    expect(readKiroLegacyModelState(legacySetup)).toEqual({
      currentModelId: "auto",
      models: [
        { id: "auto", name: "Auto" },
        { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", description: "Balanced" },
      ],
    });
    expect(readKiroLegacyModelState({ sessionId: "s" })).toBeUndefined();
  });
});

describe("applyKiroAcpModelSelection", () => {
  const started = { sessionId: "kiro-session", sessionSetupResult: { sessionId: "kiro-session" } };

  it("selects an advertised model through the model config option", async () => {
    const { runtime, calls } = fakeRuntime([modelConfig("auto")]);
    const outcome = await Effect.runPromise(
      applyKiroAcpModelSelection({ runtime, started, model: "claude-sonnet-4.5" }),
    );
    expect(outcome).toEqual({ _tag: "Applied", via: "config_option" });
    expect(calls).toEqual([{ method: "setConfigOption", args: ["model", "claude-sonnet-4.5"] }]);
  });

  it("skips the request when the model is already current", async () => {
    const { runtime, calls } = fakeRuntime([modelConfig("claude-sonnet-4.5")]);
    const outcome = await Effect.runPromise(
      applyKiroAcpModelSelection({ runtime, started, model: "claude-sonnet-4.5" }),
    );
    expect(outcome).toEqual({ _tag: "AlreadyCurrent" });
    expect(calls).toEqual([]);
  });

  it("reports a model Kiro does not advertise instead of sending it", async () => {
    const { runtime, calls } = fakeRuntime([modelConfig("auto")]);
    const outcome = await Effect.runPromise(
      applyKiroAcpModelSelection({ runtime, started, model: "gpt-unknown" }),
    );
    expect(outcome).toEqual({
      _tag: "NotAdvertised",
      advertised: ["auto", "claude-sonnet-4.5"],
    });
    expect(calls).toEqual([]);
  });

  it("falls back to session/set_model for the legacy models block", async () => {
    const { runtime, calls } = fakeRuntime([]);
    const outcome = await Effect.runPromise(
      applyKiroAcpModelSelection({
        runtime,
        started: { sessionId: "kiro-session", sessionSetupResult: legacySetup },
        model: "claude-sonnet-4.5",
      }),
    );
    expect(outcome).toEqual({ _tag: "Applied", via: "set_model" });
    expect(calls).toEqual([
      {
        method: "session/set_model",
        args: [{ sessionId: "kiro-session", modelId: "claude-sonnet-4.5" }],
      },
    ]);
  });

  it("leaves the session alone when Kiro exposes no model control", async () => {
    const { runtime, calls } = fakeRuntime([]);
    const outcome = await Effect.runPromise(
      applyKiroAcpModelSelection({ runtime, started, model: "claude-sonnet-4.5" }),
    );
    expect(outcome).toEqual({ _tag: "NoModelControl" });
    expect(calls).toEqual([]);
  });
});

describe("discoverKiroAcpModels", () => {
  it("maps config options, including advertised effort levels", async () => {
    const { runtime } = fakeRuntime([modelConfig("auto"), effortConfig]);
    const result = await Effect.runPromise(
      discoverKiroAcpModels({ runtime, started: { sessionSetupResult: { sessionId: "s" } } }),
    );
    expect(result.source).toBe("kiro-acp");
    expect(result.models.map((model) => model.slug)).toEqual(["auto", "claude-sonnet-4.5"]);
    expect(result.models[1]?.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
  });

  it("maps the legacy models block without inventing effort levels", async () => {
    const { runtime } = fakeRuntime([]);
    const result = await Effect.runPromise(
      discoverKiroAcpModels({ runtime, started: { sessionSetupResult: legacySetup } }),
    );
    expect(result.models).toEqual([
      { slug: "auto", name: "Auto", supportsFastMode: false, supportsThinkingToggle: false },
      {
        slug: "claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        description: "Balanced",
        supportsFastMode: false,
        supportsThinkingToggle: false,
      },
    ]);
  });

  it("fails when Kiro advertises no model list", async () => {
    const { runtime } = fakeRuntime([]);
    const error = await Effect.runPromise(
      Effect.flip(
        discoverKiroAcpModels({ runtime, started: { sessionSetupResult: { sessionId: "s" } } }),
      ),
    );
    expect(error.message).toContain("did not advertise a model list");
  });
});

describe("applyKiroAcpSessionMode", () => {
  it("uses the mode config option when Kiro advertises one", async () => {
    const { runtime, calls } = fakeRuntime([
      {
        id: "mode",
        name: "Agent",
        category: "mode",
        type: "select",
        currentValue: "kiro_default",
        options: [
          { value: "kiro_default", name: "Default" },
          { value: "kiro_planner", name: "Planner" },
        ],
      },
    ]);
    const via = await Effect.runPromise(
      applyKiroAcpSessionMode({ runtime, sessionId: "kiro-session", modeId: "kiro_planner" }),
    );
    expect(via).toBe("config_option");
    expect(calls).toEqual([{ method: "setMode", args: ["kiro_planner"] }]);
  });

  it("sends session/set_mode when modes are only advertised as ACP modes", async () => {
    const { runtime, calls } = fakeRuntime([modelConfig("auto")]);
    const via = await Effect.runPromise(
      applyKiroAcpSessionMode({ runtime, sessionId: "kiro-session", modeId: "kiro_planner" }),
    );
    expect(via).toBe("set_mode");
    expect(calls).toEqual([
      { method: "session/set_mode", args: [{ sessionId: "kiro-session", modeId: "kiro_planner" }] },
    ]);
  });
});

describe("readKiroModelEffortOption", () => {
  // Shape captured from `kiro-cli acp` 3.0.0: effort lives in each model's `_meta.kiro`.
  const opus = {
    value: "claude-opus-5.5",
    name: "Claude Opus 5.5",
    _meta: {
      kiro: {
        hasEffort: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
        defaultEffortLevel: "medium",
      },
    },
  };

  it("rebuilds a model's own effort ladder with its default", () => {
    expect(readKiroModelEffortOption(opus)).toMatchObject({
      category: "thought_level",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra High" },
        { value: "max", name: "Max" },
      ],
    });
    expect(
      readKiroModelEffortOption({
        value: "auto",
        name: "Auto",
        _meta: { kiro: { hasEffort: false } },
      }),
    ).toBeUndefined();
  });

  it("gives each discovered model its own effort ladder", async () => {
    const { runtime } = fakeRuntime([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "auto",
        options: [{ value: "auto", name: "Auto", _meta: { kiro: { hasEffort: false } } }, opus],
      },
    ]);
    const result = await Effect.runPromise(
      discoverKiroAcpModels({ runtime, started: { sessionSetupResult: { sessionId: "s" } } }),
    );
    expect(result.models[0]?.supportedReasoningEfforts).toEqual([]);
    expect(result.models[0]?.defaultReasoningEffort).toBeUndefined();
    expect(result.models[1]?.supportedReasoningEfforts?.map((effort) => effort.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(result.models[1]?.defaultReasoningEffort).toBe("medium");
  });
});

describe("applyKiroAcpEffortSelection", () => {
  it("selects an advertised level through Kiro's effortLevel option", async () => {
    const { runtime, calls } = fakeRuntime([modelConfig("claude-sonnet-4.5"), effortConfig]);
    const outcome = await Effect.runPromise(
      applyKiroAcpEffortSelection({ runtime, reasoningEffort: "high" }),
    );
    expect(outcome).toEqual({ _tag: "Applied" });
    expect(calls).toEqual([{ method: "setConfigOption", args: ["effortLevel", "high"] }]);
  });

  it("reports levels the model does not offer and models without effort", async () => {
    const withEffort = fakeRuntime([effortConfig]);
    expect(
      await Effect.runPromise(
        applyKiroAcpEffortSelection({ runtime: withEffort.runtime, reasoningEffort: "max" }),
      ),
    ).toEqual({ _tag: "NotAdvertised", advertised: ["low", "medium", "high"] });
    expect(
      await Effect.runPromise(
        applyKiroAcpEffortSelection({ runtime: withEffort.runtime, reasoningEffort: "medium" }),
      ),
    ).toEqual({ _tag: "AlreadyCurrent" });
    const withoutEffort = fakeRuntime([modelConfig("auto")]);
    expect(
      await Effect.runPromise(
        applyKiroAcpEffortSelection({ runtime: withoutEffort.runtime, reasoningEffort: "high" }),
      ),
    ).toEqual({ _tag: "NoEffortControl" });
    expect([...withEffort.calls, ...withoutEffort.calls]).toEqual([]);
  });
});
