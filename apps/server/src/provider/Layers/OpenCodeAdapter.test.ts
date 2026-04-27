import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { Model, OpencodeClient, Provider } from "@opencode-ai/sdk/v2";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, it, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntimeError,
  type OpenCodeInventory,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import {
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

function createMockOpenCodeRuntime(input?: { readonly inventory?: OpenCodeInventory }) {
  const abortCalls: Array<{ sessionID: string }> = [];
  const promptCalls: Array<Record<string, unknown>> = [];
  const emptySubscription = {
    async *[Symbol.asyncIterator]() {
      // No provider-side events needed for these adapter lifecycle tests.
    },
  };
  const client = {
    event: {
      subscribe: async () => ({ stream: emptySubscription }),
    },
    session: {
      create: async () => ({ data: { id: "opencode-session-1" } }),
      promptAsync: async (input: Record<string, unknown>) => {
        promptCalls.push(input);
        return { data: null };
      },
      abort: async (input: { sessionID: string }) => {
        abortCalls.push(input);
        return { data: null };
      },
      messages: async () => ({ data: [] }),
      get: async () => ({ data: { directory: process.cwd() } }),
      revert: async () => ({ data: null }),
      summarize: async () => ({ data: null }),
      fork: async () => ({ data: { id: "forked-session-1" } }),
    },
    permission: {
      reply: async () => ({ data: null }),
    },
    question: {
      reply: async () => ({ data: null }),
    },
  };

  const unexpectedOperation = (operation: string) =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation,
        detail: `Unexpected runtime operation: ${operation}`,
      }),
    );

  const runtime: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () => unexpectedOperation("startOpenCodeServerProcess"),
    connectToOpenCodeServer: () =>
      Effect.succeed({
        url: "http://127.0.0.1:4099",
        exitCode: null,
        external: true,
      }),
    runOpenCodeCommand: () => unexpectedOperation("runOpenCodeCommand"),
    createOpenCodeSdkClient: () => client as unknown as OpencodeClient,
    loadOpenCodeInventory: () =>
      Effect.succeed(
        input?.inventory ?? {
          providerList: { connected: [], all: [], default: {} },
          agents: [],
          consoleState: null,
        },
      ),
    listOpenCodeCliModels: () => Effect.succeed([]),
    loadOpenCodeCredentialProviderIDs: () => Effect.succeed([]),
  };

  return { abortCalls, promptCalls, runtime };
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
      credentialProviderIDs: ["openai"],
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5",
        name: "GPT-5",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
      {
        slug: "opencode/nemotron-3-super-free",
        name: "Nemotron 3 Super Free",
        upstreamProviderId: "opencode",
        upstreamProviderName: "OpenCode",
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
      credentialProviderIDs: ["openai"],
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
        supportedReasoningEfforts: [
          {
            value: "none",
          },
          {
            value: "low",
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
      credentialProviderIDs: ["openai"],
    });

    expect(models).toEqual([
      {
        slug: "openai/gpt-5.4",
        name: "GPT-5.4",
        upstreamProviderId: "openai",
        upstreamProviderName: "OpenAI",
      },
    ]);
  });
});

describe("OpenCodeAdapter runtime lifecycle", () => {
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
        text: expect.stringContaining("DP Code plan mode is active."),
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
              text: "<proposed_plan>\n# Not a DP Code plan\n</proposed_plan>",
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
        detail: "<proposed_plan>\n# Not a DP Code plan\n</proposed_plan>",
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
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
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
        eventQueue.push(idleStatusEvent());

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
    expect(result.events.at(-1)).toMatchObject({
      type: "turn.completed",
      payload: {
        state: "completed",
        totalCostUsd: 0.1234,
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
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
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
        eventQueue.push(idleStatusEvent());

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
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 5)).pipe(
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
        eventQueue.push(idleStatusEvent());

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
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
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
        eventQueue.push(idleStatusEvent());

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
      "turn.completed",
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
});
