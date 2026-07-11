// FILE: PiAdapter.test.ts
// Purpose: Verifies Pi adapter model discovery respects auth and SDK-supported thinking levels.
// Layer: Provider adapter tests
// Depends on: PiAdapter discovery helpers and Pi model metadata shapes.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  applyPiRuntimeApiKeysFromEnvironment,
  createPiModelRuntime,
  ensurePiAnthropicCatalogModels,
  getPiDiscoverableModels,
  findModelInRegistry,
  getPiSupportedThinkingOptions,
  buildPiAgentGatewayCustomTools,
  makePiBashProcessSupervisor,
  makePiExtensionModeCoordinator,
  makePiRuntimeEventBase,
  makePiStoragePaths,
  makePiUserInputOptions,
  PLAIN_PI_EXTENSION_THEME,
  resolvePiExtensionMode,
  resolvePiStartInstanceId,
  toPiProviderModelDescriptor,
} from "./PiAdapter";

describe("makePiStoragePaths", () => {
  it("resolves modelSelection-only account identity before Pi storage setup", () => {
    expect(
      resolvePiStartInstanceId({
        modelSelection: {
          provider: "pi",
          instanceId: "pi_work",
          model: "pi/model",
        },
      } as never),
    ).toBe("pi_work");
  });

  it("keeps legacy defaults byte-for-byte without an account boundary", () => {
    expect(
      makePiStoragePaths({
        stateDir: "/state",
        homeDir: "/home/user",
        sdkAgentDir: "/sdk/default-agent",
      }),
    ).toEqual({ agentDir: "/sdk/default-agent" });
  });

  it("uses selected Pi roots and never falls back to the global session directory", () => {
    expect(
      makePiStoragePaths({
        agentDir: "~/configured-agent",
        environment: {
          HOME: "/accounts/b",
          PI_CODING_AGENT_DIR: "/ignored/env-agent",
          PI_CODING_AGENT_SESSION_DIR: "/accounts/b/selected-sessions",
        },
        instanceId: "pi_work",
        stateDir: "/state",
        homeDir: "/home/user",
        sdkAgentDir: "/sdk/default-agent",
      }),
    ).toEqual({
      agentDir: "/accounts/b/configured-agent",
      sessionDir: "/accounts/b/selected-sessions",
    });
  });

  it("derives persistent synthetic agent and session roots for nondefault instances", () => {
    const paths = makePiStoragePaths({
      instanceId: "pi_work",
      stateDir: "/state",
      homeDir: "/home/user",
      sdkAgentDir: "/sdk/default-agent",
    });
    expect(paths.agentDir).toContain("/state/provider-homes/pi/");
    expect(paths.agentDir.endsWith("/.pi/agent")).toBe(true);
    expect(paths.sessionDir).toBe(`${paths.agentDir}/sessions`);
  });
});

describe("resolvePiExtensionMode", () => {
  it("preserves default-only extension behavior", () => {
    expect(
      resolvePiExtensionMode({
        isolatedAccount: false,
        hasExtensionEnabledDefault: false,
        hasIsolatedMode: false,
      }),
    ).toEqual({ noExtensions: false });
  });

  it("forces noExtensions for isolated accounts and coexisting default discovery", () => {
    expect(
      resolvePiExtensionMode({
        isolatedAccount: true,
        hasExtensionEnabledDefault: false,
        hasIsolatedMode: false,
      }),
    ).toEqual({ noExtensions: true });
    expect(
      resolvePiExtensionMode({
        isolatedAccount: false,
        hasExtensionEnabledDefault: false,
        hasIsolatedMode: true,
      }),
    ).toEqual({ noExtensions: true });
  });

  it("rejects isolated startup while an extension-enabled default is active", () => {
    expect(() =>
      resolvePiExtensionMode({
        isolatedAccount: true,
        hasExtensionEnabledDefault: true,
        hasIsolatedMode: false,
      }),
    ).toThrow(/Stop extension-enabled default Pi sessions/);
  });
});

