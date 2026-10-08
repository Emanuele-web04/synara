import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  buildMuseSpawnInput,
  configureMuse,
  discoverMuseModels,
  museModels,
} from "./MuseAcpSupport.ts";
import type * as Acp from "@agentclientprotocol/sdk";
import { AcpRequestError } from "./AcpErrors.ts";

describe("Muse ACP configuration", () => {
  it.each([undefined, { reasoningEffort: "default" }])(
    "keeps the resumed session effort without a concrete override (%j)",
    async (options) => {
      const calls: string[] = [];
      const runtime = {
        getConfigOptions: Effect.succeed<Acp.SessionConfigOption[]>([
          {
            id: "reasoning_effort",
            name: "Reasoning",
            type: "select",
            currentValue: "max",
            options: [
              { value: "low", name: "Low" },
              { value: "max", name: "Max" },
            ],
          },
        ]),
        setModel: () => Effect.void,
        setMode: () => Effect.succeed({}),
        setConfigOption: (key: string, value: string | boolean) => {
          calls.push(`${key}:${value}`);
          return key === "reasoning_effort" && value === "default"
            ? Effect.fail(
                new AcpRequestError({
                  code: -32602,
                  errorMessage: "Invalid value default for reasoning_effort",
                }),
              )
            : Effect.succeed({ configOptions: [] });
        },
      };
      await Effect.runPromise(configureMuse(runtime, "muse-spark-1.3-contributor", options, false));
      expect(calls).not.toContain("reasoning_effort:default");
    },
  );
  it("discovers each model's own effort choices and preserves Muse default metadata", async () => {
    let current = "contributor";
    const runtime = {
      getConfigOptions: Effect.sync((): Acp.SessionConfigOption[] => [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: current,
          options: [
            { value: "spark", name: "Spark" },
            { value: "contributor", name: "Contributor" },
          ],
        },
        {
          id: "reasoning_effort",
          name: "Reasoning",
          type: "select",
          currentValue: "default",
          options: [
            { value: "default", name: "Muse default" },
            current === "spark" ? { value: "max", name: "Max" } : { value: "low", name: "Low" },
          ],
        },
      ]),
      setModel: (model: string) =>
        Effect.sync(() => {
          current = model;
        }),
    };
    const models = await Effect.runPromise(discoverMuseModels(runtime));
    expect(
      models.map((model) => [
        model.slug,
        model.supportedReasoningEfforts?.map((effort) => effort.value),
      ]),
    ).toEqual([
      ["default", ["default", "low"]],
      ["spark", ["default", "max"]],
      ["contributor", ["default", "low"]],
    ]);
  });
  it("applies explicit effort and preserves it when leaving Plan without an override", async () => {
    const calls: string[] = [];
    const runtime = {
      setModel: (model: string) =>
        Effect.sync(() => {
          calls.push(`model:${model}`);
        }),
      setMode: (mode: string) =>
        Effect.sync(() => {
          calls.push(`mode:${mode}`);
          return {};
        }),
      setConfigOption: (key: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push(`${key}:${value}`);
          return { configOptions: [] };
        }),
    };
    await Effect.runPromise(
      configureMuse(runtime, "muse-spark-1.3", { reasoningEffort: "max" }, true),
    );
    await Effect.runPromise(configureMuse(runtime, "default", undefined, false));
    expect(calls).toEqual([
      "model:muse-spark-1.3",
      "reasoning_effort:max",
      "mode:plan",
      "approval_mode:promptUnmatched",
      "auto_review:off",
      "mode:default",
      "approval_mode:promptUnmatched",
      "auto_review:off",
    ]);
  });
  it("launches the bridge without Copilot flags and retains the approval boundary", () => {
    const spawn = buildMuseSpawnInput(
      { binaryPath: "/tools/muse-acp", environment: { MUSE_CLI: "/tools/muse" } },
      "/project",
    );
    expect(spawn.command).toBe("/tools/muse-acp");
    expect(spawn.args).toEqual([]);
    expect(spawn.providerEnvironment?.environment).toEqual({ MUSE_CLI: "/tools/muse" });
    expect(spawn.env).toEqual({
      MUSE_APPROVAL_MODE: "promptUnmatched",
      MUSE_ALLOW_UNSCOPED_READS: "false",
    });
  });

  it("does not claim the selected model's reasoning tiers apply to all models", () => {
    const result = museModels([
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "muse-spark-1.3",
        options: [
          { value: "muse-spark-1.3", name: "Spark 1.3" },
          { value: "muse-spark-1.2", name: "Spark 1.2" },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Effort",
        type: "select",
        currentValue: "default",
        options: [
          { value: "default", name: "Muse default" },
          { value: "max", name: "Max" },
        ],
      },
    ]);
    expect(result).toEqual([
      {
        slug: "muse-spark-1.3",
        name: "Spark 1.3",
        supportedReasoningEfforts: [
          { value: "default", label: "Use session setting" },
          { value: "max", label: "Max" },
        ],
        defaultReasoningEffort: "default",
      },
      { slug: "muse-spark-1.2", name: "Spark 1.2" },
    ]);
  });
});
