import { ThreadId } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Agent, Model, OpencodeClient, Part, Provider } from "@opencode-ai/sdk/v2";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, it, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import {
  type OpenCodeCliModelDescriptor,
  OpenCodeRuntimeError,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import {
  flattenOpenCodeCliModels,
  flattenOpenCodeModels,
  makeOpenCodeAdapterLive,
  normalizeOpenCodeTokenUsage,
  resolvePreferredOpenCodeModelProviders,
} from "./OpenCodeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

type TestModelInput = Omit<Partial<Model>, "capabilities"> &
  Pick<Model, "id" | "name"> & {
    readonly capabilities?: Partial<Model["capabilities"]>;
  };

function makeProvider(input: {
  id: string;
  name: string;
  source?: Provider["source"];
  env?: ReadonlyArray<string>;
  models?: Record<string, TestModelInput>;
}): Provider {
  return {
    id: input.id,
    name: input.name,
    source: input.source ?? "api",
    env: input.env ? [...input.env] : [],
    options: {},
    models: Object.fromEntries(
      Object.entries(input.models ?? {}).map(([modelId, model]) => [
        modelId,
        makeModel({
          providerID: input.id,
          ...model,
        }),
      ]),
    ),
  };
}

function makeModel(input: Omit<TestModelInput, "providerID"> & Pick<Model, "providerID">): Model {
  const capabilities: Model["capabilities"] = {
    temperature: true,
    reasoning: false,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: true,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
    ...input.capabilities,
  };

  return {
    id: input.id,
    providerID: input.providerID,
    api: input.api ?? { id: "openai", url: "https://api.openai.com/v1", npm: "@ai-sdk/openai" },
    name: input.name,
    capabilities,
    cost: input.cost ?? {
      input: 1,
      output: 1,
      cache: {
        read: 0,
        write: 0,
      },
    },
    limit: input.limit ?? {
      context: 128_000,
      output: 8_192,
    },
    status: input.status ?? "active",
    options: input.options ?? {},
    headers: input.headers ?? {},
    release_date: input.release_date ?? "2026-01-01",
    ...(input.family ? { family: input.family } : {}),
    ...(input.variants ? { variants: input.variants } : {}),
  };
}

function createMockOpenCodeRuntime(options?: {
  readonly inventory?: OpenCodeInventory;
  readonly inventoryError?: OpenCodeRuntimeError;
  readonly connectError?: OpenCodeRuntimeError;
  readonly cliModelsError?: OpenCodeRuntimeError;
  readonly cliModels?: ReadonlyArray<OpenCodeCliModelDescriptor>;
  readonly events?: AsyncIterable<unknown>;
  readonly prompt?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly promptAsync?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly commandList?: () => Promise<{
    data?: ReadonlyArray<{ name: string; description?: string }>;
  }>;
  readonly commandLists?: ReadonlyArray<ReadonlyArray<{ name: string; description?: string }>>;
  readonly messages?: () => Promise<{
    data: Array<{ info: Record<string, unknown>; parts: Part[] }>;
  }>;
  readonly session?: Record<string, unknown>;
}) {
  const abortCalls: Array<{ sessionID: string }> = [];
  const cliModelCalls: Array<Parameters<OpenCodeRuntimeShape["listOpenCodeCliModels"]>[0]> = [];
  const connectCalls: Array<Parameters<OpenCodeRuntimeShape["connectToOpenCodeServer"]>[0]> = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const updateCalls: Array<Record<string, unknown>> = [];
  const forkCalls: Array<{ sessionID: string }> = [];
  const permissionReplyCalls: Array<Record<string, unknown>> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  const emptySubscription = {
    async *[Symbol.asyncIterator]() {
      // No provider-side events needed for these adapter lifecycle tests.
    },
  };
  const client = {
    event: {
      subscribe: async () => ({ stream: options?.events ?? emptySubscription }),
    },
    session: {
      create: async (input: Record<string, unknown>) => {
        createCalls.push(input);
        return { data: { id: "opencode-session-1" } };
      },
      update: async (input: Record<string, unknown>) => {
        updateCalls.push(input);
        return { data: null };
      },
      promptAsync: async (promptInput: Record<string, unknown>) => {
        promptCalls.push(promptInput);
        if (options?.promptAsync) {
          return options.promptAsync(promptInput);
        }
        return { data: null };
      },
      prompt: async (promptInput: Record<string, unknown>) => {
        promptCalls.push(promptInput);
        if (options?.prompt) {
          return options.prompt(promptInput);
        }
        return { data: null };
      },
      abort: async (input: { sessionID: string }) => {
        abortCalls.push(input);
        return { data: null };
      },
      messages: options?.messages ?? (async () => ({ data: [] })),
      get: async () => ({ data: { directory: process.cwd(), ...(options?.session ?? {}) } }),
      revert: async () => ({ data: null }),
      summarize: async () => ({ data: null }),
      fork: async (input: { sessionID: string }) => {
        forkCalls.push(input);
        return { data: { id: "forked-session-1" } };
      },
    },
    permission: {
      reply: async (input: Record<string, unknown>) => {
        permissionReplyCalls.push(input);
        return { data: null };
      },
    },
    question: {
      reply: async () => ({ data: null }),
    },
    command: {
      list: options?.commandList ?? (async () => ({ data: [] })),
    },
  };
  let createClientCallCount = 0;

  const unexpectedOperation = (operation: string) =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation,
        detail: `Unexpected runtime operation: ${operation}`,
      }),
    );

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = () => {
    const commandList = options?.commandLists?.[createClientCallCount];
    createClientCallCount += 1;
    if (!commandList) {
      return client as unknown as OpencodeClient;
    }
    return {
      ...client,
      command: {
        list: async () => ({ data: commandList }),
      },
    } as unknown as OpencodeClient;
  };

  const runtime: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () => unexpectedOperation("startOpenCodeServerProcess"),
    connectToOpenCodeServer: (input) =>
      Effect.gen(function* () {
        connectCalls.push(input);
        if (options?.connectError) {
          return yield* options.connectError;
        }
        return {
          url: input.serverUrl ?? "http://127.0.0.1:4099",
          exitCode: null,
          external: Boolean(input.serverUrl),
        };
      }),
    runOpenCodeCommand: () => unexpectedOperation("runOpenCodeCommand"),
    createOpenCodeSdkClient,
    loadOpenCodeInventory: () =>
      options?.inventoryError
        ? Effect.fail(options.inventoryError)
        : Effect.succeed(
            options?.inventory ?? {
              providerList: { connected: [], all: [], default: {} },
              agents: [],
              consoleState: null,
            },
          ),
    listOpenCodeCliModels: (input) =>
      Effect.gen(function* () {
        cliModelCalls.push(input);
        if (options?.cliModelsError) {
          return yield* options.cliModelsError;
        }
        return options?.cliModels ?? [];
      }),
    loadOpenCodeCredentialProviderIDs: () => Effect.succeed([]),
  };

  return {
    abortCalls,
    cliModelCalls,
    connectCalls,
    createCalls,
    updateCalls,
    forkCalls,
    permissionReplyCalls,
    promptCalls,
    runtime,
  };
}