describe("Pi extension mode in-flight reservations", () => {
  const coordinator = () =>
    makePiExtensionModeCoordinator(() => ({
      hasExtensionEnabledDefault: false,
      hasIsolatedMode: false,
    }));

  it("rejects concurrent isolated work after extension-enabled discovery reserves first", async () => {
    const modes = coordinator();
    let releaseDiscovery!: () => void;
    const discoveryGate = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    const defaultDiscovery = (async () => {
      const reservation = modes.reserve(false);
      try {
        await discoveryGate;
      } finally {
        reservation.release();
      }
    })();
    await Promise.resolve();
    const [isolatedStart] = await Promise.allSettled([
      Promise.resolve().then(() => modes.reserve(true)),
    ]);
    expect(isolatedStart?.status).toBe("rejected");
    releaseDiscovery();
    await defaultDiscovery;
    expect(modes.reserve(true).noExtensions).toBe(true);
  });

  it("forces concurrent default work into noExtensions after isolated start reserves first", async () => {
    const modes = coordinator();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const isolatedStart = (async () => {
      const reservation = modes.reserve(true);
      try {
        await startGate;
      } finally {
        reservation.release();
      }
    })();
    await Promise.resolve();
    const defaultDiscovery = await Promise.resolve().then(() => modes.reserve(false));
    expect(defaultDiscovery.noExtensions).toBe(true);
    defaultDiscovery.release();
    releaseStart();
    await isolatedStart;
    expect(modes.reserve(false).noExtensions).toBe(false);
  });
});

describe("Pi native Synara gateway tools", () => {
  it("uses canonical MCP schemas and keeps same-cwd thread tokens distinct", async () => {
    const requests: Array<{ readonly token: string | null; readonly body: any }> = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({
        token: new Headers(init?.headers).get("Authorization"),
        body,
      });
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "synara_list_threads",
                    description: "List Synara threads.",
                    inputSchema: {
                      type: "object",
                      properties: { limit: { type: "number" } },
                    },
                  },
                ],
              }
            : {
                content: [{ type: "text", text: body.params.arguments.owner }],
              },
      });
    };
    const defineTool = (tool: any) => tool;
    const firstConnection = {
      url: "http://127.0.0.1:3773/mcp",
      bearerToken: "token-a",
    };
    const first = await buildPiAgentGatewayCustomTools({
      connection: firstConnection,
      defineTool,
      fetch,
    });
    const second = await buildPiAgentGatewayCustomTools({
      connection: { url: "http://127.0.0.1:3773/mcp", bearerToken: "token-b" },
      defineTool,
      fetch,
    });

    expect(first[0]?.parameters).toEqual({
      type: "object",
      properties: { limit: { type: "number" } },
    });
    await expect(
      first[0]?.execute("call-a", { owner: "thread-a" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "thread-a" }] });
    await expect(
      second[0]?.execute("call-b", { owner: "thread-b" }, undefined, undefined, {} as never),
    ).resolves.toMatchObject({ content: [{ type: "text", text: "thread-b" }] });
    expect(requests.map((request) => request.token)).toEqual([
      "Bearer token-a",
      "Bearer token-b",
      "Bearer token-a",
      "Bearer token-b",
    ]);
    expect(requests[2]?.body.params.arguments).toEqual({ owner: "thread-a" });
    expect(requests[3]?.body.params.arguments).toEqual({ owner: "thread-b" });
    Object.assign(firstConnection, { bearerToken: "token-c" });
    await first[0]?.execute("call-c", {}, undefined, undefined, {} as never);
    expect(requests[4]?.token).toBe("Bearer token-c");
  });

  it("forwards Pi tool cancellation to the in-flight MCP request", async () => {
    let callSignal: AbortSignal | null = null;
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "synara_create_threads",
                description: "Create Synara threads.",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        });
      }

      callSignal = init?.signal ?? null;
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAborted = () =>
          reject(
            callSignal?.reason ?? new DOMException("The operation was aborted.", "AbortError"),
          );
        if (callSignal?.aborted) {
          rejectAborted();
          return;
        }
        callSignal?.addEventListener("abort", rejectAborted, { once: true });
      });
    };
    const tools = await buildPiAgentGatewayCustomTools({
      connection: { url: "http://127.0.0.1:3773/mcp", bearerToken: "token-a" },
      defineTool: (tool) => tool,
      fetch,
    });
    const controller = new AbortController();
    const execution = tools[0]?.execute("call-a", {}, controller.signal, undefined, {} as never);

    controller.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    expect(callSignal).toBe(controller.signal);
    expect(controller.signal.aborted).toBe(true);
  });
});

