import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import {
  AgentGatewayTargetError,
  agentGatewayTargetOptionGuidance,
  resolveAgentGatewayTarget,
} from "./targetResolver.ts";

const discovery = {
  listModels: ({ provider }: { provider: string }) =>
    Effect.succeed({
      source: "test",
      models:
        provider === "codex"
          ? [
              {
                slug: "gpt-5.6-terra",
                name: "GPT-5.6 Terra",
                supportedReasoningEfforts: [
                  { value: "low", label: "Low" },
                  { value: "high", label: "High" },
                ],
              },
            ]
          : [],
    }),
} as unknown as ProviderDiscoveryServiceShape;

describe("agent gateway target resolver", () => {
  it.effect("builds examples from the exact model restrictions and preserves option types", () =>
    Effect.gen(function* () {
      const codexCatalog = {
        provider: "codex" as const,
        defaultModel: "gpt-5.5",
        enabled: true,
        available: true,
        models: [
          {
            slug: "gpt-5.6-terra",
            name: "GPT-5.6 Terra",
            supportedReasoningEfforts: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
          },
        ],
      };
      const codexGuidance = agentGatewayTargetOptionGuidance(codexCatalog);
      assert.deepEqual(codexGuidance.exampleTarget, {
        provider: "codex",
        model: "gpt-5.6-terra",
        options: { reasoningEffort: "low" },
      });
      assert.deepEqual(
        yield* resolveAgentGatewayTarget({
          target: codexGuidance.exampleTarget!,
          discovery,
        }),
        codexGuidance.exampleTarget,
      );

      const geminiGuidance = agentGatewayTargetOptionGuidance({
        provider: "gemini",
        defaultModel: "gemini-2.5-pro",
        enabled: true,
        available: true,
        models: [{ slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro" }],
      });
      assert.deepEqual(geminiGuidance.exampleTarget?.options, { thinkingLevel: "LOW" });
      const thinkingBudget = geminiGuidance.providerOptions.find(
        (option) => option.key === "thinkingBudget",
      );
      assert.equal(thinkingBudget?.valueType, "number");
      assert.deepEqual(thinkingBudget?.allowedValues, [-1, 512, 0]);

      const budgetModel = {
        slug: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        supportedReasoningEfforts: [
          { value: "-1", label: "Dynamic" },
          { value: "512", label: "512 tokens" },
        ],
      };
      const budgetGuidance = agentGatewayTargetOptionGuidance({
        provider: "gemini",
        defaultModel: "gemini-2.5-flash",
        enabled: true,
        available: true,
        models: [budgetModel],
      });
      assert.deepEqual(budgetGuidance.exampleTarget?.options, { thinkingBudget: -1 });
      const budgetDiscovery = {
        listModels: () => Effect.succeed({ source: "test", models: [budgetModel] }),
      } as unknown as ProviderDiscoveryServiceShape;
      assert.deepEqual(
        yield* resolveAgentGatewayTarget({
          target: budgetGuidance.exampleTarget!,
          discovery: budgetDiscovery,
        }),
        budgetGuidance.exampleTarget,
      );
    }),
  );

  it.effect("accepts Terra Low as a canonical model plus option", () =>
    Effect.gen(function* () {
      const target = {
        provider: "codex" as const,
        model: "gpt-5.6-terra",
        options: { reasoningEffort: "low" },
      };
      assert.deepEqual(yield* resolveAgentGatewayTarget({ target, discovery }), target);
    }),
  );

  it.effect("rejects a guessed model slug before creation", () =>
    Effect.gen(function* () {
      const result = yield* resolveAgentGatewayTarget({
        target: { provider: "codex", model: "gpt-5.6-terra-low" },
        discovery,
      }).pipe(
        Effect.map(() => ({ code: "unexpected-success" })),
        Effect.catch((error) => Effect.succeed(error)),
      );
      assert.equal(result.code, "model_unavailable");
    }),
  );

  it.effect("rejects an unadvertised effort", () =>
    Effect.gen(function* () {
      const result = yield* resolveAgentGatewayTarget({
        target: {
          provider: "codex",
          model: "gpt-5.6-terra",
          options: { reasoningEffort: "ultra" },
        },
        discovery,
      }).pipe(
        Effect.map(() => ({ code: "unexpected-success" })),
        Effect.catch((error) => Effect.succeed(error)),
      );
      assert.equal(result.code, "model_option_unavailable");
    }),
  );

  it.effect("validates every provider-specific option against the advertised descriptor", () =>
    Effect.gen(function* () {
      const optionDiscovery = {
        listModels: () =>
          Effect.succeed({
            source: "test",
            models: [
              {
                slug: "openai/gpt-5",
                name: "OpenAI GPT-5",
                optionDescriptors: [
                  {
                    id: "variant",
                    label: "Variant",
                    type: "select" as const,
                    options: [{ id: "high", label: "High" }],
                  },
                ],
              },
            ],
          }),
      } as unknown as ProviderDiscoveryServiceShape;
      const accepted = {
        provider: "opencode" as const,
        model: "openai/gpt-5",
        options: { variant: "high" },
      };
      assert.deepEqual(
        yield* resolveAgentGatewayTarget({ target: accepted, discovery: optionDiscovery }),
        accepted,
      );
      const result = yield* resolveAgentGatewayTarget({
        target: {
          provider: "opencode",
          model: "openai/gpt-5",
          options: { agent: "invented-agent" },
        },
        discovery: optionDiscovery,
      }).pipe(
        Effect.map(() => ({ code: "unexpected-success" })),
        Effect.catch((error) => Effect.succeed(error)),
      );
      assert.equal(result.code, "model_option_unavailable");
    }),
  );

  it.effect("fails closed before discovery when Synara disables a provider", () =>
    Effect.gen(function* () {
      let discoveryCalls = 0;
      const trackedDiscovery = {
        listModels: () => {
          discoveryCalls += 1;
          return Effect.succeed({ models: [], source: "test" });
        },
      } as unknown as ProviderDiscoveryServiceShape;
      const result = yield* resolveAgentGatewayTarget({
        target: { provider: "codex", model: "gpt-5.5" },
        discovery: trackedDiscovery,
        availability: { enabled: false },
      }).pipe(
        Effect.map(() => ({ code: "unexpected-success" })),
        Effect.catch((error) => Effect.succeed(error)),
      );
      assert.equal(result.code, "provider_unavailable");
      assert.equal(discoveryCalls, 0);
    }),
  );

  it.effect("rejects a known unavailable or unauthenticated provider", () =>
    Effect.gen(function* () {
      const result = yield* resolveAgentGatewayTarget({
        target: { provider: "codex", model: "gpt-5.5" },
        discovery,
        availability: {
          enabled: true,
          available: false,
          authStatus: "unauthenticated",
          message: "Codex is not authenticated.",
        },
      }).pipe(
        Effect.map(() => ({ code: "unexpected-success" })),
        Effect.catch((error) => Effect.succeed(error)),
      );
      assert.equal(result.code, "provider_unavailable");
      assert.instanceOf(result, AgentGatewayTargetError);
      if (!(result instanceof AgentGatewayTargetError)) return;
      assert.include(result.message, "not authenticated");
    }),
  );

  it.effect("allows only the configured default while model discovery is unavailable", () =>
    Effect.gen(function* () {
      const unavailableDiscovery = {
        listModels: () => Effect.fail(new Error("temporary discovery failure")),
      } as unknown as ProviderDiscoveryServiceShape;
      const defaultTarget = { provider: "codex" as const, model: "gpt-5.5" };
      assert.deepEqual(
        yield* resolveAgentGatewayTarget({
          target: defaultTarget,
          discovery: unavailableDiscovery,
          availability: { enabled: true, available: true, authStatus: "authenticated" },
        }),
        defaultTarget,
      );

      const customResult = yield* resolveAgentGatewayTarget({
        target: { provider: "codex", model: "gpt-5.6-terra" },
        discovery: unavailableDiscovery,
        availability: { enabled: true, available: true, authStatus: "authenticated" },
      }).pipe(
        Effect.map(() => ({ code: "unexpected-success" })),
        Effect.catch((error) => Effect.succeed(error)),
      );
      assert.equal(customResult.code, "model_unavailable");

      const invalidOption = yield* resolveAgentGatewayTarget({
        target: {
          provider: "codex",
          model: "gpt-5.5",
          options: { reasoningEffort: "invented" },
        },
        discovery: unavailableDiscovery,
        availability: { enabled: true, available: true, authStatus: "authenticated" },
      }).pipe(
        Effect.map(() => ({ code: "unexpected-success" })),
        Effect.catch((error) => Effect.succeed(error)),
      );
      assert.equal(invalidOption.code, "model_option_unavailable");
    }),
  );
});