function createSubscribedEventQueue() {
  const pendingEvents: Array<unknown> = [];
  let waitingResolver: ((result: IteratorResult<unknown>) => void) | undefined;
  let closed = false;

  return {
    push(event: unknown) {
      if (closed) {
        return;
      }
      if (waitingResolver) {
        const resolve = waitingResolver;
        waitingResolver = undefined;
        resolve({ value: event, done: false });
        return;
      }
      pendingEvents.push(event);
    },
    close() {
      closed = true;
      if (waitingResolver) {
        const resolve = waitingResolver;
        waitingResolver = undefined;
        resolve({ value: undefined, done: true });
      }
    },
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next: async (): Promise<IteratorResult<unknown>> => {
            if (pendingEvents.length > 0) {
              return {
                value: pendingEvents.shift(),
                done: false,
              };
            }
            if (closed) {
              return { value: undefined, done: true };
            }
            return await new Promise<IteratorResult<unknown>>((resolve) => {
              waitingResolver = resolve;
            });
          },
        };
      },
    },
  };
}

function makeInventoryWithContextLimit(input: {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly contextLimit?: number;
}): OpenCodeInventory {
  const providerId = input.providerId ?? "openai";
  const modelId = input.modelId ?? "gpt-5.4";
  return {
    providerList: {
      connected: [providerId],
      all: [
        makeProvider({
          id: providerId,
          name: "OpenAI",
          source: "api",
          models: {
            [modelId]: {
              id: modelId,
              name: "GPT-5.4",
              limit: {
                context: input.contextLimit ?? 200_000,
                output: 8_192,
              },
            },
          },
        }),
      ],
      default: {},
    },
    agents: [],
    consoleState: null,
  };
}

function assistantMessageUpdated(input?: {
  readonly id?: string;
  readonly tokens?: {
    readonly input: number;
    readonly output: number;
    readonly reasoning: number;
    readonly cache: {
      readonly read: number;
      readonly write: number;
    };
  };
  readonly cost?: number;
}) {
  return {
    type: "message.updated",
    properties: {
      sessionID: "opencode-session-1",
      info: {
        id: input?.id ?? "assistant-message-usage",
        role: "assistant",
        tokens: input?.tokens ?? {
          input: 120,
          output: 80,
          reasoning: 30,
          cache: {
            read: 10,
            write: 5,
          },
        },
        cost: input?.cost ?? 0.1234,
      },
    },
  };
}

function idleStatusEvent() {
  return {
    type: "session.status",
    properties: {
      sessionID: "opencode-session-1",
      status: {
        type: "idle",
      },
    },
  };
}