describe("Pi Bash process supervision", () => {
  it("keeps an aborted command pending until process-tree exit is proven", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 64_201,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as ChildProcess;
    let proveExit!: () => void;
    const exitProof = new Promise<void>((resolve) => {
      proveExit = resolve;
    });
    let observeTeardown!: () => void;
    const teardownStarted = new Promise<void>((resolve) => {
      observeTeardown = resolve;
    });
    const supervisor = makePiBashProcessSupervisor({
      getShellConfig: () => ({ shell: "/bin/sh", args: ["-c"] }),
      spawnProcess: () => child,
      teardownProcessTree: async (input) => {
        observeTeardown();
        await exitProof;
        (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
        child.emit("exit", 0, null);
        await input.rootExited;
        return { escalated: false, signalErrors: [] };
      },
    });
    const abortController = new AbortController();
    const command = supervisor.operations.exec("sleep 10", "/tmp", {
      signal: abortController.signal,
      onData: () => undefined,
    });
    let settled = false;
    void command.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    abortController.abort();
    await teardownStarted;
    await Promise.resolve();
    expect(settled).toBe(false);

    proveExit();
    await expect(command).rejects.toThrow("aborted");
    expect(settled).toBe(true);
  });
});

function makePiModel(input: {
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}): Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> {
  return {
    reasoning: input.reasoning,
    ...(input.thinkingLevelMap !== undefined ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
  };
}

describe("getPiDiscoverableModels", () => {
  it("normalizes the malformed Pi extension model metadata before returning it through RPC", () => {
    const descriptor = toPiProviderModelDescriptor(
      {
        provider: "openrouter",
        id: "google/gemma-4-26b-a4b-it",
        name: "Google: Gemma 4 26B A4B ",
        reasoning: false,
      } as Model<Api>,
      () => " OpenRouter ",
    );

    expect(descriptor).toMatchObject({
      slug: "openrouter/google/gemma-4-26b-a4b-it",
      name: "Google: Gemma 4 26B A4B",
      upstreamProviderId: "openrouter",
      upstreamProviderName: "OpenRouter",
    });
  });

  it("omits models whose normalized identity would no longer resolve in the registry", () => {
    expect(
      toPiProviderModelDescriptor(
        {
          provider: " openrouter",
          id: "google/gemma-4-26b-a4b-it",
          name: "Google: Gemma 4 26B A4B",
          reasoning: false,
        } as Model<Api>,
        () => "OpenRouter",
      ),
    ).toBeNull();
    expect(
      toPiProviderModelDescriptor(
        {
          provider: "openrouter",
          id: " google/gemma-4-26b-a4b-it",
          name: "Google: Gemma 4 26B A4B",
          reasoning: false,
        } as Model<Api>,
        () => "OpenRouter",
      ),
    ).toBeNull();
  });

  it("isolates extension providers between sessions that share an agent directory", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-runtime-isolation-"));

    try {
      const firstRuntime = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        AbortSignal.abort(),
        { OPENAI_API_KEY: "instance-openai-key" },
      );
      const secondRuntime = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        AbortSignal.abort(),
      );
      const firstRegistry = new ModelRegistry(firstRuntime);
      const secondRegistry = new ModelRegistry(secondRuntime);

      expect(firstRuntime.hasConfiguredAuth("openai")).toBe(true);
      expect(secondRuntime.hasConfiguredAuth("openai")).toBe(false);

      firstRegistry.registerProvider("project-local", {
        baseUrl: "http://127.0.0.1:11434/v1",
        api: "openai-completions",
        apiKey: "test-key",
        models: [
          {
            id: "project-model",
            name: "Project Model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 16_384,
          },
        ],
      });

      expect(firstRegistry.find("project-local", "project-model")).toBeDefined();
      expect(secondRegistry.find("project-local", "project-model")).toBeUndefined();
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("blocks ambient API-key fallback for an isolated Pi instance", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-account-isolation-"));
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "ambient-account-key";

    try {
      const isolatedRuntime = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        undefined,
        {},
        "pi_work",
      );
      const defaultRuntime = await createPiModelRuntime(agentDir, { ModelRuntime });

      expect(isolatedRuntime.hasConfiguredAuth("openai")).toBe(false);
      await expect(isolatedRuntime.getAuth("openai")).resolves.toBeUndefined();
      expect(defaultRuntime.hasConfiguredAuth("openai")).toBe(true);
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("resolves custom provider config only from the selected Pi environment", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-custom-config-isolation-"));
    const previousCustomKey = process.env.CUSTOM_KEY;
    const previousCustomHeader = process.env.CUSTOM_HEADER;
    process.env.CUSTOM_KEY = "ambient-account-key";
    process.env.CUSTOM_HEADER = "ambient-account-header";
    const commandConfig = `!${JSON.stringify(process.execPath)} -p ${JSON.stringify(
      "process.env.CUSTOM_KEY",
    )}`;

    try {
      writeFileSync(
        path.join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            custom: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: "$CUSTOM_KEY",
              headers: { "X-Custom": "$CUSTOM_HEADER" },
              models: [{ id: "custom-model" }],
            },
            "custom-command": {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: commandConfig,
              models: [{ id: "command-model" }],
            },
          },
        }),
      );
      const selected = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        undefined,
        { CUSTOM_KEY: "selected-account-key", CUSTOM_HEADER: "selected-account-header" },
        "pi_work",
      );
      const empty = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        undefined,
        {},
        "pi_empty",
      );
      const customModel = selected.getModel("custom", "custom-model");
      if (!customModel) throw new Error("Expected custom Pi model.");

      await expect(selected.getAuth(customModel)).resolves.toMatchObject({
        auth: {
          apiKey: "selected-account-key",
          headers: { "X-Custom": "selected-account-header" },
        },
      });
      await expect(selected.getAuth("custom-command")).resolves.toMatchObject({
        auth: { apiKey: "selected-account-key" },
      });
      expect(empty.hasConfiguredAuth("custom")).toBe(false);
      expect(empty.hasConfiguredAuth("custom-command")).toBe(false);
    } finally {
      if (previousCustomKey === undefined) delete process.env.CUSTOM_KEY;
      else process.env.CUSTOM_KEY = previousCustomKey;
      if (previousCustomHeader === undefined) delete process.env.CUSTOM_HEADER;
      else process.env.CUSTOM_HEADER = previousCustomHeader;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps identical config commands scoped to each immutable Pi environment", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-command-isolation-"));
    const commandConfig = `!${JSON.stringify(process.execPath)} -p ${JSON.stringify(
      "process.env.CUSTOM_KEY",
    )}`;

    try {
      writeFileSync(
        path.join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            custom: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              apiKey: commandConfig,
              models: [{ id: "command-model" }],
            },
          },
        }),
      );
      const accountAEnvironment = { CUSTOM_KEY: "selected-account-a" };
      const accountA = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        undefined,
        accountAEnvironment,
        "pi_account_a",
      );
      accountAEnvironment.CUSTOM_KEY = "mutated-after-snapshot";
      const accountB = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        undefined,
        { CUSTOM_KEY: "selected-account-b" },
        "pi_account_b",
      );

      await expect(
        Promise.all([accountA.getAuth("custom"), accountB.getAuth("custom")]),
      ).resolves.toMatchObject([
        { auth: { apiKey: "selected-account-a" } },
        { auth: { apiKey: "selected-account-b" } },
      ]);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["amazon-bedrock", "stored-bedrock", "Amazon Bedrock"],
    ["azure-openai-responses", "stored-azure", "Azure OpenAI"],
    ["google-vertex", "gcp-vertex-credentials", "Vertex ADC"],
  ])("fails closed for isolated %s ambient-chain auth", async (provider, key, message) => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-routing-isolation-"));
    try {
      writeFileSync(
        path.join(agentDir, "auth.json"),
        JSON.stringify({ [provider]: { type: "api_key", key } }),
      );
      const runtime = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        undefined,
        {},
        "pi_work",
      );

      await expect(runtime.getAuth(provider)).rejects.toThrow(message);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("resolves Cloudflare routing only from the selected instance", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-cloudflare-isolation-"));
    try {
      const runtime = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        undefined,
        {
          CLOUDFLARE_ACCOUNT_ID: "account-b",
          CLOUDFLARE_GATEWAY_ID: "gateway-b",
          CLOUDFLARE_API_KEY: "key-b",
        },
        "pi_work",
      );

      await expect(runtime.getAuth("cloudflare-ai-gateway")).resolves.toMatchObject({
        env: {
          CLOUDFLARE_ACCOUNT_ID: "account-b",
          CLOUDFLARE_GATEWAY_ID: "gateway-b",
        },
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("suppresses ambient OpenAI and Anthropic routing credentials", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-header-isolation-"));
    const previousOpenAiOrg = process.env.OPENAI_ORG_ID;
    const previousAnthropicToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.OPENAI_ORG_ID = "ambient-org";
    process.env.ANTHROPIC_AUTH_TOKEN = "ambient-token";
    try {
      const runtime = await createPiModelRuntime(
        agentDir,
        { ModelRuntime },
        undefined,
        { OPENAI_API_KEY: "selected-openai", ANTHROPIC_API_KEY: "selected-anthropic" },
        "pi_work",
      );

      await expect(runtime.getAuth("openai")).resolves.not.toMatchObject({
        auth: { headers: expect.objectContaining({ "OpenAI-Organization": "ambient-org" }) },
      });
      await expect(runtime.getAuth("anthropic")).resolves.not.toMatchObject({
        auth: { headers: expect.objectContaining({ Authorization: "Bearer ambient-token" }) },
      });
    } finally {
      if (previousOpenAiOrg === undefined) delete process.env.OPENAI_ORG_ID;
      else process.env.OPENAI_ORG_ID = previousOpenAiOrg;
      if (previousAnthropicToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = previousAnthropicToken;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it.each([
    { provider: "zai", id: "glm-5.3-flash", auth: { type: "api_key", key: "test-key" } },
    {
      provider: "openai-codex",
      id: "gpt-6-astra",
      auth: { type: "oauth", access: "tok", refresh: "ref", expires: 4_102_444_800_000 },
    },
  ])(
    "discovers bundled $provider/$id with configured credentials",
    async ({ provider, id, auth }) => {
      const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-bundled-models-"));
      try {
        const authPath = path.join(agentDir, "auth.json");
        writeFileSync(authPath, JSON.stringify({ [provider]: auth }));
        const runtime = await ModelRuntime.create({
          authPath,
          modelsPath: path.join(agentDir, "models.json"),
          allowModelNetwork: false,
        });
        const registry = new ModelRegistry(runtime);
        const model = getPiDiscoverableModels(registry).find(
          (candidate) => candidate.provider === provider && candidate.id === id,
        );

        expect(model).toBeDefined();
        if (!model) throw new Error(`Missing bundled model: ${provider}/${id}`);
        expect(findModelInRegistry(registry, `${provider}/${id}`)).toEqual(model);
        expect(toPiProviderModelDescriptor(model, (name) => name)).toMatchObject({
          slug: `${provider}/${id}`,
          upstreamProviderId: provider,
          supportedReasoningEfforts: expect.arrayContaining([
            {
              value: "high",
              label: expect.any(String),
              description: expect.any(String),
            },
          ]),
        });
      } finally {
        rmSync(agentDir, { recursive: true, force: true });
      }
    },
  );

  it("includes custom-provider models authenticated through auth.json semantics", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-models-"));
    const modelsPath = path.join(agentDir, "models.json");
    const authPath = path.join(agentDir, "auth.json");

    try {
      writeFileSync(
        modelsPath,
        JSON.stringify({
          providers: {
            local: {
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:11434/v1",
              models: [{ id: "glm-5.2" }],
            },
          },
        }),
      );
      writeFileSync(
        authPath,
        JSON.stringify({
          local: { type: "api_key", key: "test-key" },
        }),
      );
      const modelRuntime = await ModelRuntime.create({
        authPath,
        modelsPath,
        allowModelNetwork: false,
      });
      const registry = new ModelRegistry(modelRuntime);

      const models = getPiDiscoverableModels(registry);

      expect(models.some((model) => model.provider === "local" && model.id === "glm-5.2")).toBe(
        true,
      );
      expect(models.some((model) => model.provider === "anthropic")).toBe(false);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("restores Fable 5 and Opus 4.8 after an extension replaces the Anthropic catalog", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "synara-pi-anthropic-"));
    const modelsPath = path.join(agentDir, "models.json");
    const authPath = path.join(agentDir, "auth.json");

    try {
      writeFileSync(modelsPath, "{}");
      writeFileSync(
        authPath,
        JSON.stringify({
          anthropic: {
            type: "oauth",
            access: "tok",
            refresh: "ref",
            expires: Date.now() + 60_000,
          },
        }),
      );
      const modelRuntime = await ModelRuntime.create({
        authPath,
        modelsPath,
        allowModelNetwork: false,
      });
      const registry = new ModelRegistry(modelRuntime);
      registry.registerProvider("anthropic", {
        baseUrl: "https://api.anthropic.com",
        api: "anthropic-messages",
        apiKey: "test-key",
        models: [
          {
            id: "claude-opus-4-7",
            name: "Claude Opus 4.7",
            api: "anthropic-messages",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
            contextWindow: 1_000_000,
            maxTokens: 128_000,
          },
        ],
      });

      expect(
        registry
          .getAll()
          .filter((model) => model.provider === "anthropic")
          .map((model) => model.id),
      ).toEqual(["claude-opus-4-7"]);
      const models = getPiDiscoverableModels(registry);

      expect(
        models.some((model) => model.provider === "anthropic" && model.id === "claude-fable-5"),
      ).toBe(true);
      expect(
        models.some((model) => model.provider === "anthropic" && model.id === "claude-opus-4-8"),
      ).toBe(true);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe("ensurePiAnthropicCatalogModels", () => {
  it("does not invent Anthropic models when Anthropic is unauthenticated", () => {
    const models = ensurePiAnthropicCatalogModels([
      {
        id: "glm-5.2",
        name: "GLM 5.2",
        api: "openai-completions",
        provider: "local",
        baseUrl: "http://127.0.0.1:11434/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ]);

    expect(models.every((model) => model.provider !== "anthropic")).toBe(true);
  });

  it("restores Fable 5.1, Fable 5, and Opus 4.8 when an oauth catalog omitted them", () => {
    const peer = {
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      api: "anthropic-messages" as const,
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"] as Array<"text" | "image">,
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    };
    const models = ensurePiAnthropicCatalogModels([peer], [peer]);

    expect(models.map((model) => model.id)).toEqual([
      "claude-opus-4-7",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-4-8",
    ]);
    expect(models.find((model) => model.id === "claude-fable-5-1")).toMatchObject({
      provider: "anthropic",
      name: "Claude Fable 5.1",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(models.find((model) => model.id === "claude-fable-5")).toMatchObject({
      provider: "anthropic",
      name: "Claude Fable 5",
      reasoning: true,
    });
    expect(models.find((model) => model.id === "claude-opus-4-8")).toMatchObject({
      provider: "anthropic",
      name: "Claude Opus 4.8",
      reasoning: true,
    });
  });
});

describe("getPiSupportedThinkingOptions", () => {
  it("hides thinking controls for non-reasoning models", () => {
    expect(getPiSupportedThinkingOptions(makePiModel({ reasoning: false }))).toEqual([]);
  });

  it("advertises xhigh and max only when the concrete Pi model supports them", () => {
    const withoutExtended = getPiSupportedThinkingOptions(makePiModel({ reasoning: true }));
    const withXHigh = getPiSupportedThinkingOptions(
      makePiModel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }),
    );
    const withMax = getPiSupportedThinkingOptions(
      makePiModel({ reasoning: true, thinkingLevelMap: { max: "max" } }),
    );

    expect(withoutExtended.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(withXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(withMax.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("respects provider-level disabled thinking levels", () => {
    const options = getPiSupportedThinkingOptions(
      makePiModel({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
        },
      }),
    );

    expect(options.map((option) => option.value)).toEqual(["minimal", "low", "medium", "high"]);
  });

  it("preserves kimi-k3 style ladders that expose low, high, and max", () => {
    const options = getPiSupportedThinkingOptions(
      makePiModel({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: null,
          low: "low",
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
      }),
    );

    expect(options.map((option) => option.value)).toEqual(["low", "high", "max"]);
  });
});

describe("applyPiRuntimeApiKeysFromEnvironment", () => {
  it("maps Pi provider-instance API keys into runtime auth without mutating process.env", async () => {
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "global-openai-key";
    const runtimeKeys = new Map<string, string>();

    try {
      await applyPiRuntimeApiKeysFromEnvironment(
        {
          async setRuntimeApiKey(provider, apiKey) {
            runtimeKeys.set(provider, apiKey);
          },
        },
        {
          OPENAI_API_KEY: "instance-openai-key",
          ANTHROPIC_API_KEY: "anthropic-api-key",
          ANTHROPIC_OAUTH_TOKEN: "anthropic-oauth-token",
          OPENCODE_API_KEY: "opencode-key",
        },
      );
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }

    expect(runtimeKeys.get("openai")).toBe("instance-openai-key");
    expect(runtimeKeys.get("anthropic")).toBe("anthropic-oauth-token");
    expect(runtimeKeys.get("opencode")).toBe("opencode-key");
    expect(runtimeKeys.get("opencode-go")).toBe("opencode-key");
    expect(process.env.OPENAI_API_KEY).toBe(previousOpenAiKey);
  });
});

describe("Pi extension UI helpers", () => {
  it("stamps events from the lifecycle generation captured by the session context", () => {
    const eventBase = makePiRuntimeEventBase({
      lifecycleGeneration: "generation-pi-7",
      session: { threadId: "thread-pi" as never },
      activeTurnId: "turn-pi" as never,
    });

    expect(eventBase).toMatchObject({
      provider: "pi",
      threadId: "thread-pi",
      turnId: "turn-pi",
      lifecycleGeneration: "generation-pi-7",
    });
  });

  it("keeps original select values while showing normalized unique labels", () => {
    const mappings = makePiUserInputOptions(["  OpenRouter  ", "", "OpenRouter"]);

    expect(mappings.map((mapping) => mapping.value)).toEqual(["  OpenRouter  ", "", "OpenRouter"]);
    expect(mappings.map((mapping) => mapping.option.label)).toEqual([
      "OpenRouter",
      "Option 2",
      "OpenRouter (2)",
    ]);
  });

  it("provides a no-color theme object for UI-gated extensions", () => {
    expect(PLAIN_PI_EXTENSION_THEME.fg("accent", "ready")).toBe("ready");
    expect(PLAIN_PI_EXTENSION_THEME.bold("done")).toBe("done");
    expect(PLAIN_PI_EXTENSION_THEME.getThinkingBorderColor("medium")("thinking")).toBe("thinking");
  });
});
