import { Effect } from "effect";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vitest";

import {
  applyCursorAcpModelSelection,
  buildCursorAcpModelDescriptors,
  buildCursorAcpSpawnInput,
  flattenCursorAcpModelChoices,
  parseCursorCliModelList,
} from "./CursorAcpSupport.ts";

const parameterizedGpt54ConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.4-medium-fast",
    options: [{ value: "gpt-5.4-medium-fast", name: "GPT-5.4" }],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select",
    currentValue: "272k",
    options: [
      { value: "272k", name: "272K" },
      { value: "1m", name: "1M" },
    ],
  },
  {
    id: "fast",
    name: "Fast",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  },
];

const parameterizedCursorVariantConfigOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5.3-codex[reasoning=medium,fast=false]",
    options: [
      { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "GPT-5.3 Codex" },
      {
        value: "claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]",
        name: "Claude Opus 4.6",
      },
    ],
  },
  {
    id: "reasoning",
    name: "Reasoning",
    category: "thought_level",
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
      { value: "extra-high", name: "Extra High" },
    ],
  },
  {
    id: "context",
    name: "Context",
    category: "model_config",
    type: "select",
    currentValue: "200k",
    options: [
      { value: "200k", name: "200K" },
      { value: "1m", name: "1M" },
    ],
  },
  {
    id: "fast",
    name: "Fast",
    category: "model_config",
    type: "select",
    currentValue: "false",
    options: [
      { value: "false", name: "Off" },
      { value: "true", name: "Fast" },
    ],
  },
];