describe("normalizeOpenCodeTokenUsage", () => {
  it("converts OpenCode assistant tokens into a context usage snapshot", () => {
    expect(
      normalizeOpenCodeTokenUsage(
        {
          input: 100,
          output: 50,
          reasoning: 25,
          cache: {
            read: 10,
            write: 5,
          },
        },
        200_000,
      ),
    ).toEqual({
      usedTokens: 190,
      totalProcessedTokens: 190,
      maxTokens: 200_000,
      inputTokens: 100,
      cachedInputTokens: 15,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 190,
      lastInputTokens: 100,
      lastCachedInputTokens: 15,
      lastOutputTokens: 50,
      lastReasoningOutputTokens: 25,
    });
  });

  it("returns undefined for missing, malformed, negative, infinite, or all-zero usage", () => {
    const validBase = {
      input: 1,
      output: 1,
      reasoning: 1,
      cache: {
        read: 1,
        write: 1,
      },
    };

    expect(normalizeOpenCodeTokenUsage(undefined)).toBeUndefined();
    expect(normalizeOpenCodeTokenUsage({ ...validBase, input: -1 })).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({ ...validBase, output: Number.POSITIVE_INFINITY }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({ ...validBase, cache: { read: Number.NaN, write: 1 } }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({
        input: 0,
        output: 0,
        reasoning: 0,
        cache: {
          read: 0,
          write: 0,
        },
      }),
    ).toBeUndefined();
    expect(
      normalizeOpenCodeTokenUsage({
        input: 1,
        output: 1,
        reasoning: 1,
      }),
    ).toBeUndefined();
  });

  it("clamps used tokens to the model context limit while preserving total processed tokens", () => {
    expect(
      normalizeOpenCodeTokenUsage(
        {
          input: 150,
          output: 75,
          reasoning: 50,
          cache: {
            read: 25,
            write: 25,
          },
        },
        200,
      ),
    ).toMatchObject({
      usedTokens: 200,
      totalProcessedTokens: 325,
      maxTokens: 200,
      lastUsedTokens: 200,
    });
  });
});

describe("resolvePreferredOpenCodeModelProviders", () => {
  it("keeps explicit credential providers and OpenCode-managed providers together", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "opencode"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
            }),
          ],
        },
        consoleState: {
          consoleManagedProviders: [],
        },
      },
      credentialProviderIDs: ["openai"],
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "opencode"]);
  });

  it("adds console-managed connected providers to the preferred set", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "opencode", "openrouter"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
            }),
            makeProvider({
              id: "openrouter",
              name: "OpenRouter",
              source: "api",
            }),
          ],
        },
        consoleState: {
          consoleManagedProviders: ["openrouter"],
        },
      },
      credentialProviderIDs: ["openai"],
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "opencode", "openrouter"]);
  });

  it("prefers OpenCode-managed providers before generic non-environment providers", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "opencode"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(providers.map((provider) => provider.id)).toEqual(["opencode"]);
  });

  it("falls back to non-environment connected providers when no stronger OpenCode signals exist", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "openai", "openrouter"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
            }),
            makeProvider({
              id: "openrouter",
              name: "OpenRouter",
              source: "api",
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(providers.map((provider) => provider.id)).toEqual(["openai", "openrouter"]);
  });

  it("falls back to every connected provider when only environment providers are connected", () => {
    const providers = resolvePreferredOpenCodeModelProviders({
      inventory: {
        providerList: {
          connected: ["cloudflare-ai-gateway", "cloudflare-workers-ai"],
          all: [
            makeProvider({
              id: "cloudflare-ai-gateway",
              name: "Cloudflare AI Gateway",
              source: "env",
            }),
            makeProvider({
              id: "cloudflare-workers-ai",
              name: "Cloudflare Workers AI",
              source: "env",
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(providers.map((provider) => provider.id)).toEqual([
      "cloudflare-ai-gateway",
      "cloudflare-workers-ai",
    ]);
  });
});

describe("flattenOpenCodeModels", () => {
  it("converts OpenCode CLI model output into grouped model descriptors", () => {
    const models = flattenOpenCodeCliModels({
      models: [
        {
          slug: "openai/gpt-5.4",
          providerID: "openai",
          modelID: "gpt-5.4",
          name: "GPT-5.4",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "opencode/minimax-m2.5-free",
          providerID: "opencode",
          modelID: "minimax-m2.5-free",
          name: "MiniMax M2.5 Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "opencode-go/kimi-k2.6",
          providerID: "opencode-go",
          modelID: "kimi-k2.6",
          name: "Kimi K2.6",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "kimi-for-coding/k2p6",
          providerID: "kimi-for-coding",
          modelID: "k2p6",
          name: "K2P6",
          variants: [],
          supportedReasoningEfforts: [
            {
              value: "high",
            },
          ],
          defaultReasoningEffort: "high",
        },
        {
          slug: "github-copilot/claude-sonnet-4.6",
          providerID: "github-copilot",
          modelID: "claude-sonnet-4.6",
          name: "Claude Sonnet 4.6",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "anthropic/claude-sonnet-4-5",
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "google-vertex/gemini-3-pro",
          providerID: "google-vertex",
          modelID: "gemini-3-pro",
          name: "Gemini 3 Pro",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "openrouter/qwen/qwen3-coder",
          providerID: "openrouter",
          modelID: "qwen/qwen3-coder",
          name: "Qwen3 Coder",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "ollama/qwen3-coder:30b",
          providerID: "ollama",
          modelID: "qwen3-coder:30b",
          name: "Qwen3 Coder 30B",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "amazon-bedrock/anthropic-claude-sonnet-4.5",
          providerID: "amazon-bedrock",
          modelID: "anthropic-claude-sonnet-4.5",
          name: "Claude Sonnet 4.5",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "vercel-ai-gateway/xai/grok-code-fast",
          providerID: "vercel-ai-gateway",
          modelID: "xai/grok-code-fast",
          name: "Grok Code Fast",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
    });

    expect(models).toEqual([
      {
        slug: "amazon-bedrock/anthropic-claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        upstreamProviderId: "amazon-bedrock",
        upstreamProviderName: "Amazon Bedrock",
      },
      {
        slug: "anthropic/claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        upstreamProviderId: "anthropic",
        upstreamProviderName: "Anthropic",
      },
      {
        slug: "github-copilot/claude-sonnet-4.6",
        name: "Claude Sonnet 4.6",
        upstreamProviderId: "github-copilot",
        upstreamProviderName: "GitHub Copilot",
      },
      {
        slug: "google-vertex/gemini-3-pro",
        name: "Gemini 3 Pro",
        upstreamProviderId: "google-vertex",
        upstreamProviderName: "Google Vertex AI",
      },
      {
        slug: "kimi-for-coding/k2p6",
        name: "K2P6",
        upstreamProviderId: "kimi-for-coding",
        upstreamProviderName: "Kimi For Coding",
        supportedReasoningEfforts: [
          {
            value: "high",
          },
        ],
        defaultReasoningEffort: "high",
      },
      {
        slug: "ollama/qwen3-coder:30b",
        name: "Qwen3 Coder 30B",
        upstreamProviderId: "ollama",
        upstreamProviderName: "Ollama",
      },
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
      {
        slug: "opencode/minimax-m2.5-free",
        name: "MiniMax M2.5 Free",
        upstreamProviderId: "opencode",
        upstreamProviderName: "OpenCode",
      },
      {
        slug: "opencode-go/kimi-k2.6",
        name: "Kimi K2.6",
        upstreamProviderId: "opencode-go",
        upstreamProviderName: "OpenCode Go",
      },
      {
        slug: "openrouter/qwen/qwen3-coder",
        name: "Qwen3 Coder",
        upstreamProviderId: "openrouter",
        upstreamProviderName: "OpenRouter",
      },
      {
        slug: "vercel-ai-gateway/xai/grok-code-fast",
        name: "Grok Code Fast",
        upstreamProviderId: "vercel-ai-gateway",
        upstreamProviderName: "Vercel AI Gateway",
      },
    ]);
  });

  it("includes upstream provider metadata for grouped OpenCode model menus", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["opencode", "openai"],
          all: [
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
              models: {
                "nemotron-3-super-free": {
                  id: "nemotron-3-super-free",
                  name: "Nemotron 3 Super Free",
                },
              },
            }),
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
              models: {
                "gpt-5": {
                  id: "gpt-5",
                  name: "GPT-5",
                },
              },
            }),
          ],
        },
        consoleState: {
          consoleManagedProviders: ["openai"],
        },
      },
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
      },
      {
        slug: "opencode/nemotron-3-super-free",
        name: "Nemotron 3 Super Free",
        upstreamProviderId: "opencode",
        upstreamProviderName: "OpenCode",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
      },
    ]);
  });

  it("surfaces reasoning variants as supported thinking levels for OpenCode models", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["openai"],
          all: [
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  capabilities: {
                    reasoning: true,
                  },
                  variants: {
                    none: {
                      reasoningEffort: "none",
                    },
                    low: {
                      reasoningEffort: "low",
                    },
                    minimal: {
                      reasoning: {
                        effort: "minimal",
                      },
                    },
                    medium: {
                      reasoningEffort: "medium",
                    },
                    high: {
                      reasoningEffort: "high",
                    },
                    xhigh: {
                      reasoningEffort: "xhigh",
                    },
                    custom: {
                      label: "Do not treat as thinking",
                    },
                  },
                },
              },
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
        supportedReasoningEfforts: [
          {
            value: "none",
          },
          {
            value: "low",
          },
          {
            value: "minimal",
          },
          {
            value: "medium",
          },
          {
            value: "high",
          },
          {
            value: "xhigh",
          },
        ],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("trims upstream provider and model names before exposing runtime models", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["openai"],
          all: [
            makeProvider({
              id: "openai",
              name: " OpenAI ",
              source: "api",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: " GPT-5.4 ",
                },
              },
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        contextWindowOptions: [{ value: "128k", label: "128K", isDefault: true }],
        defaultContextWindow: "128k",
      },
    ]);
  });

  it("prefers OpenCode-managed connected providers when no stronger auth metadata exists", () => {
    const models = flattenOpenCodeModels({
      inventory: {
        providerList: {
          connected: ["opencode", "github-copilot"],
          all: [
            makeProvider({
              id: "opencode",
              name: "OpenCode",
              source: "api",
              models: {
                "glm-4.6": {
                  id: "glm-4.6",
                  name: "GLM 4.6",
                },
              },
            }),
            makeProvider({
              id: "github-copilot",
              name: "GitHub Copilot",
              source: "api",
              models: {
                "claude-opus-4.6": {
                  id: "claude-opus-4.6",
                  name: "Claude Opus 4.6",
                },
              },
            }),
            makeProvider({
              id: "openrouter",
              name: "OpenRouter",
              source: "api",
              models: {
                "qwen/qwen3-coder": {
                  id: "qwen/qwen3-coder",
                  name: "Qwen3 Coder",
                },
              },
            }),
          ],
        },
        consoleState: null,
      },
    });

    expect(models.map((model) => model.slug)).toEqual(["opencode/glm-4.6"]);
  });
});

