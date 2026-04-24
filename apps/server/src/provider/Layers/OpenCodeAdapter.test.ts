import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, it, expect } from "vitest";

import { ServerConfig } from "../../config.ts";
import { OpenCodeRuntimeError, type OpenCodeRuntimeShape } from "../opencodeRuntime.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import {
  flattenOpenCodeModels,
  makeOpenCodeAdapterLive,
  resolvePreferredOpenCodeModelProviders,
} from "./OpenCodeAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function makeProvider(input: {
  id: string;
  name: string;
  source?: string;
  env?: ReadonlyArray<string>;
  models?: Record<
    string,
    {
      readonly id: string;
      readonly name: string;
      readonly options?: Record<string, unknown>;
      readonly capabilities?: {
        readonly reasoning?: boolean;
      };
      readonly variants?: Record<string, Record<string, unknown>>;
    }
  >;
}) {
  return {
    id: input.id,
    name: input.name,
    ...(input.source ? { source: input.source } : {}),
    ...(input.env ? { env: input.env } : {}),
    models: input.models ?? {},
  };
}

function createMockOpenCodeRuntime() {
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
      Effect.succeed({
        providerList: { connected: [], all: [], default: {} },
        agents: [],
        consoleState: null,
      }),
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
});