describe("buildCursorAcpSpawnInput", () => {
  it("builds the default Cursor ACP command", () => {
    expect(buildCursorAcpSpawnInput(undefined, "/tmp/project")).toEqual({
      command: "agent",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("includes the configured api endpoint when present", () => {
    expect(
      buildCursorAcpSpawnInput(
        {
          binaryPath: "/usr/local/bin/agent",
          apiEndpoint: "http://localhost:3000",
        },
        "/tmp/project",
      ),
    ).toEqual({
      command: "/usr/local/bin/agent",
      args: ["-e", "http://localhost:3000", "acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("flattenCursorAcpModelChoices", () => {
  it("reads Cursor ACP model picker options including grouped choices", () => {
    expect(
      flattenCursorAcpModelChoices([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "auto",
          options: [
            { value: "auto", name: "Auto" },
            {
              group: "anthropic",
              name: "Anthropic",
              options: [
                { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
                { value: "claude-opus-4-6", name: "Claude Opus 4.6" },
              ],
            },
            { value: "claude-opus-4-6", name: "Duplicate" },
          ] as never,
        },
      ]),
    ).toEqual([
      { slug: "auto", name: "Auto", upstreamProviderId: "cursor", upstreamProviderName: "Cursor" },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
    ]);
  });
});

describe("parseCursorCliModelList", () => {
  it("parses Cursor CLI model output with provider grouping metadata", () => {
    expect(
      parseCursorCliModelList(`Available models

auto - Auto
composer-2-fast - Composer 2 Fast (default)
gpt-5.3-codex-high-fast - Codex 5.3 High Fast
claude-4.6-opus-max-thinking-fast - Opus 4.6 1M Max Thinking Fast

Tip: use --model <id> (or /model <id> in interactive mode) to switch.
`),
    ).toEqual([
      {
        slug: "auto",
        name: "Auto",
        upstreamProviderId: "cursor",
        upstreamProviderName: "Cursor",
      },
      {
        slug: "composer-2-fast",
        name: "Composer 2 Fast",
        upstreamProviderId: "cursor",
        upstreamProviderName: "Cursor",
        supportsFastMode: true,
      },
      {
        slug: "gpt-5.3-codex-high-fast",
        name: "Codex 5.3 High Fast",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        supportedReasoningEfforts: [{ value: "high", label: "High" }],
        defaultReasoningEffort: "high",
        supportsFastMode: true,
      },
      {
        slug: "claude-4.6-opus-max-thinking-fast",
        name: "Opus 4.6 1M Max Thinking Fast",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
        supportsFastMode: true,
        supportsThinkingToggle: true,
        contextWindowOptions: [{ value: "1m", label: "1M", isDefault: true }],
        defaultContextWindow: "1m",
      },
    ]);
  });
});

describe("buildCursorAcpModelDescriptors", () => {
  it("returns Cursor runtime models without exposing separate trait pickers", () => {
    expect(buildCursorAcpModelDescriptors(parameterizedGpt54ConfigOptions)).toEqual([
      {
        slug: "gpt-5.4-medium-fast",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
    ]);
  });

  it("expands Cursor parameterized model choices into reasoning, context, and fast variants", () => {
    const models = buildCursorAcpModelDescriptors(parameterizedCursorVariantConfigOptions);
    expect(models).toHaveLength(24);
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "gpt-5.3-codex[reasoning=medium,fast=false]",
        name: "GPT-5.3 Codex",
      }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "gpt-5.3-codex[reasoning=high,fast=true]",
        name: "GPT-5.3 Codex High Fast",
      }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "gpt-5.3-codex[reasoning=extra-high,fast=true]",
        name: "GPT-5.3 Codex Extra High Fast",
      }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "claude-opus-4-6[thinking=true,context=1m,effort=high,fast=false]",
        name: "Claude Opus 4.6 1M",
      }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "claude-opus-4-6[thinking=true,context=200k,effort=extra-high,fast=true]",
        name: "Claude Opus 4.6 Extra High Fast",
      }),
    );
    expect(models).toContainEqual(
      expect.objectContaining({
        slug: "claude-opus-4-6[thinking=true,context=1m,effort=extra-high,fast=true]",
        name: "Claude Opus 4.6 Extra High 1M Fast",
      }),
    );
    expect(models.every((model) => model.supportsFastMode !== true)).toBe(true);
    expect(models.every((model) => model.supportedReasoningEfforts === undefined)).toBe(true);
    expect(models.every((model) => model.contextWindowOptions === undefined)).toBe(true);
  });
});

describe("applyCursorAcpModelSelection", () => {
  it("selects Cursor auto explicitly when the ACP model picker exposes it", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "composer-2[fast=true]",
          options: [
            { value: "auto", name: "Auto" },
            { value: "composer-2[fast=true]", name: "Composer 2" },
          ],
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "auto",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([{ type: "model", value: "auto" }]);
  });

  it("maps Cursor auto to legacy ACP default model values named Auto", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "composer-2[fast=true]",
          options: [
            { value: "default[]", name: "Auto" },
            { value: "composer-2[fast=true]", name: "Composer 2" },
          ],
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "auto",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([{ type: "model", value: "default[]" }]);
  });

  it("maps legacy Cursor base slugs to parameterized ACP model values", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default[]",
          options: [
            { value: "default[]", name: "Auto" },
            { value: "composer-2[fast=true]", name: "Composer 2" },
          ],
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "composer-2",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([{ type: "model", value: "composer-2[fast=true]" }]);
  });

  it("maps unsupported false boolean parameters to an available Cursor ACP model value", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "grok-4-20[thinking=true]",
          options: [
            { value: "default[]", name: "Auto" },
            { value: "grok-4-20[thinking=true]", name: "Grok 4.20" },
          ],
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "grok-4-20[thinking=false]",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([{ type: "model", value: "grok-4-20[thinking=true]" }]);
  });

  it("sets the base model before applying separate config options", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed(parameterizedGpt54ConfigOptions),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.4-medium-fast[reasoning=medium,context=272k]",
        options: {
          reasoningEffort: "xhigh",
          contextWindow: "1m",
          fastMode: true,
        },
        mapError: ({ step, configId, cause }) =>
          new Error(
            step === "set-config-option"
              ? `failed to set config option ${configId}: ${cause.message}`
              : `failed to set model: ${cause.message}`,
          ),
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "gpt-5.4-medium-fast" },
      { type: "config", configId: "reasoning", value: "extra-high" },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });

  it("maps synthetic Cursor model variants back to ACP model plus config options", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed(parameterizedCursorVariantConfigOptions),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "claude-opus-4-6[thinking=true,context=1m,effort=extra-high,fast=true]",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "claude-opus-4-6[thinking=true,context=1m,effort=extra-high,fast=true]",
      },
      { type: "config", configId: "reasoning", value: "extra-high" },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });

  it("maps Cursor CLI model ids to parameterized ACP values without silently dropping variants", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "composer-2[fast=true]",
          options: [
            { value: "composer-2[fast=true]", name: "composer-2" },
            {
              value: "claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]",
              name: "claude-opus-4-6",
            },
            { value: "gpt-5.3-codex-spark[reasoning=medium]", name: "gpt-5.3-codex-spark" },
          ],
        },
        {
          id: "reasoning",
          name: "Reasoning",
          category: "thought_level",
          type: "select",
          currentValue: "medium",
          options: [
            { value: "low", name: "Low" },
            { value: "medium", name: "Medium" },
            { value: "high", name: "High" },
            { value: "extra-high", name: "Extra High" },
          ],
        },
        {
          id: "context",
          name: "Context",
          category: "model_config",
          type: "select",
          currentValue: "200k",
          options: [
            { value: "200k", name: "200K" },
            { value: "1m", name: "1M" },
          ],
        },
        {
          id: "fast",
          name: "Fast",
          category: "model_config",
          type: "select",
          currentValue: "false",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "Fast" },
          ],
        },
        {
          id: "thinking",
          name: "Thinking",
          category: "model_config",
          type: "boolean",
          currentValue: false,
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "claude-4.6-opus-max-thinking-fast",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );
    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.3-codex-spark-preview-low",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "claude-opus-4-6[thinking=true,context=1m,effort=high,fast=true]",
      },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
      { type: "config", configId: "thinking", value: true },
      { type: "model", value: "gpt-5.3-codex-spark[reasoning=low]" },
      { type: "config", configId: "reasoning", value: "low" },
    ]);
  });

  it("keeps OpenAI CLI 1M context in the ACP model value so unsupported variants fail instead of falling back", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.5[context=272k,reasoning=medium,fast=false]",
          options: [
            {
              value: "gpt-5.5[context=272k,reasoning=medium,fast=false]",
              name: "gpt-5.5",
            },
          ],
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.5-medium",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "gpt-5.5[context=1m,reasoning=medium,fast=false]" },
    ]);
  });

  it("uses the accepted ACP model value when Cursor exposes fast as a separate option", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gpt-5.1-codex-max[reasoning=medium,fast=false]",
          options: [
            {
              value: "gpt-5.1-codex-max[reasoning=medium,fast=false]",
              name: "Codex 5.1 Max",
            },
          ],
        },
        {
          id: "fast",
          name: "Fast",
          category: "model_config",
          type: "select",
          currentValue: "false",
          options: [
            { value: "false", name: "Off" },
            { value: "true", name: "Fast" },
          ],
        },
      ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "gpt-5.1-codex-max-medium-fast",
        options: undefined,
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      { type: "model", value: "gpt-5.1-codex-max[reasoning=medium,fast=false]" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });

  it("maps collapsed Cursor model selections plus trait options to the ACP model value", async () => {
    const calls: Array<
      | { readonly type: "model"; readonly value: string }
      | { readonly type: "config"; readonly configId: string; readonly value: string | boolean }
    > = [];

    const runtime = {
      getConfigOptions: Effect.succeed(parameterizedCursorVariantConfigOptions),
      setModel: (value: string) =>
        Effect.sync(() => {
          calls.push({ type: "model", value });
        }),
      setConfigOption: (configId: string, value: string | boolean) =>
        Effect.sync(() => {
          calls.push({ type: "config", configId, value });
        }),
    };

    await Effect.runPromise(
      applyCursorAcpModelSelection({
        runtime,
        model: "claude-opus-4-6",
        options: {
          reasoningEffort: "xhigh",
          contextWindow: "1m",
          thinking: true,
          fastMode: true,
        },
        mapError: ({ cause }) => cause,
      }),
    );

    expect(calls).toEqual([
      {
        type: "model",
        value: "claude-opus-4-6[thinking=true,context=1m,effort=extra-high,fast=true]",
      },
      { type: "config", configId: "reasoning", value: "extra-high" },
      { type: "config", configId: "context", value: "1m" },
      { type: "config", configId: "fast", value: "true" },
    ]);
  });
});