describe("OpenCodeAdapter runtime lifecycle", () => {
  it("lists OpenCode models from the CLI before falling back to server inventory", async () => {
    const runtime = createMockOpenCodeRuntime({
      cliModels: [
        {
          slug: "opencode/minimax-m2.5-free",
          providerID: "opencode",
          modelID: "minimax-m2.5-free",
          name: "MiniMax M2.5 Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
        {
          slug: "opencode-go/kimi-k2.6",
          providerID: "opencode-go",
          modelID: "kimi-k2.6",
          name: "Kimi K2.6",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
      inventory: {
        providerList: {
          connected: ["openai"],
          default: {},
          all: [
            makeProvider({
              id: "openai",
              name: "OpenAI",
              source: "api",
              models: {
                "gpt-5": {
                  id: "gpt-5",
                  name: "GPT-5",
                },
              },
            }),
          ],
        },
        agents: [],
        consoleState: null,
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listModels = adapter.listModels;
        if (!listModels) {
          throw new Error("Expected OpenCode adapter to support runtime model listing.");
        }
        return yield* listModels({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/model-discovery-config",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toMatchObject({
      source: "opencode-cli",
      cached: false,
    });
    expect(result?.models.map((model) => model.slug)).toEqual([
      "openai/gpt-5",
      "opencode/minimax-m2.5-free",
      "opencode-go/kimi-k2.6",
    ]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/model-discovery-config" });
    expect(runtime.cliModelCalls).toHaveLength(1);
    expect(runtime.cliModelCalls[0]).toMatchObject({ cwd: "/repo/model-discovery-config" });
  });

  it("lists OpenCode CLI models when server inventory discovery fails", async () => {
    const runtime = createMockOpenCodeRuntime({
      connectError: new OpenCodeRuntimeError({
        operation: "connectToOpenCodeServer",
        detail: "OpenCode server failed to start.",
      }),
      cliModels: [
        {
          slug: "opencode/nemotron-3-ultra-free",
          providerID: "opencode",
          modelID: "nemotron-3-ultra-free",
          name: "Nemotron 3 Ultra Free",
          variants: [],
          supportedReasoningEfforts: [],
        },
      ],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listModels = adapter.listModels;
        if (!listModels) {
          throw new Error("Expected OpenCode adapter to support runtime model listing.");
        }
        return yield* listModels({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/server-startup-fails",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toMatchObject({
      source: "opencode-cli",
      cached: false,
    });
    expect(result?.models.map((model) => model.slug)).toEqual(["opencode/nemotron-3-ultra-free"]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/server-startup-fails" });
    expect(runtime.cliModelCalls).toHaveLength(1);
    expect(runtime.cliModelCalls[0]).toMatchObject({ cwd: "/repo/server-startup-fails" });
  });

  it("lists OpenCode agents from the active discovery cwd", async () => {
    const runtime = createMockOpenCodeRuntime({
      inventory: {
        providerList: {
          connected: [],
          default: {},
          all: [],
        },
        agents: [
          {
            name: "project-review",
            displayName: "Project Review",
            description: "Review code with the project-local agent",
            mode: "primary",
            hidden: false,
          } as unknown as Agent,
        ],
        consoleState: null,
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listAgents = adapter.listAgents;
        if (!listAgents) {
          throw new Error("Expected OpenCode adapter to support runtime agent listing.");
        }
        return yield* listAgents({
          provider: "opencode",
          binaryPath: "opencode",
          cwd: "/repo/agent-discovery-config",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toMatchObject({
      source: "opencode",
      cached: false,
      agents: [
        {
          name: "project-review",
          displayName: "Project Review",
          description: "Review code with the project-local agent",
        },
      ],
    });
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/agent-discovery-config" });
  });

  it("does not reuse an unrelated active OpenCode session for command discovery", async () => {
    const runtime = createMockOpenCodeRuntime({
      commandLists: [[{ name: "wrong-thread" }], [{ name: "review", description: "Review code" }]],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-active"),
          runtimeMode: "full-access",
        });

        return yield* listCommands({
          provider: "opencode",
          cwd: process.cwd(),
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toEqual({
      commands: [{ name: "review", description: "Review code" }],
      source: "opencode",
      cached: false,
    });
  });

  it("passes the session cwd to managed OpenCode server connections", async () => {
    const runtime = createMockOpenCodeRuntime();
    const cwd = process.cwd();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-managed-cwd"),
          runtimeMode: "full-access",
          cwd,
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd });
  });

  it("uses the persisted resume cursor cwd when resuming OpenCode sessions", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        return yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-resume-cwd"),
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: "/repo/resume" },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.createCalls).toEqual([]);
    expect(runtime.connectCalls).toHaveLength(1);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/resume" });
    expect(result.cwd).toBe("/repo/resume");
    expect(result.resumeCursor).toMatchObject({
      openCodeSessionId: "existing-session-1",
      cwd: "/repo/resume",
    });
  });

  it("re-applies the runtime-mode permission ruleset when resuming OpenCode sessions", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-resume-permissions"),
          runtimeMode: "full-access",
          resumeCursor: { openCodeSessionId: "existing-session-1", cwd: "/repo/resume" },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.createCalls).toEqual([]);
    expect(runtime.updateCalls).toEqual([
      {
        sessionID: "existing-session-1",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      },
    ]);
  });

  it("declines inactive OpenCode native fork when source and target cwd differ", async () => {
    const runtime = createMockOpenCodeRuntime();

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* OpenCodeAdapter;
          const forkThread = adapter.forkThread;
          if (!forkThread) {
            throw new Error("Expected OpenCode adapter to support native thread forking.");
          }
          return yield* forkThread({
            sourceThreadId: asThreadId("thread-source"),
            threadId: asThreadId("thread-target"),
            sourceResumeCursor: { openCodeSessionId: "source-session-1" },
            sourceCwd: "/repo/source",
            cwd: "/repo/target",
            runtimeMode: "full-access",
          });
        }).pipe(
          Effect.provide(
            makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    ).rejects.toThrow("native fork cannot cross cwd boundaries");

    expect(runtime.forkCalls).toEqual([]);
    expect(runtime.connectCalls).toEqual([]);
  });

  it("defaults inactive OpenCode native forks to the source cwd", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const forkThread = adapter.forkThread;
        if (!forkThread) {
          throw new Error("Expected OpenCode adapter to support native thread forking.");
        }
        return yield* forkThread({
          sourceThreadId: asThreadId("thread-source"),
          threadId: asThreadId("thread-target"),
          sourceResumeCursor: { openCodeSessionId: "source-session-1" },
          sourceCwd: "/repo/source",
          runtimeMode: "full-access",
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.forkCalls).toEqual([{ sessionID: "source-session-1" }]);
    expect(runtime.connectCalls).toHaveLength(2);
    expect(runtime.connectCalls[0]).toMatchObject({ cwd: "/repo/source" });
    expect(runtime.connectCalls[1]).toMatchObject({ cwd: "/repo/source" });
    expect(result.resumeCursor).toMatchObject({
      openCodeSessionId: "forked-session-1",
      cwd: "/repo/source",
    });
  });

  it("reuses the matching active OpenCode thread for command discovery", async () => {
    const threadId = asThreadId("thread-command-discovery");
    const runtime = createMockOpenCodeRuntime({
      commandLists: [[{ name: "active-thread-command" }], [{ name: "scoped-client-command" }]],
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
        });

        return yield* listCommands({
          provider: "opencode",
          threadId,
          cwd: process.cwd(),
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.commands.map((command) => command.name)).toEqual(["active-thread-command"]);
  });

  it("returns no OpenCode commands when command discovery is unsupported", async () => {
    const runtime = createMockOpenCodeRuntime({
      commandList: async () => {
        throw new Error("status=404 body={}");
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const listCommands = adapter.listCommands;
        if (!listCommands) {
          throw new Error("Expected OpenCode adapter to support command listing.");
        }

        return yield* listCommands({
          provider: "opencode",
          cwd: process.cwd(),
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result).toEqual({
      commands: [],
      source: "unsupported",
      cached: false,
    });
  });

  it("pins the initial model on new OpenCode sessions", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-model-pin"),
          runtimeMode: "full-access",
          modelSelection: {
            provider: "opencode",
            model: "opencode/big-pickle",
            options: {
              agent: "build",
              variant: "fast",
            },
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.createCalls[0]).toMatchObject({
      model: {
        providerID: "opencode",
        id: "big-pickle",
        variant: "fast",
      },
      agent: "build",
      title: "Synara thread-model-pin",
    });
  });

  it("clears adapter session state when interrupting an active OpenCode turn", async () => {
    const runtime = createMockOpenCodeRuntime();

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-1"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
            options: {
              variant: "high",
            },
          },
        });

        const [runningSession] = yield* adapter.listSessions();

        yield* adapter.interruptTurn(asThreadId("thread-1"));

        const [readySession] = yield* adapter.listSessions();
        const events = Array.from(yield* Fiber.join(eventsFiber));

        return { events, readySession, runningSession };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls).toHaveLength(1);
    const firstPromptText = (
      runtime.promptCalls[0]?.parts as ReadonlyArray<{ readonly text?: string }> | undefined
    )?.[0]?.text;
    expect(firstPromptText).toContain(SYNARA_HARNESS_POLICY_MARKER);
    expect(firstPromptText).toContain("Synara MCP control is unavailable");
    expect(runtime.promptCalls[0]).toMatchObject({
      model: {
        providerID: "openai",
        modelID: "gpt-5.4",
      },
      variant: "high",
    });
    expect(runtime.abortCalls.length).toBeGreaterThanOrEqual(1);
    expect(runtime.abortCalls[0]).toEqual({ sessionID: "opencode-session-1" });
    expect(result.runningSession?.status).toBe("running");
    expect(result.runningSession?.activeTurnId).toBeDefined();
    expect(result.readySession).toMatchObject({
      provider: "opencode",
      status: "ready",
      model: "openai/gpt-5.4",
    });
    expect(result.readySession?.activeTurnId).toBeUndefined();
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "turn.aborted",
      payload: {
        reason: "Interrupted by user.",
      },
    });
  });

  it("replays assistant text when OpenCode sends delta before part snapshot and assistant role", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-ordered-events"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-ordered-events"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.part.delta",
          properties: {
            sessionID: "opencode-session-1",
            partID: "part-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-1",
              messageID: "assistant-message-1",
              type: "text",
              text: "",
              time: {
                start: 1,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-1",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-1",
              messageID: "assistant-message-1",
              type: "text",
              text: "Hello",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });
        eventQueue.push({
          type: "session.status",
          properties: {
            sessionID: "opencode-session-1",
            status: {
              type: "idle",
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();

        return { events, turn };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.turn.turnId).toBeDefined();
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Hello",
      },
    });
    expect(result.events[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "Hello",
      },
    });
  });

  it("filters Kilo synthetic and ignored text parts from assistant transcript", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-synthetic-kilo-parts"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-synthetic-kilo-parts"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-filtered",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-synthetic",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Initializing snapshot...",
              synthetic: true,
              time: {
                start: 1,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-ignored",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Internal warning",
              ignored: true,
              time: {
                start: 2,
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-visible",
              messageID: "assistant-message-filtered",
              type: "text",
              text: "Actual answer",
              time: {
                start: 3,
                end: 4,
              },
            },
          },
        });
        eventQueue.push({
          type: "session.status",
          properties: {
            sessionID: "opencode-session-1",
            status: {
              type: "idle",
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Actual answer",
      },
    });
    expect(JSON.stringify(result)).not.toContain("Initializing snapshot");
    expect(JSON.stringify(result)).not.toContain("Internal warning");
  });

  it("sends plan-mode prompt instructions and captures tagged markdown as a proposed plan", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-plan-events"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-plan-events"),
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-plan",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-plan",
              messageID: "assistant-message-plan",
              type: "text",
              text: "<proposed_plan>\n# OpenCode plan\n\n- capture it\n</proposed_plan>",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]?.parts).toEqual([
      {
        type: "text",
        text: expect.stringContaining("Synara plan mode is active."),
      },
    ]);
    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "turn.proposed.completed",
      "item.completed",
    ]);
    expect(result[4]).toMatchObject({
      type: "turn.proposed.completed",
      payload: {
        planMarkdown: "# OpenCode plan\n\n- capture it",
      },
    });
  });

  it("pins default-mode turns to the OpenCode build agent", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-default-build-agent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-default-build-agent"),
          input: "implement this",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]).toMatchObject({
      agent: "build",
    });
  });

  it("projects generic file attachments into text instead of native OpenCode file parts", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-docx-attachment"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-docx-attachment"),
          input: "summarize this",
          interactionMode: "default",
          attachments: [
            {
              type: "file",
              id: "thread-docx-attachment-00000000-0000-4000-8000-000000000001",
              name: "minutes.docx",
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              sizeBytes: 4_096,
            },
          ],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const parts = runtime.promptCalls[0]?.parts as Array<Record<string, unknown>> | undefined;
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).toMatchObject({ type: "text" });
    expect(parts?.[0]?.text).toEqual(expect.stringContaining("<attached_files>"));
    expect(parts?.[0]?.text).toEqual(expect.stringContaining('"minutes.docx"'));
    expect(parts?.[0]?.text).toEqual(
      expect.stringContaining(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    );
    expect(parts?.[0]?.text).toEqual(expect.stringContaining(".docx"));
  });

  it("pins plan-mode turns to the OpenCode plan agent", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-plan-agent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-plan-agent"),
          input: "plan this",
          interactionMode: "plan",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]).toMatchObject({
      agent: "plan",
    });
  });

  it("preserves explicitly selected OpenCode agents", async () => {
    const runtime = createMockOpenCodeRuntime();

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-explicit-agent"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-explicit-agent"),
          input: "use custom agent",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
            options: {
              agent: "reviewer",
            },
          },
        });
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(runtime.promptCalls[0]).toMatchObject({
      agent: "reviewer",
    });
  });

  it("does not capture tagged markdown as a proposed plan outside plan mode", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-default-tagged-plan"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-default-tagged-plan"),
          input: "show an example tagged block",
          interactionMode: "default",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "assistant-message-default-plan",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-default-plan",
              messageID: "assistant-message-default-plan",
              type: "text",
              text: "<proposed_plan>\n# Not a Synara plan\n</proposed_plan>",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
    ]);
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "<proposed_plan>\n# Not a Synara plan\n</proposed_plan>",
      },
    });
  });

  it("emits context usage from OpenCode assistant message updates", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      inventory: makeInventoryWithContextLimit({ contextLimit: 200_000 }),
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-events"),
          runtimeMode: "full-access",
        });

        const turn = yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-events"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(assistantMessageUpdated());

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return { events, turn };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const usageEvent = result.events.find((event) => event.type === "thread.token-usage.updated");
    expect(usageEvent).toMatchObject({
      type: "thread.token-usage.updated",
      turnId: result.turn.turnId,
      payload: {
        usage: {
          usedTokens: 245,
          totalProcessedTokens: 245,
          inputTokens: 120,
          cachedInputTokens: 15,
          outputTokens: 80,
          reasoningOutputTokens: 30,
          maxTokens: 200_000,
          lastUsedTokens: 245,
          lastInputTokens: 120,
          lastCachedInputTokens: 15,
          lastOutputTokens: 80,
          lastReasoningOutputTokens: 30,
        },
      },
      raw: {
        source: "opencode.sdk.event",
      },
    });
  });

  it("does not emit duplicate usage for identical assistant message updates", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime({
      inventory: makeInventoryWithContextLimit({ contextLimit: 200_000 }),
    });
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-dedup"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-dedup"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(assistantMessageUpdated());
        eventQueue.push(assistantMessageUpdated());

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.filter((event) => event.type === "thread.token-usage.updated")).toHaveLength(1);
  });

  it("emits usage without max tokens when the selected model limit is unknown", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-unknown-limit"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-unknown-limit"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(assistantMessageUpdated());

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const usageEvent = events.find((event) => event.type === "thread.token-usage.updated");
    expect(usageEvent).toMatchObject({
      type: "thread.token-usage.updated",
      payload: {
        usage: {
          usedTokens: 245,
          totalProcessedTokens: 245,
        },
      },
    });
    expect(
      usageEvent?.type === "thread.token-usage.updated" && usageEvent.payload.usage,
    ).not.toHaveProperty("maxTokens");
  });

  it("ignores malformed and zero-token assistant usage updates", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-usage-zero"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-usage-zero"),
          input: "count tokens",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push(
          assistantMessageUpdated({
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          }),
        );
        eventQueue.push(
          assistantMessageUpdated({
            id: "assistant-message-malformed",
            tokens: {
              input: Number.NaN,
              output: 1,
              reasoning: 1,
              cache: {
                read: 1,
                write: 1,
              },
            },
          }),
        );
        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
    ]);
  });

  it("maps OpenCode todo updates into shared turn tasks", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-todo-updated"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-todo-updated"),
          input: "work through todos",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "todo.updated",
          properties: {
            sessionID: "opencode-session-1",
            todos: [
              { content: "Inspect OpenCode events", status: "completed", priority: "high" },
              { content: "Wire todo updates", status: "in_progress", priority: "medium" },
              { content: "Report back", status: "pending", priority: "low" },
            ],
          },
        });

        const runtimeEvents = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return runtimeEvents;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    const taskEvent = events.find((event) => event.type === "turn.tasks.updated");
    expect(taskEvent?.type).toBe("turn.tasks.updated");
    if (taskEvent?.type === "turn.tasks.updated") {
      expect(taskEvent.payload.tasks).toEqual([
        { task: "Inspect OpenCode events", status: "completed" },
        { task: "Wire todo updates", status: "inProgress" },
        { task: "Report back", status: "pending" },
      ]);
    }
  });

  it("streams and completes turns from newer OpenCode session.next events", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-next-events"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-next-events"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0.025,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: "Hello",
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "assistant_message",
        detail: "Hello",
      },
    });
  });

  it("auto-approves OpenCode permission asks in full access without surfacing approvals", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-full-access-permission"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-full-access-permission"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "opencode-session-1",
            permission: "external_directory",
            patterns: ["/outside/project/**"],
            metadata: {},
            always: [],
          },
        });
        eventQueue.push({
          id: "evt-permission-replied",
          type: "permission.replied",
          properties: {
            sessionID: "opencode-session-1",
            requestID: "permission-1",
            reply: "always",
          },
        });
        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
    expect(runtime.permissionReplyCalls).toEqual([{ requestID: "permission-1", reply: "always" }]);
  });

  it("suppresses a permission.replied echo that arrives after turn teardown", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 7)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-late-permission-echo"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-late-permission-echo"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        // Auto-approved ask at the tail of the turn; the reply echo has not arrived yet
        // when the turn completes and active-turn state is torn down.
        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-late-1",
            sessionID: "opencode-session-1",
            permission: "external_directory",
            patterns: ["/outside/project/**"],
            metadata: {},
            always: [],
          },
        });
        eventQueue.push({
          id: "evt-next-text-delta",
          type: "session.next.text.delta",
          properties: {
            timestamp: 1,
            sessionID: "opencode-session-1",
            delta: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-text-ended",
          type: "session.next.text.ended",
          properties: {
            timestamp: 2,
            sessionID: "opencode-session-1",
            text: "Hello",
          },
        });
        eventQueue.push({
          id: "evt-next-step-ended",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });
        // Late echo after teardown: must be swallowed as the auto-approved reply, not
        // surfaced as a request.resolved for a request the UI never saw opened.
        eventQueue.push({
          id: "evt-late-permission-replied",
          type: "permission.replied",
          properties: {
            sessionID: "opencode-session-1",
            requestID: "permission-late-1",
            reply: "always",
          },
        });
        // A queued question flushes the stream: the queue is FIFO, so its
        // user-input.requested must be the next event, proving the late echo emitted nothing.
        eventQueue.push({
          id: "evt-question-asked",
          type: "question.asked",
          properties: {
            id: "question-1",
            sessionID: "opencode-session-1",
            questions: [
              {
                question: "Proceed?",
                header: "Confirm",
                options: [{ label: "Yes", description: "" }],
                multiple: false,
                custom: false,
              },
            ],
            tool: undefined,
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
      "user-input.requested",
    ]);
    expect(runtime.permissionReplyCalls).toEqual([
      { requestID: "permission-late-1", reply: "always" },
    ]);
  });

  it("surfaces OpenCode permission asks as approvals in approval-required mode", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-approval-required-permission"),
          runtimeMode: "approval-required",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-approval-required-permission"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-permission-asked",
          type: "permission.asked",
          properties: {
            id: "permission-1",
            sessionID: "opencode-session-1",
            permission: "bash",
            patterns: ["rm -rf *"],
            metadata: {},
            always: [],
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "request.opened",
    ]);
    expect(result[3]).toMatchObject({
      type: "request.opened",
      payload: {
        requestType: "command_execution_approval",
        detail: "rm -rf *",
      },
    });
    expect(runtime.permissionReplyCalls).toEqual([]);
  });

  it("keeps newer OpenCode tool-call steps attached to the active turn", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-next-tool-call"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-next-tool-call"),
          input: "inspect files",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-next-step-tool-calls",
          type: "session.next.step.ended",
          properties: {
            timestamp: 3,
            sessionID: "opencode-session-1",
            finish: "tool-calls",
            cost: 0.01,
            tokens: {
              input: 0,
              output: 0,
              reasoning: 0,
              cache: {
                read: 0,
                write: 0,
              },
            },
          },
        });
        eventQueue.push({
          id: "evt-next-tool-called",
          type: "session.next.tool.called",
          properties: {
            timestamp: 4,
            sessionID: "opencode-session-1",
            callID: "tool-call-1",
            tool: "read",
            input: {
              filePath: "README.md",
            },
            provider: {
              executed: true,
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.started",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.started",
      turnId: result[2]?.turnId,
      payload: {
        itemType: "dynamic_tool_call",
        status: "inProgress",
      },
    });
  });

  it("forwards OpenCode child-session tool activity created by task parts", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-child-session-tools"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-child-session-tools"),
          input: "inspect files",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "parent-task-part",
              messageID: "assistant-message-1",
              type: "tool",
              tool: "task",
              callID: "task-call-1",
              state: {
                status: "running",
                title: "Find changelog implementation",
                input: {
                  description: "Find changelog implementation",
                  prompt: "Explore changelog files.",
                },
                metadata: {
                  sessionId: "child-session-1",
                  parentSessionId: "opencode-session-1",
                },
                time: {
                  start: 1,
                },
              },
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "child-session-1",
            part: {
              id: "child-grep-part",
              messageID: "child-assistant-message-1",
              type: "tool",
              tool: "grep",
              callID: "grep-call-1",
              state: {
                status: "completed",
                input: {
                  pattern: "changelog",
                },
                output: "Found 18 matches",
                time: {
                  start: 2,
                  end: 3,
                },
              },
            },
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.updated",
      "item.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.updated",
      payload: {
        itemType: "collab_agent_tool_call",
        status: "inProgress",
        title: "Find changelog implementation",
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      turnId: result[2]?.turnId,
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        detail: "Found 18 matches",
      },
    });
  });

  it("projects newer OpenCode shell step events as command executions", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-next-shell"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-next-shell"),
          input: "inspect files",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          id: "evt-next-shell-started",
          type: "session.next.shell.started",
          properties: {
            timestamp: 4,
            sessionID: "opencode-session-1",
            callID: "shell-call-1",
            command: "cat package.json | grep next",
          },
        });
        eventQueue.push({
          id: "evt-next-shell-ended",
          type: "session.next.shell.ended",
          properties: {
            timestamp: 5,
            sessionID: "opencode-session-1",
            callID: "shell-call-1",
            output: '"next": "15.5.0"',
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "item.started",
      "item.completed",
    ]);
    expect(result[3]).toMatchObject({
      type: "item.started",
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        detail: "cat package.json | grep next",
        data: {
          command: "cat package.json | grep next",
        },
      },
    });
    expect(result[4]).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
        detail: '"next": "15.5.0"',
        data: {
          output: '"next": "15.5.0"',
        },
      },
    });
  });

  it("does not block sendTurn when the OpenCode prompt request stalls during startup", async () => {
    const runtime = createMockOpenCodeRuntime({
      promptAsync: async () => await new Promise(() => {}),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-stalled-prompt-async"),
          runtimeMode: "full-access",
        });

        const turnReturned = yield* adapter
          .sendTurn({
            threadId: asThreadId("thread-stalled-prompt-async"),
            input: "hello",
            attachments: [],
            modelSelection: {
              provider: "opencode",
              model: "opencode/claude-opus-4-7",
            },
          })
          .pipe(
            Effect.timeoutOption(50),
            Effect.map((turnOption) => turnOption._tag === "Some"),
          );

        const events = Array.from(yield* Fiber.join(eventsFiber));
        return { events, turnReturned };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            promptSubmissionInlineWaitMs: 1,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.turnReturned).toBe(true);
    expect(runtime.promptCalls).toHaveLength(1);
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
    ]);
  });

  it("keeps immediate OpenCode prompt failures on the sendTurn failure path", async () => {
    const runtime = createMockOpenCodeRuntime({
      promptAsync: async () => {
        throw new Error("prompt rejected");
      },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-rejected-prompt-async"),
          runtimeMode: "full-access",
        });

        const sendExit = yield* Effect.exit(
          adapter.sendTurn({
            threadId: asThreadId("thread-rejected-prompt-async"),
            input: "hello",
            attachments: [],
            modelSelection: {
              provider: "opencode",
              model: "opencode/claude-opus-4-7",
            },
          }),
        );

        const events = Array.from(yield* Fiber.join(eventsFiber));
        return { events, sendFailed: sendExit._tag === "Failure" };
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({
            runtime: runtime.runtime,
            promptSubmissionInlineWaitMs: 50,
          }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.sendFailed).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "turn.aborted",
    ]);
    expect(result.events[3]).toMatchObject({
      type: "turn.aborted",
      payload: {
        reason: "prompt rejected",
      },
    });
  });

  it("treats OpenCode session.idle as turn completion", async () => {
    const eventQueue = createSubscribedEventQueue();
    const runtime = createMockOpenCodeRuntime();
    const client = runtime.runtime.createOpenCodeSdkClient({
      baseUrl: "http://127.0.0.1:4099",
      directory: process.cwd(),
    }) as unknown as {
      event: {
        subscribe: () => Promise<{ stream: AsyncIterable<unknown> }>;
      };
    };
    client.event.subscribe = async () => ({ stream: eventQueue.stream });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-session-idle"),
          runtimeMode: "full-access",
        });

        yield* adapter.sendTurn({
          threadId: asThreadId("thread-session-idle"),
          input: "hello",
          attachments: [],
          modelSelection: {
            provider: "opencode",
            model: "openai/gpt-5.4",
          },
        });

        eventQueue.push({
          type: "message.updated",
          properties: {
            sessionID: "opencode-session-1",
            info: {
              id: "msg-session-idle",
              role: "assistant",
            },
          },
        });
        eventQueue.push({
          type: "message.part.updated",
          properties: {
            sessionID: "opencode-session-1",
            part: {
              id: "part-session-idle",
              messageID: "msg-session-idle",
              type: "text",
              text: "done",
              time: {
                start: 1,
                end: 2,
              },
            },
          },
        });
        eventQueue.push({
          id: "evt-session-idle",
          type: "session.idle",
          properties: {
            sessionID: "opencode-session-1",
          },
        });

        const events = Array.from(yield* Fiber.join(eventsFiber));
        eventQueue.close();
        return events;
      }).pipe(
        Effect.provide(
          makeOpenCodeAdapterLive({ runtime: runtime.runtime }).pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "opencode-adapter-test-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
    );

    expect(result.map((event) => event.type)).toEqual([
      "session.started",
      "thread.started",
      "turn.started",
      "content.delta",
      "item.completed",
      "turn.completed",
    ]);
  });
});
