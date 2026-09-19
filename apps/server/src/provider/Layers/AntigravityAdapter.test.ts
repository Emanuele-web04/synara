import { spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { ServerConfig } from "../../config";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials";
import { AntigravityAdapter } from "../Services/AntigravityAdapter";
import {
  antigravityPromptCommandLineIssue,
  type AntigravityAdapterDependencies,
  buildAntigravityCaptureCommand,
  buildAntigravityHookConfig,
  buildAntigravityTurnProcessEnvironment,
  buildAntigravityTurnPrompt,
  detectAntigravityBackgroundTaskStart,
  ensureCapturePlugin,
  hookScriptSource,
  makeAntigravityRuntimeEventBase,
  makeAntigravityAdapterLive,
  matchAntigravityTrackedTaskId,
  normalizeAntigravityCommandLine,
  parseAntigravityBackgroundTaskStep,
  takeAntigravityBackgroundCallKey,
  parseAntigravityCliModelLabel,
  parseAntigravityModelLines,
  parseAntigravitySystemMessage,
  readCompleteAntigravityLines,
  resolveAntigravityCliModelLabel,
  runAntigravityHelperProcess,
} from "./AntigravityAdapter";

function runCaptureCommand(command: string, input: string, env: NodeJS.ProcessEnv) {
  const shell = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
  return spawnSync(shell, args, {
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    timeout: 5_000,
    ...(process.platform === "win32" ? { windowsVerbatimArguments: true } : {}),
  });
}

async function completeProcessTeardown() {
  return { escalated: false, signalErrors: [] };
}

describe("Antigravity CLI model translation", () => {
  it("collapses CLI model/effort labels into base models with effort ladders", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 3.5 Flash (Medium)
Gemini 3.5 Flash (High)
Gemini 3.5 Flash (Low)
Gemini 3.1 Pro (Low)
Gemini 3.1 Pro (High)
Claude Sonnet 4.6 (Thinking)
Claude Opus 4.6 (Thinking)
GPT-OSS 120B (Medium)
`),
    ).toEqual([
      {
        slug: "Gemini 3.5 Flash",
        name: "Gemini 3.5 Flash",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "medium",
      },
      {
        slug: "Gemini 3.1 Pro",
        name: "Gemini 3.1 Pro",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        slug: "Claude Sonnet 4.6",
        name: "Claude Sonnet 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
      {
        slug: "Claude Opus 4.6",
        name: "Claude Opus 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
      {
        slug: "GPT-OSS 120B",
        name: "GPT-OSS 120B",
        supportedReasoningEfforts: [{ value: "medium", label: "Medium" }],
        defaultReasoningEffort: "medium",
      },
    ]);
  });

  it("collapses tab-separated slug/label rows from newer agy models output", () => {
    expect(
      parseAntigravityModelLines(`
gemini-3.6-flash-high\tGemini 3.6 Flash (High)
gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
gemini-3.6-flash-low\tGemini 3.6 Flash (Low)
gemini-3.1-pro-high\tGemini 3.1 Pro (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
`),
    ).toEqual([
      {
        slug: "Gemini 3.6 Flash",
        name: "Gemini 3.6 Flash",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "medium",
      },
      {
        slug: "Gemini 3.1 Pro",
        name: "Gemini 3.1 Pro",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "high", label: "High" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        slug: "Claude Sonnet 4.6",
        name: "Claude Sonnet 4.6",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
    ]);
  });

  it("rebuilds the exact CLI model label only at dispatch", () => {
    expect(parseAntigravityCliModelLabel("Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("gemini-3.6-flash-high\tGemini 3.6 Flash (High)")).toEqual(
      {
        model: "Gemini 3.6 Flash",
        effort: "high",
      },
    );
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash")).toBe("Gemini 3.5 Flash (Medium)");
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash", { reasoningEffort: "high" })).toBe(
      "Gemini 3.5 Flash (High)",
    );
    expect(resolveAntigravityCliModelLabel("Gemini 3.5 Flash (Low)")).toBe(
      "Gemini 3.5 Flash (Low)",
    );
    expect(resolveAntigravityCliModelLabel("gemini-3.6-flash-high\tGemini 3.6 Flash (High)")).toBe(
      "Gemini 3.6 Flash (High)",
    );
  });

  it("accepts bullet-prefixed model output", () => {
    expect(parseAntigravityCliModelLabel("* Gemini 3.5 Flash (High)")).toEqual({
      model: "Gemini 3.5 Flash",
      effort: "high",
    });
    expect(parseAntigravityCliModelLabel("• Claude Sonnet 4.6 (Thinking)")).toEqual({
      model: "Claude Sonnet 4.6",
      effort: "thinking",
    });
  });

  it("discovers future CLI models without requiring a static catalog update", () => {
    expect(
      parseAntigravityModelLines(`
Gemini 4 Pro (Low)
Gemini 4 Pro (Ultra)
Claude Sonnet 5 (Thinking)
`),
    ).toEqual([
      {
        slug: "Gemini 4 Pro",
        name: "Gemini 4 Pro",
        supportedReasoningEfforts: [
          { value: "low", label: "Low" },
          { value: "ultra", label: "Ultra" },
        ],
        defaultReasoningEffort: "low",
      },
      {
        slug: "Claude Sonnet 5",
        name: "Claude Sonnet 5",
        supportedReasoningEfforts: [{ value: "thinking", label: "Thinking" }],
        defaultReasoningEffort: "thinking",
      },
    ]);
  });

  it("dispatches a discovered model with its discovered default effort", () => {
    expect(resolveAntigravityCliModelLabel("Gemini 4 Pro", undefined, "low")).toBe(
      "Gemini 4 Pro (Low)",
    );
  });
});

describe("Antigravity CLI integration helpers", () => {
  it("rotates the gateway lease per print turn and rejects a retained prior bootstrap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-turn-lease-"));
    const liveTokens = new Set<string>();
    const bootstrapOwners = new Map<string, string>();
    const revokedTokens: string[] = [];
    const spawnedEnvironments: NodeJS.ProcessEnv[] = [];
    let tokenSequence = 0;
    let bootstrapSequence = 0;
    const issueSessionToken = () => {
      const token = `turn-session-${String(++tokenSequence)}`;
      liveTokens.add(token);
      return token;
    };
    const credentials: AgentGatewayCredentialsShape = {
      mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
      setListeningPort: () => undefined,
      issueSessionToken: () => issueSessionToken(),
      verifySessionToken: (token) => (liveTokens.has(token) ? "thread-antigravity" : null),
      verifySession: () => null,
      issueStdioBootstrapToken: (sessionToken) => {
        if (!liveTokens.has(sessionToken)) return null;
        const bootstrap = `turn-bootstrap-${String(++bootstrapSequence)}`;
        bootstrapOwners.set(bootstrap, sessionToken);
        return bootstrap;
      },
      exchangeStdioBootstrapToken: (bootstrap) => {
        const owner = bootstrapOwners.get(bootstrap);
        bootstrapOwners.delete(bootstrap);
        return owner && liveTokens.has(owner) ? owner : null;
      },
      bindWriteAuthority: () => null,
      verifyWriteAuthority: () => false,
      registerInFlightRequest: () => () => undefined,
      cancelInFlightRequests: () => ({ count: 0, settled: Promise.resolve() }),
      cancelSessionTurnRequests: () => Promise.resolve(),
      retireSessionTurn: () => Promise.resolve(),
      revokeSessionToken: (token) => {
        liveTokens.delete(token);
        revokedTokens.push(token);
        for (const [bootstrap, owner] of bootstrapOwners) {
          if (owner === token) bootstrapOwners.delete(bootstrap);
        }
      },
      connectionForThread: () => ({
        url: "http://127.0.0.1:3773/mcp",
        bearerToken: issueSessionToken(),
      }),
      stdioProxy: { command: process.execPath, args: ["proxy.mjs"] },
    };
    let processSequence = 0;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      spawnedEnvironments.push(options.env ?? {});
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        pid: 10_000 + ++processSequence,
        stdout,
        stderr,
        killed: false,
        kill: () => true,
      });
      setTimeout(() => {
        stdout.end("done\n");
        stderr.end();
        child.emit("close", 0, null);
      }, 50).unref();
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const threadId = ThreadId.makeUnsafe("thread-antigravity-turn-lease");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const waitUntilReady = Effect.gen(function* () {
            for (let attempt = 0; attempt < 100; attempt += 1) {
              const session = (yield* adapter.listSessions()).find(
                (candidate) => candidate.threadId === threadId,
              );
              if (session?.status === "ready") return;
              yield* Effect.sleep(10);
            }
            throw new Error("Antigravity test turn did not settle.");
          });

          yield* adapter.sendTurn({ threadId, input: "turn A", attachments: [] });
          const bootstrapA = spawnedEnvironments[0]?.SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN;
          expect(bootstrapA).toBe("turn-bootstrap-1");
          yield* waitUntilReady;
          expect(revokedTokens).toEqual(["turn-session-1"]);

          yield* adapter.sendTurn({ threadId, input: "turn B", attachments: [] });
          const bootstrapB = spawnedEnvironments[1]?.SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN;
          expect(bootstrapB).toBe("turn-bootstrap-2");
          expect(credentials.exchangeStdioBootstrapToken(bootstrapA!)).toBeNull();
          expect(credentials.exchangeStdioBootstrapToken(bootstrapB!)).toBe("turn-session-2");
          yield* waitUntilReady;
          expect(revokedTokens).toEqual(["turn-session-1", "turn-session-2"]);
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provide(Layer.succeed(AgentGatewayCredentials, credentials)),
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-turn-lease-test-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("installs the generated Synara MCP plugin alongside the capture hooks", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-home-test-"));
    const stdioProxy = {
      command: "/Applications/Synara.app/Contents/MacOS/Synara",
      args: ["/state/agent-gateway-mcp-proxy.mjs"],
    };
    const invocations: Array<{
      readonly command: string;
      readonly args: string[];
      readonly options: { cwd?: string; timeoutMs?: number };
    }> = [];
    try {
      await ensureCapturePlugin("/usr/local/bin/agy", stdioProxy, {
        homeDir,
        runHelper: async (command, args, options) => {
          if (options === undefined) {
            throw new Error("Expected plugin installation options.");
          }
          invocations.push({ command, args, options });
          return { stdout: "installed", stderr: "", code: 0 };
        },
      });

      const pluginDir = path.join(
        homeDir,
        ".gemini",
        "antigravity-cli",
        "plugins",
        "synara-capture",
      );
      expect(invocations).toEqual([
        {
          command: "/usr/local/bin/agy",
          args: ["plugin", "install", pluginDir],
          options: { timeoutMs: 45_000 },
        },
      ]);
      expect(
        JSON.parse(await fs.readFile(path.join(pluginDir, "mcp_config.json"), "utf8")),
      ).toEqual({
        mcpServers: {
          synara: {
            command: stdioProxy.command,
            args: stdioProxy.args,
            env: {
              SYNARA_AGENT_GATEWAY_URL: "$SYNARA_AGENT_GATEWAY_URL",
              SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "$SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN",
              ELECTRON_RUN_AS_NODE: "1",
            },
            disabled: false,
            disabledTools: [],
          },
        },
      });
      await expect(fs.readFile(path.join(pluginDir, "hooks.json"), "utf8")).resolves.toContain(
        "PreToolUse",
      );
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("gives an Antigravity turn only its thread-scoped gateway credential", () => {
    const env = buildAntigravityTurnProcessEnvironment({
      eventFile: "/tmp/thread-a-hooks.ndjson",
      gatewayConnection: {
        url: "http://127.0.0.1:3773/mcp",
      },
      gatewayBootstrapToken: "thread-a-bootstrap",
      baseEnv: {
        PATH: "/usr/bin",
        HOME: "/home/test",
        GEMINI_API_KEY: "gemini-key",
        SYNARA_AGENT_GATEWAY_URL: "http://127.0.0.1:9999/stale",
        SYNARA_AGENT_GATEWAY_TOKEN: "stale-token",
        SYNARA_AUTH_TOKEN: "host-control-plane-token",
        SYNARA_BROWSER_HOST_PIPE_PATH: "/tmp/desktop.sock",
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/legacy.sock",
        SYNARA_BROWSER_HOST_CAPABILITY: "desktop-capability",
        SYNARA_BROWSER_HOST_CAPABILITY_FD: "3",
        NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: "/tmp/desktop.sock",
      },
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      GEMINI_API_KEY: "gemini-key",
      SYNARA_AGENT_GATEWAY_URL: "http://127.0.0.1:3773/mcp",
      SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "thread-a-bootstrap",
      SYNARA_ANTIGRAVITY_EVENTS: "/tmp/thread-a-hooks.ndjson",
      SYNARA_ANTIGRAVITY_HOOK_DECISION: "allow",
    });
  });

  it("advertises canonical browser tools only while the session owns a gateway lease", () => {
    const withLease = {};
    const autonomousPrompt = buildAntigravityTurnPrompt(withLease, {
      prompt: "Ouvre YouTube dans le navigateur intégré.",
      hasGatewaySessionLease: true,
    });
    expect(autonomousPrompt).toContain("use browser_* autonomously");
    expect(autonomousPrompt).toContain("Detailed rules live in each tool description");
    expect(autonomousPrompt).toContain("Ouvre YouTube dans le navigateur intégré.");
    expect(
      buildAntigravityTurnPrompt(withLease, {
        prompt: "Continue.",
        hasGatewaySessionLease: true,
      }),
    ).toBe("Continue.");

    const withoutLease = {};
    const identityOnlyPrompt = buildAntigravityTurnPrompt(withoutLease, {
      prompt: "Ouvre YouTube dans le navigateur intégré.",
      hasGatewaySessionLease: false,
    });
    expect(identityOnlyPrompt).not.toContain("browser_*");
    expect(identityOnlyPrompt).toContain("Synara MCP control is unavailable");

    const envWithoutLease = buildAntigravityTurnProcessEnvironment({
      eventFile: "/tmp/thread-b-hooks.ndjson",
      baseEnv: {
        SYNARA_AGENT_GATEWAY_URL: "http://127.0.0.1:9999/stale",
        SYNARA_AGENT_GATEWAY_TOKEN: "stale-token",
        SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "stale-bootstrap",
      },
    });
    expect(envWithoutLease.SYNARA_AGENT_GATEWAY_URL).toBeUndefined();
    expect(envWithoutLease.SYNARA_AGENT_GATEWAY_TOKEN).toBeUndefined();
    expect(envWithoutLease.SYNARA_AGENT_GATEWAY_BOOTSTRAP_TOKEN).toBeUndefined();
  });

  it("propagates the owning lifecycle generation into runtime events", () => {
    expect(
      makeAntigravityRuntimeEventBase({
        threadId: "thread-antigravity-lifecycle" as never,
        lifecycleGeneration: "generation-1",
        eventId: "event-1" as never,
        createdAt: "2026-07-17T00:00:00.000Z",
      }),
    ).toMatchObject({
      provider: "antigravity",
      threadId: "thread-antigravity-lifecycle",
      lifecycleGeneration: "generation-1",
      eventId: "event-1",
      createdAt: "2026-07-17T00:00:00.000Z",
    });
  });

  it("keeps the globally installed hook neutral outside Synara sessions", () => {
    const command = buildAntigravityCaptureCommand(
      "__synara_gui_must_not_launch__",
      "__capture_script_must_not_run__",
      "pre-tool",
    );
    const result = runCaptureCommand(
      command,
      // Stay below platform pipe-buffer limits: spawnSync itself can deadlock
      // while writing multi-megabyte stdin on macOS, which tests Node rather
      // than the hook's simple drain-and-return behavior.
      JSON.stringify({ payload: "x".repeat(32 * 1024) }),
      { SYNARA_ANTIGRAVITY_EVENTS: "" },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    // Neutral for PreToolUse means preserving the permission flow: Antigravity
    // requires a `decision`, and an empty object is treated as a denial with
    // an empty reason that blocks every tool call (#490).
    expect(result.stdout.trim()).toBe('{"decision":"ask"}');

    const postToolResult = runCaptureCommand(
      buildAntigravityCaptureCommand(
        "__synara_gui_must_not_launch__",
        "__capture_script_must_not_run__",
        "post-tool",
      ),
      JSON.stringify({ payload: "x" }),
      { SYNARA_ANTIGRAVITY_EVENTS: "" },
    );
    expect(postToolResult.error).toBeUndefined();
    expect(postToolResult.status).toBe(0);
    expect(postToolResult.stdout.trim()).toBe("{}");

    // PreInvocation output is decoded with protojson into a message that has
    // no decision field: a decision fails to unmarshal, aborts the invocation
    // it gates and makes the parent CLI exit with code 1. The neutral empty
    // object is the only answer that lets the invocation proceed.
    const preInvocationResult = runCaptureCommand(
      buildAntigravityCaptureCommand(
        "__synara_gui_must_not_launch__",
        "__capture_script_must_not_run__",
        "pre-invocation",
      ),
      JSON.stringify({ payload: "x" }),
      { SYNARA_ANTIGRAVITY_EVENTS: "" },
    );
    expect(preInvocationResult.error).toBeUndefined();
    expect(preInvocationResult.status).toBe(0);
    expect(preInvocationResult.stdout.trim()).toBe("{}");
  });

  it("answers pre-tool with a decision from the capture script when capture is inactive", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-hook-test-"));
    const scriptPath = path.join(directory, "capture.cjs");
    try {
      await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
      // Invoke the script directly, bypassing the shell wrapper: its inactive
      // fallback is defense in depth for a caller that runs the script without
      // a capture target, and must answer PreToolUse with a decision too.
      const result = spawnSync(process.execPath, [scriptPath, "pre-tool"], {
        env: { ...process.env, SYNARA_ANTIGRAVITY_EVENTS: "" },
        input: JSON.stringify({ tool: "shell" }),
        encoding: "utf8",
        timeout: 5_000,
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"decision":"ask"}');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("runs the capture script for Synara-managed sessions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-hook-test-"));
    const scriptPath = path.join(directory, "capture.cjs");
    const eventPath = path.join(directory, "events.ndjson");
    try {
      await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
      const command = buildAntigravityCaptureCommand(process.execPath, scriptPath, "pre-tool");
      const payload = JSON.stringify({
        stepIdx: 12,
        conversationId: "conversation-1",
        transcriptPath: "/tmp/transcript.jsonl",
        toolCall: {
          name: "run_command",
          args: { CommandLine: "echo super-secret-token" },
        },
      });
      const result = runCaptureCommand(command, payload, {
        SYNARA_ANTIGRAVITY_EVENTS: eventPath,
        SYNARA_ANTIGRAVITY_HOOK_DECISION: "allow",
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe('{"decision":"allow"}');
      const captured = await fs.readFile(eventPath, "utf8");
      expect(captured).toBe(
        'pre-tool\t{"conversationId":"conversation-1","transcriptPath":"/tmp/transcript.jsonl","stepIdx":12,"toolCall":{"name":"run_command","args":{"CommandLine":"echo super-secret-token"}}}\n',
      );
      expect(captured).toContain("super-secret-token");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("answers pre-invocation without a decision while still capturing the event", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-hook-test-"));
    const scriptPath = path.join(directory, "capture.cjs");
    const eventPath = path.join(directory, "events.ndjson");
    try {
      await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
      // Invoke the script directly rather than through the shell wrapper: the
      // win32 wrapper is deliberately quote-free, so it cannot launch a helper
      // whose path contains a space (this runner's process.execPath often
      // does), and the behaviour under test belongs to the script itself.
      const result = spawnSync(process.execPath, [scriptPath, "pre-invocation"], {
        env: {
          ...process.env,
          SYNARA_ANTIGRAVITY_EVENTS: eventPath,
          SYNARA_ANTIGRAVITY_HOOK_DECISION: "allow",
        },
        input: JSON.stringify({ stepIdx: 3, conversationId: "conversation-1" }),
        encoding: "utf8",
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      // The CLI decodes PreInvocation output with protojson into a message
      // that has no decision field. Any decision -- including one forced by
      // SYNARA_ANTIGRAVITY_HOOK_DECISION -- fails to unmarshal, aborts the
      // invocation and exits the parent CLI with code 1.
      expect(result.stdout.trim()).toBe("{}");
      expect(Object.keys(JSON.parse(result.stdout.trim()))).toEqual([]);
      // Staying neutral must not cost the event capture the turn depends on.
      const captured = await fs.readFile(eventPath, "utf8");
      expect(captured).toBe('pre-invocation\t{"conversationId":"conversation-1","stepIdx":3}\n');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("runs packaged Electron as Node only for Synara-managed sessions", () => {
    expect(
      buildAntigravityCaptureCommand(
        "/Applications/Synara.app/Contents/MacOS/Synara",
        "/tmp/synara-capture/capture.cjs",
        "pre-tool",
        "darwin",
      ),
    ).toBe(
      `if [ -z "\${SYNARA_ANTIGRAVITY_EVENTS:-}" ]; then cat >/dev/null 2>&1 || :; printf '%s\\n' '{"decision":"ask"}'; else ELECTRON_RUN_AS_NODE=1 '/Applications/Synara.app/Contents/MacOS/Synara' '/tmp/synara-capture/capture.cjs' 'pre-tool'; fi`,
    );
    expect(
      buildAntigravityCaptureCommand(
        String.raw`C:\Users\test\AppData\Local\Programs\Synara\Synara.exe`,
        String.raw`C:\Users\test\.gemini\capture.cjs`,
        "pre-tool",
        "win32",
      ),
    ).toBe(
      // The Antigravity CLI runs hook commands through cmd.exe with JSON
      // escapes intact, so `"` arrives as `\"` and quoted paths fail to
      // execute ("not recognized as an internal or external command"). The
      // win32 command must stay free of double quotes.
      String.raw`if not defined SYNARA_ANTIGRAVITY_EVENTS (more >nul 2>nul & echo {"decision":"ask"}) else (set ELECTRON_RUN_AS_NODE=1&& C:\Users\test\AppData\Local\Programs\Synara\Synara.exe C:\Users\test\.gemini\capture.cjs pre-tool)`,
    );
    // PreInvocation carries no decision: the CLI decodes its output with
    // protojson into a message without that field, so a decision fails to
    // unmarshal, aborts the invocation and exits the parent CLI with code 1.
    expect(
      buildAntigravityCaptureCommand(
        String.raw`C:\Users\test\AppData\Local\Programs\Synara\Synara.exe`,
        String.raw`C:\Users\test\.gemini\capture.cjs`,
        "pre-invocation",
        "win32",
      ),
    ).toBe(
      String.raw`if not defined SYNARA_ANTIGRAVITY_EVENTS (more >nul 2>nul & echo {}) else (set ELECTRON_RUN_AS_NODE=1&& C:\Users\test\AppData\Local\Programs\Synara\Synara.exe C:\Users\test\.gemini\capture.cjs pre-invocation)`,
    );
    expect(
      buildAntigravityCaptureCommand(
        "/Applications/Synara.app/Contents/MacOS/Synara",
        "/tmp/synara-capture/capture.cjs",
        "pre-invocation",
        "darwin",
      ),
    ).toBe(
      `if [ -z "\${SYNARA_ANTIGRAVITY_EVENTS:-}" ]; then cat >/dev/null 2>&1 || :; printf '%s\\n' '{}'; else ELECTRON_RUN_AS_NODE=1 '/Applications/Synara.app/Contents/MacOS/Synara' '/tmp/synara-capture/capture.cjs' 'pre-invocation'; fi`,
    );
  });

  it("guards Windows command-line limits before spawning the CLI", () => {
    expect(antigravityPromptCommandLineIssue("x".repeat(24_000), "win32")).toBeNull();
    expect(antigravityPromptCommandLineIssue("x".repeat(24_001), "win32")).toContain(
      "limited to 24,000 characters",
    );
    expect(antigravityPromptCommandLineIssue("x".repeat(120_000), "darwin")).toBeNull();
  });

  it("marks every generated hook as a command hook", () => {
    expect(buildAntigravityHookConfig((event) => `capture ${event}`)).toEqual({
      "synara-capture": {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "capture pre-tool" }],
          },
        ],
        PostToolUse: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: "capture post-tool" }],
          },
        ],
        PreInvocation: [{ type: "command", command: "capture pre-invocation" }],
        PostInvocation: [{ type: "command", command: "capture post-invocation" }],
        Stop: [{ type: "command", command: "capture stop" }],
      },
    });
  });

  it("advances file offsets only past complete JSONL records", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-test-"));
    const file = path.join(directory, "events.ndjson");
    try {
      await fs.writeFile(file, '{"first":true}\n{"second"');
      const first = await readCompleteAntigravityLines(file, 0);
      expect(first).toEqual({ lines: ['{"first":true}'], nextOffset: 15 });

      await fs.appendFile(file, ":true}\n");
      const second = await readCompleteAntigravityLines(file, first.nextOffset);
      expect(second).toEqual({ lines: ['{"second":true}'], nextOffset: 31 });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("streams hook tool names and terminal states with arguments", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-tool-events-"));
    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const toolEventsFiber = yield* adapter.streamEvents.pipe(
            Stream.filter(
              (event) => event.type === "item.started" || event.type === "item.completed",
            ),
            Stream.take(4),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-tool-events");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "exercise tools",
            attachments: [],
          });
          expect(eventFile).toBeTruthy();
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                'pre-tool\t{"stepIdx":7,"toolCall":{"name":"run_command","args":{"token":"super-secret-token"}}}',
                'post-tool\t{"stepIdx":7,"error":"super-secret-error"}',
                'pre-tool\t{"stepIdx":8,"toolCall":{"name":"write_to_file","args":{"content":"super-secret-content"}}}',
                'post-tool\t{"stepIdx":8,"error":""}',
                "",
              ].join("\n"),
            ),
          );

          const events = Array.from(
            yield* Fiber.join(toolEventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(events).toHaveLength(4);
          expect(events.map((event) => event.type)).toEqual([
            "item.started",
            "item.completed",
            "item.started",
            "item.completed",
          ]);
          expect(events.map((event) => event.payload)).toEqual([
            {
              itemType: "command_execution",
              status: "inProgress",
              title: "run_command",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-0`,
                toolName: "run_command",
                arguments: { token: "super-secret-token" },
                input: { token: "super-secret-token" },
                rawInput: { token: "super-secret-token" },
              },
            },
            {
              itemType: "command_execution",
              status: "failed",
              title: "run_command",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-0`,
                toolName: "run_command",
                arguments: { token: "super-secret-token" },
                input: { token: "super-secret-token" },
                rawInput: { token: "super-secret-token" },
                rawOutput: "super-secret-error",
              },
            },
            {
              itemType: "file_change",
              status: "inProgress",
              title: "write_to_file",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-1`,
                toolName: "write_to_file",
                arguments: { content: "super-secret-content" },
                input: { content: "super-secret-content" },
                rawInput: { content: "super-secret-content" },
              },
            },
            {
              itemType: "file_change",
              status: "completed",
              title: "write_to_file",
              data: {
                toolCallId: `antigravity-${turn.turnId}-tool-1`,
                toolName: "write_to_file",
                arguments: { content: "super-secret-content" },
                input: { content: "super-secret-content" },
                rawInput: { content: "super-secret-content" },
                rawOutput: "",
              },
            },
          ]);

          const turnTerminalFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "turn.completed"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );
          child?.emit("close", 0, null);
          // The close handler settles the turn asynchronously (gateway cancel,
          // hook-file drain, run-dir cleanup) and clears activeProcess before
          // emitting turn.completed. Wait for that event instead of a fixed
          // sleep so stopSession cannot race the pid-less fake into teardown.
          const terminalEvents = Array.from(
            yield* Fiber.join(turnTerminalFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(terminalEvents).toHaveLength(1);
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-tool-events-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("dedupes hook and transcript copies without collapsing repeated tool names", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-tool-dedup-"));
    const transcriptDir = path.join(
      root,
      ".gemini",
      "antigravity-cli",
      "brain",
      "conv-dedup-1",
      ".system_generated",
      "logs",
    );
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const toolEventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil((event) => event.type === "turn.completed"),
            Stream.filter(
              (event) =>
                (event.type === "item.started" || event.type === "item.completed") &&
                event.payload.itemType === "command_execution",
            ),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-tool-dedup");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "run a command",
            attachments: [],
          });
          expect(eventFile).toBeTruthy();

          // Matching step identities can be deduplicated without guessing across steps.
          // Each real call must render once, without either duplicating the
          // hook/transcript copy or collapsing the repeated tool name.
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                `pre-invocation\t${JSON.stringify({
                  conversationId: "conv-dedup-1",
                  transcriptPath: transcriptFile,
                })}`,
                'pre-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"echo first"}}}',
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"run_command"},"error":""}',
                'pre-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"echo second"}}}',
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"run_command"},"error":""}',
                "",
              ].join("\n"),
            ),
          );
          yield* Effect.promise(() =>
            fs.appendFile(
              transcriptFile,
              [
                JSON.stringify({
                  step_index: 1,
                  type: "PLANNER_RESPONSE",
                  thinking: "planning",
                  tool_calls: [
                    { name: "run_command", args: { CommandLine: "echo first" } },
                    { name: "run_command", args: { CommandLine: "echo second" } },
                  ],
                }),
                "",
              ].join("\n"),
            ),
          );

          child?.emit("close", 0, null);
          const events = Array.from(
            yield* Fiber.join(toolEventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(events).toHaveLength(4);
          expect(events.map((event) => event.type)).toEqual([
            "item.started",
            "item.completed",
            "item.started",
            "item.completed",
          ]);
          const comparable = events.map((event) => {
            if (event.type !== "item.started" && event.type !== "item.completed") {
              throw new Error(`Unexpected tool event: ${event.type}`);
            }
            return {
              type: event.type,
              itemType: event.payload.itemType,
              title: event.payload.title,
              toolCallId: (event.payload.data as { toolCallId?: string })?.toolCallId,
            };
          });
          expect(comparable).toEqual([
            {
              type: "item.started",
              itemType: "command_execution",
              title: "run_command",
              toolCallId: `antigravity-${turn.turnId}-tool-0`,
            },
            {
              type: "item.completed",
              itemType: "command_execution",
              title: "run_command",
              toolCallId: `antigravity-${turn.turnId}-tool-0`,
            },
            {
              type: "item.started",
              itemType: "command_execution",
              title: "run_command",
              toolCallId: `antigravity-${turn.turnId}-tool-1`,
            },
            {
              type: "item.completed",
              itemType: "command_execution",
              title: "run_command",
              toolCallId: `antigravity-${turn.turnId}-tool-1`,
            },
          ]);

          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-tool-dedup-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("routes subagent hook events to a child thread without rebinding the session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-subagent-events-"));
    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil(
              (event) =>
                event.type === "item.started" &&
                event.providerRefs?.providerThreadId === "conv-parent-1",
            ),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-subagent-events");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            resumeCursor: { conversationId: "conv-parent-1" },
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "spawn a subagent",
            attachments: [],
          });
          expect(eventFile).toBeTruthy();

          // The subagent CLI inherits SYNARA_ANTIGRAVITY_EVENTS, so its hooks
          // land in this session's stream with the subagent's conversation id.
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                `pre-invocation\t${JSON.stringify({
                  conversationId: "conv-child-1",
                  transcriptPath: "C:/tmp/child-transcript.jsonl",
                  modelName: "gemini-3.6-flash-medium",
                })}`,
                `pre-tool\t${JSON.stringify({
                  conversationId: "conv-child-1",
                  stepIdx: 1,
                  toolCall: { name: "run_command", args: { CommandLine: "echo child" } },
                })}`,
                `post-tool\t${JSON.stringify({
                  conversationId: "conv-child-1",
                  stepIdx: 1,
                  error: "",
                })}`,
                `stop\t${JSON.stringify({ conversationId: "conv-child-1" })}`,
                `stop\t${JSON.stringify({ conversationId: "conv-child-1" })}`,
                `pre-tool\t${JSON.stringify({
                  conversationId: "conv-parent-1",
                  stepIdx: 2,
                  toolCall: { name: "run_command", args: { CommandLine: "echo parent" } },
                })}`,
                "",
              ].join("\n"),
            ),
          );

          const events = Array.from(
            yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          const childRefs = {
            providerThreadId: "conv-child-1",
            providerParentThreadId: "conv-parent-1",
          };
          const childThreadStarted = events.find(
            (event) =>
              event.type === "thread.started" &&
              event.providerRefs?.providerThreadId === "conv-child-1",
          );
          expect(childThreadStarted?.providerRefs).toEqual(childRefs);
          const childTurnStarted = events.find(
            (event) =>
              event.type === "turn.started" &&
              event.providerRefs?.providerThreadId === "conv-child-1",
          );
          expect(childTurnStarted?.turnId).toBe(turn.turnId);
          expect(childTurnStarted?.payload).toMatchObject({ model: "gemini-3.6-flash-medium" });
          const childItemStarted = events.find(
            (event) =>
              event.type === "item.started" &&
              event.providerRefs?.providerThreadId === "conv-child-1",
          );
          expect(childItemStarted?.providerRefs).toEqual(childRefs);
          expect(childItemStarted?.payload).toMatchObject({
            itemType: "command_execution",
            status: "inProgress",
            title: "run_command",
          });
          const childItemCompleted = events.find(
            (event) =>
              event.type === "item.completed" &&
              event.providerRefs?.providerThreadId === "conv-child-1",
          );
          expect(childItemCompleted?.payload).toMatchObject({
            itemType: "command_execution",
            status: "completed",
            title: "run_command",
          });
          const childTurnCompleted = events.find(
            (event) =>
              event.type === "turn.completed" &&
              event.providerRefs?.providerThreadId === "conv-child-1",
          );
          expect(childTurnCompleted?.payload).toEqual({
            state: "completed",
            stopReason: "model_stop",
          });
          expect(
            events.filter(
              (event) =>
                event.type === "turn.completed" &&
                event.providerRefs?.providerThreadId === "conv-child-1",
            ),
          ).toHaveLength(1);
          // The parent thread must not be re-emitted for the subagent, and the
          // session keeps its own conversation: its own tool events stay bound
          // to conv-parent-1 without a parent ref.
          expect(
            events.filter(
              (event) =>
                event.type === "thread.started" &&
                event.providerRefs?.providerThreadId === "conv-parent-1",
            ),
          ).toHaveLength(1);
          const parentItem = events.find(
            (event) =>
              event.type === "item.started" &&
              event.providerRefs?.providerThreadId === "conv-parent-1",
          );
          expect(parentItem?.providerRefs).toEqual({ providerThreadId: "conv-parent-1" });
          expect(parentItem?.payload).toMatchObject({ title: "run_command" });

          child?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-subagent-events-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("settles an unfinished child turn when the parent process fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-child-failure-"));
    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.takeUntil(
              (event) =>
                event.type === "turn.completed" &&
                event.providerRefs?.providerParentThreadId === undefined,
            ),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-child-failure");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            resumeCursor: { conversationId: "conv-parent-failure" },
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({
            threadId,
            input: "spawn a failing subagent",
            attachments: [],
          });
          expect(eventFile).toBeTruthy();

          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              `pre-invocation\t${JSON.stringify({
                conversationId: "conv-child-failure",
                modelName: "gemini-3.6-flash-medium",
              })}\n`,
            ),
          );
          child?.emit("close", 1, null);

          const events = Array.from(
            yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          const childTerminalIndex = events.findIndex(
            (event) =>
              event.type === "turn.completed" &&
              event.providerRefs?.providerThreadId === "conv-child-failure",
          );
          const parentTerminalIndex = events.findIndex(
            (event) =>
              event.type === "turn.completed" &&
              event.providerRefs?.providerParentThreadId === undefined,
          );
          expect(childTerminalIndex).toBeGreaterThanOrEqual(0);
          expect(childTerminalIndex).toBeLessThan(parentTerminalIndex);
          expect(events[childTerminalIndex]?.payload).toMatchObject({
            state: "failed",
            stopReason: "error",
          });
          expect(
            events.filter(
              (event) =>
                event.type === "turn.completed" &&
                event.providerRefs?.providerThreadId === "conv-child-failure",
            ),
          ).toHaveLength(1);

          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-child-failure-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("terminates helper processes that exceed their timeout", async () => {
    await expect(
      runAntigravityHelperProcess(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
        timeoutMs: 50,
      }),
    ).rejects.toThrow("Antigravity helper timed out after 50ms");
  });

  // #465: an active Stop hook must not emit a non-standard decision that can
  // hang the print process after the assistant reply is already visible.
  it("answers stop hooks with a neutral allow-exit payload", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-stop-hook-"));
    const scriptPath = path.join(directory, "capture.cjs");
    const eventPath = path.join(directory, "events.ndjson");
    try {
      await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
      const result = spawnSync(process.execPath, [scriptPath, "stop"], {
        env: { ...process.env, SYNARA_ANTIGRAVITY_EVENTS: eventPath },
        input: JSON.stringify({ stop: true }),
        encoding: "utf8",
        timeout: 5_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("{}");
      expect(result.stdout).not.toContain('"decision":"stop"');
      expect(await fs.readFile(eventPath, "utf8")).toContain("stop\t");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Antigravity turn settle on cancel (#465)", () => {
  const makeSpawnProcess = (children: ChildProcess[]) =>
    ((
      _command: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      const child = new EventEmitter() as ChildProcess;
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.assign(child, {
        stdout,
        stderr,
        eventFile: _options.env?.SYNARA_ANTIGRAVITY_EVENTS,
        killed: false,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: () => true,
      });
      children.push(child);
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

  const failTeardown = async () => {
    throw new Error("process exit could not be proven");
  };

  it.each([
    { error: "Historical failure", turns: 6, stopCleanup: false },
    {
      error: "The stream was interrupted. Please continue the task you were working on.",
      turns: 1,
      stopCleanup: false,
    },
    {
      error: "The stream was interrupted. Please continue the task you were working on.",
      turns: 1,
      stopCleanup: true,
    },
    { error: "timeout waiting for response", turns: 1, stopCleanup: false },
    { error: "timeout waiting for response", turns: 1, stopCleanup: true },
    { error: undefined, turns: 1, stopCleanup: true },
  ])(
    "honors terminal errors and successful stop teardown (error=$error, turns=$turns)",
    async ({ error, turns, stopCleanup }) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-json-usage-"));
      const children: ChildProcess[] = [];
      try {
        await Effect.runPromise(
          Effect.gen(function* () {
            const adapter = yield* AntigravityAdapter;
            const threadId = ThreadId.makeUnsafe("thread-antigravity-json-usage");
            yield* adapter.startSession({
              provider: "antigravity",
              threadId,
              runtimeMode: "full-access",
              cwd: root,
              providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
            });
            const eventsFiber = yield* adapter.streamEvents.pipe(
              Stream.takeUntil((event) => event.type === "turn.completed"),
              Stream.runCollect,
              Effect.forkChild,
            );
            yield* adapter.sendTurn({ threadId, input: "usage test", attachments: [] });
            children[0]!.stdout!.emit(
              "data",
              [
                JSON.stringify({
                  event: "step_update",
                  step_update: {
                    step_index: 32,
                    state: "DONE",
                    step_type: "agent_response",
                    text_delta: "SG-OK",
                    usage: {
                      input_tokens: 13286,
                      output_tokens: 3,
                      cache_read_tokens: 0,
                      thinking_tokens: 0,
                    },
                  },
                }),
                JSON.stringify({
                  event: "result",
                  result: {
                    status: error ? "ERROR" : "SUCCESS",
                    error,
                    response: turns === 1 ? "" : "SG-OK",
                    duration_seconds: 9259,
                    num_turns: turns,
                    usage: { input_tokens: 61019, output_tokens: 1023, cache_read_tokens: 105860 },
                  },
                }),
              ].join("\n"),
            );
            if (stopCleanup) {
              yield* Effect.promise(() =>
                fs.writeFile(
                  (children[0] as ChildProcess & { eventFile: string }).eventFile,
                  "stop\t{}\n",
                ),
              );
            }
            children[0]!.emit("close", stopCleanup ? null : 1, stopCleanup ? "SIGKILL" : null);
            const events = Array.from(
              yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")),
            );
            const terminal = events.find((event) => event.type === "turn.completed")?.payload;
            if (error) {
              expect(terminal).toMatchObject({ state: "failed", errorMessage: error });
            } else {
              expect(terminal).toMatchObject({ state: "completed" });
            }
            expect(
              events
                .filter((event) => event.type === "content.delta")
                .map((event) => event.payload),
            ).toEqual([{ streamKind: "assistant_text", delta: "SG-OK" }]);
            yield* adapter.stopSession(threadId);
          }).pipe(
            Effect.provide(
              makeAntigravityAdapterLive({
                ensurePlugin: async () => undefined,
                spawnProcess: makeSpawnProcess(children),
              }).pipe(
                Layer.provideMerge(
                  ServerConfig.layerTest(root, { prefix: "antigravity-json-usage-" }),
                ),
                Layer.provideMerge(NodeServices.layer),
              ),
            ),
          ),
        );
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it("unlocks Cancel without letting a late close settle the follow-up", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-interrupt-hung-"));
    const children: ChildProcess[] = [];
    const spawnProcess = makeSpawnProcess(children);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const threadId = ThreadId.makeUnsafe("thread-antigravity-interrupt-hung");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "stuck working",
            attachments: [],
          });
          const before = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
          expect(before?.status).toBe("running");
          expect(before?.activeTurnId).toBe(turn.turnId);

          yield* adapter.interruptTurn(threadId, turn.turnId);

          const after = (yield* adapter.listSessions()).find((s) => s.threadId === threadId);
          expect(after?.status).toBe("ready");
          expect(after?.activeTurnId).toBeUndefined();

          const followUp = yield* adapter.sendTurn({
            threadId,
            input: "follow-up",
            attachments: [],
          });
          children[0]?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");

          const afterLateClose = (yield* adapter.listSessions()).find(
            (session) => session.threadId === threadId,
          );
          expect(afterLateClose?.status).toBe("running");
          expect(afterLateClose?.activeTurnId).toBe(followUp.turnId);

          children[1]?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree: failTeardown,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-interrupt-hung-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits a terminal interrupted turn.completed so the stop button unlocks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-stop-button-"));
    const children: ChildProcess[] = [];
    const spawnProcess = makeSpawnProcess(children);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const threadId = ThreadId.makeUnsafe("thread-antigravity-stop-button");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "long running work",
            attachments: [],
          });

          const terminalFiber = yield* adapter.streamEvents.pipe(
            Stream.filter((event) => event.type === "turn.completed"),
            Stream.take(1),
            Stream.runCollect,
            Effect.forkChild,
          );

          // The UI's Stop button dispatches thread.turn.interrupt, which lands
          // on interruptTurn. It must settle the live turn terminal so the
          // projection flips the session back to ready and the button clears.
          yield* adapter.interruptTurn(threadId, turn.turnId);

          const terminal = Array.from(
            yield* Fiber.join(terminalFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(terminal).toHaveLength(1);
          expect(terminal[0]?.turnId).toBe(turn.turnId);
          expect(terminal[0]?.payload).toMatchObject({
            state: "interrupted",
            stopReason: "interrupted",
          });

          children[0]?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-stop-button-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("resolves default reasoning effort for Gemini 3.7 Flash and DeepSeek models", () => {
    expect(resolveAntigravityCliModelLabel("Gemini 3.7 Flash")).toBe("Gemini 3.7 Flash (High)");
    expect(resolveAntigravityCliModelLabel("Gemini 3.7 Flash", { reasoningEffort: "medium" })).toBe(
      "Gemini 3.7 Flash (Medium)",
    );
    expect(resolveAntigravityCliModelLabel("DeepSeek V4 Flash Max")).toBe(
      "DeepSeek V4 Flash Max (High)",
    );
  });

  it("compacts multiline pre-invocation and stop hook payloads into single NDJSON lines", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-compact-"));
    const scriptPath = path.join(directory, "capture.cjs");
    const eventPath = path.join(directory, "events.ndjson");
    try {
      await fs.writeFile(scriptPath, hookScriptSource(), { mode: 0o700 });
      const multilinePayload = JSON.stringify(
        {
          conversationId: "conv-123",
          transcriptPath: "C:\\path\\to\\transcript.jsonl",
          modelName: "Gemini 3.7 Flash",
          workspacePaths: ["C:\\workspace"],
        },
        null,
        2,
      );

      const preInvResult = runCaptureCommand(
        buildAntigravityCaptureCommand(process.execPath, scriptPath, "pre-invocation"),
        multilinePayload,
        { SYNARA_ANTIGRAVITY_EVENTS: eventPath },
      );
      expect(preInvResult.status).toBe(0);

      const stopResult = runCaptureCommand(
        buildAntigravityCaptureCommand(process.execPath, scriptPath, "stop"),
        multilinePayload,
        { SYNARA_ANTIGRAVITY_EVENTS: eventPath },
      );
      expect(stopResult.status).toBe(0);

      const fileContent = await fs.readFile(eventPath, "utf8");
      const lines = fileContent.split("\n").filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(lines[0]?.startsWith("pre-invocation\t{")).toBe(true);
      expect(lines[1]?.startsWith("stop\t{")).toBe(true);
      expect(JSON.parse(lines[0]!.split("\t")[1]!)).toMatchObject({
        conversationId: "conv-123",
        transcriptPath: "C:\\path\\to\\transcript.jsonl",
        modelName: "Gemini 3.7 Flash",
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("streams reasoning traces from thinking steps and assistant text from final steps in transcript", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-transcript-test-"));
    const transcriptDir = path.join(
      root,
      ".gemini",
      "antigravity-cli",
      "brain",
      "conv-test-1",
      ".system_generated",
      "logs",
    );
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcriptFile = path.join(transcriptDir, "transcript.jsonl");

    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "item.started" ||
                event.type === "content.delta" ||
                event.type === "item.completed",
            ),
            Stream.take(8),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-transcript");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({
            threadId,
            input: "solve problem",
            attachments: [],
          });

          expect(eventFile).toBeTruthy();
          // 1. Hook fires with learned transcriptPath
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              `pre-invocation\t${JSON.stringify({
                conversationId: "conv-test-1",
                transcriptPath: transcriptFile,
              })}\n`,
            ),
          );

          // 2. Transcript records a reasoning step (with tool_calls and thinking) + an assistant completion step
          yield* Effect.promise(() =>
            fs.appendFile(
              transcriptFile,
              [
                JSON.stringify({
                  step_index: 0,
                  type: "USER_INPUT",
                  content: "solve problem",
                }),
                JSON.stringify({
                  step_index: 1,
                  type: "PLANNER_RESPONSE",
                  thinking: "Analyzing problem requirements...",
                  tool_calls: [{ name: "run_command", args: { CommandLine: "echo test" } }],
                }),
                JSON.stringify({
                  step_index: 2,
                  type: "PLANNER_RESPONSE",
                  content: "Here is the solution.",
                }),
                "",
              ].join("\n"),
            ),
          );

          const events = Array.from(
            yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(events).toHaveLength(8);
          // Reasoning item: started -> delta -> completed
          expect(events[0]?.payload).toMatchObject({
            itemType: "reasoning",
            status: "inProgress",
            title: "Reasoning",
          });
          expect(events[1]?.payload).toMatchObject({
            streamKind: "reasoning_text",
            delta: "Analyzing problem requirements...",
          });
          expect(events[2]?.payload).toMatchObject({
            itemType: "reasoning",
            status: "completed",
            title: "Reasoning",
            detail: "Analyzing problem requirements...",
          });
          // Tool call from the transcript body surfaces as a tool lifecycle
          // item even though no pre/post-tool hook event fired: reasoning ->
          // run_command -> assistant. (#antigravity tool calls are displayed)
          expect(events[3]?.payload).toMatchObject({
            itemType: "command_execution",
            status: "inProgress",
            title: "run_command",
            data: {
              toolName: "run_command",
              command: "echo test",
              arguments: { CommandLine: "echo test" },
            },
          });
          expect(events[4]?.payload).toMatchObject({
            itemType: "command_execution",
            status: "completed",
            title: "run_command",
            data: {
              toolName: "run_command",
              command: "echo test",
              arguments: { CommandLine: "echo test" },
            },
          });
          // Assistant message: started -> delta -> completed
          expect(events[5]?.payload).toMatchObject({
            itemType: "assistant_message",
            status: "inProgress",
            title: "Assistant",
          });
          expect(events[6]?.payload).toMatchObject({
            streamKind: "assistant_text",
            delta: "Here is the solution.",
          });
          expect(events[7]?.payload).toMatchObject({
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant",
          });

          child?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-transcript-test-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

const agyTaskId = "e5c58127-8ca4-48d1-af24-6f2bc370f613/task-997";
const agyCommand =
  "adb -s 1901092534053723 shell uiautomator dump /sdcard/native_overlay.xml; adb -s 1901092534053723 pull /sdcard/native_overlay.xml E:\\Tools\\Rokid\\tmp\\native_overlay_dump.xml";
const agyRunningStep = (step_index: number, taskId = agyTaskId) => ({
  step_index,
  type: "GENERIC",
  status: "RUNNING",
  content: `Created At: 2026-09-13T14:25:03+02:00\nTool is running as a background task with task id: ${taskId}\nTask Description: ${agyCommand}\nTask logs are available at: file:///C:/tmp/task.log\nYOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: ...\n DO NOTHING ELSE.`,
});
const agyCompletionStep = (step_index: number, taskId = agyTaskId) => ({
  step_index,
  type: "SYSTEM_MESSAGE",
  content: `<SYSTEM_MESSAGE>\n[Message] sender=${taskId} priority=MESSAGE_PRIORITY_HIGH content=Task id "${taskId}" exited with code 0\n</SYSTEM_MESSAGE>`,
});
const agyText = (step_index: number, content: string) => ({
  step_index,
  type: "PLANNER_RESPONSE",
  content,
});

describe("Antigravity background task helpers (#752)", () => {
  it("parses system message task ids and exit codes", () => {
    expect(parseAntigravitySystemMessage("plain assistant text")).toBeNull();
    expect(parseAntigravitySystemMessage(undefined)).toBeNull();

    const success = parseAntigravitySystemMessage(
      "<SYSTEM_MESSAGE> Task id 'task-abc123' exited with code 0",
    );
    expect(success).toMatchObject({
      isSystemMessage: true,
      taskId: "task-abc123",
      exitCode: 0,
      isFailure: false,
    });

    const failure = parseAntigravitySystemMessage(
      '<SYSTEM_MESSAGE> sender=task-9f2 Task id "task-9f2" exited with code 1',
    );
    expect(failure).toMatchObject({
      isSystemMessage: true,
      taskId: "task-9f2",
      sender: "task-9f2",
      exitCode: 1,
      isFailure: true,
    });

    const senderOnly = parseAntigravitySystemMessage("<SYSTEM_MESSAGE> sender=task-x77 done");
    expect(senderOnly).toMatchObject({ isSystemMessage: true, taskId: "task-x77" });

    expect(
      parseAntigravitySystemMessage(
        "<SYSTEM_MESSAGE> Task id 'task-clean' completed with 0 failed and no error",
      ),
    ).toMatchObject({ taskId: "task-clean", isFailure: false });
    expect(
      parseAntigravitySystemMessage(
        "<SYSTEM_MESSAGE> Task id 'task-tests' completed with 0 tests failed",
      ),
    ).toMatchObject({ taskId: "task-tests", isFailure: false });
  });

  it("detects background task starts from run_command tool output", () => {
    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "npm run dev" },
        {
          toolOutput: "Task id 'task-42' is now running in the background",
        },
      ),
    ).toEqual({
      taskId: "task-42",
      description: "npm run dev",
      isBackground: true,
    });

    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "npm run dev" },
        {
          result: "sent to the background",
        },
      ),
    ).toEqual({ description: "npm run dev", isBackground: true });

    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { command: "npm run dev", WaitMsBeforeAsync: 1000 },
        {},
      ),
    ).toEqual({ description: "npm run dev", isBackground: true });

    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "npm run dev", WaitMsBeforeAsync: 1000 },
        { toolOutput: "exited with code 0" },
      ),
    ).toBeNull();

    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "echo task-42" },
        { toolOutput: "foreground command printed task-42 and exited with code 0" },
      ),
    ).toBeNull();

    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "npm run dev", WaitMsBeforeAsync: 1000 },
        { failed: true },
      ),
    ).toBeNull();

    expect(
      detectAntigravityBackgroundTaskStart("run_command", {
        CommandLine: "npm run dev",
        WaitMsBeforeAsync: 1000,
      }),
    ).toBeNull();
  });

  it.each([
    { taskId: "session/task-8", output: "Task id 'session/task-8' is running in the background" },
    { taskId: "session:task-8", output: 'Task id "session:task-8" is running in the background' },
    {
      taskId: "session/task-8",
      output: "Tool is running as a background task with task id: session/task-8",
    },
    { taskId: "session/task-8", output: "Task ID:session/task-8 is running in the background" },
  ])("preserves the full background task id in $output", ({ taskId, output }) => {
    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "npm run build" },
        { toolOutput: output },
      ),
    ).toEqual({
      taskId,
      description: "npm run build",
      isBackground: true,
    });
  });

  it("does not extract a task id from an identifier label", () => {
    expect(
      detectAntigravityBackgroundTaskStart(
        "run_command",
        { CommandLine: "npm run build" },
        { toolOutput: "Task identifier pending for a command running in the background" },
      ),
    ).toEqual({ description: "npm run build", isBackground: true });
  });

  it("detects schedule timers and ignores unrelated tools", () => {
    expect(
      detectAntigravityBackgroundTaskStart(
        "schedule",
        { Prompt: "remind me later" },
        {
          toolOutput: "Scheduled timer-77 created",
        },
      ),
    ).toEqual({
      taskId: "timer-77",
      description: "remind me later",
      isBackground: true,
    });

    expect(detectAntigravityBackgroundTaskStart("schedule", {})).toEqual({
      description: "Scheduled timer",
      isBackground: true,
    });

    expect(
      detectAntigravityBackgroundTaskStart(
        "schedule",
        { Prompt: "remind me later" },
        {
          error: "scheduler unavailable",
        },
      ),
    ).toBeNull();

    expect(detectAntigravityBackgroundTaskStart("list_files")).toBeNull();
  });

  it("matches completion task ids against tracked tasks", () => {
    const tracked = ["task-1", "task-2"];

    expect(matchAntigravityTrackedTaskId("task-1", tracked)).toBe("task-1");
    expect(matchAntigravityTrackedTaskId("job/task-2", tracked)).toBe("task-2");
    expect(matchAntigravityTrackedTaskId("unknown-99", tracked)).toBeUndefined();
    expect(matchAntigravityTrackedTaskId(undefined, ["task-solo"])).toBe("task-solo");
    expect(matchAntigravityTrackedTaskId("another-task", ["task-solo"])).toBeUndefined();
    expect(matchAntigravityTrackedTaskId(undefined, tracked)).toBeUndefined();
    expect(matchAntigravityTrackedTaskId("task-1", [])).toBeUndefined();
  });

  it("settles a completed background task before handling the final stop hook", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-background-stop-"));
    const transcriptFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcriptFile, "");

    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    let teardownCalls = 0;
    let resolveTeardown = (): void => undefined;
    const teardownObserved = new Promise<void>((resolve) => {
      resolveTeardown = resolve;
    });
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const toolsCompleted = yield* Deferred.make<void>();
          const followupObserved = yield* Deferred.make<void>();
          const backgroundTaskCompleted = yield* Deferred.make<void>();
          const runtimeTaskEvents: string[] = [];
          let completedTools = 0;
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event.type.startsWith("task.")) runtimeTaskEvents.push(event.type);
                if (event.type === "task.completed") {
                  yield* Deferred.succeed(backgroundTaskCompleted, undefined);
                }
                if (event.type === "item.completed" && ++completedTools === 2) {
                  yield* Deferred.succeed(toolsCompleted, undefined);
                }
                if (
                  event.type === "item.completed" &&
                  event.payload.itemType === "assistant_message"
                ) {
                  yield* Deferred.succeed(followupObserved, undefined);
                }
              }),
            ),
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-background-stop");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({ threadId, input: "run tests", attachments: [] });

          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                `pre-invocation\t${JSON.stringify({
                  conversationId: "conversation-background-stop",
                  transcriptPath: transcriptFile,
                })}`,
                'pre-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}}}',
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}},"toolOutput":"sent to the background"}',
                'pre-tool\t{"stepIdx":2,"toolCall":{"name":"run_command","args":{"CommandLine":"npm run dev","WaitMsBeforeAsync":1000}}}',
                'post-tool\t{"stepIdx":2,"toolCall":{"name":"run_command","args":{"CommandLine":"npm run dev","WaitMsBeforeAsync":1000}},"toolOutput":"sent to the background"}',
                'post-tool\t{"stepIdx":3,"toolCall":{"name":"manage_task","args":{"Action":"kill","TaskId":"task-real-a"}}}',
                "",
              ].join("\n"),
            ),
          );
          yield* Deferred.await(toolsCompleted).pipe(Effect.timeout("2 seconds"));
          expect(teardownCalls).toBe(0);

          yield* Effect.sync(() => {
            fsSync.appendFileSync(
              transcriptFile,
              [
                JSON.stringify({
                  type: "SYSTEM_MESSAGE",
                  content: "<SYSTEM_MESSAGE> Task id 'task-real-b' exited with code 0",
                }),
                JSON.stringify({
                  step_index: 6,
                  type: "PLANNER_RESPONSE",
                  content: "background work completed",
                }),
                "",
              ].join("\n"),
            );
            fsSync.appendFileSync(eventFile!, 'stop\t{"stepIdx":4}\n');
          });
          yield* Deferred.await(followupObserved).pipe(Effect.timeout("2 seconds"));
          expect(teardownCalls).toBe(0);
          yield* Effect.sync(() => {
            // Anonymous starts need their transcript identities before either
            // terminal can settle them and permit the final Stop to tear down.
            fsSync.appendFileSync(
              transcriptFile,
              [
                JSON.stringify({
                  step_index: 2,
                  type: "GENERIC",
                  status: "RUNNING",
                  content:
                    "Tool is running as a background task with task id: task-real-a\nTask Description: npm test",
                }),
                JSON.stringify({
                  step_index: 3,
                  type: "GENERIC",
                  status: "RUNNING",
                  content:
                    "Tool is running as a background task with task id: task-real-b\nTask Description: npm run dev",
                }),
                "",
              ].join("\n"),
            );
            fsSync.appendFileSync(eventFile!, "stop\t{}\n");
          });
          yield* Effect.promise(() => teardownObserved).pipe(Effect.timeout("2 seconds"));
          yield* Deferred.await(backgroundTaskCompleted).pipe(Effect.timeout("2 seconds"));
          expect(teardownCalls).toBe(1);
          expect(runtimeTaskEvents).toEqual(["task.started", "task.completed"]);
          yield* Fiber.interrupt(eventsFiber);

          child?.emit("close", 0, null);
          yield* Effect.sleep("25 millis");
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree: async () => {
                teardownCalls += 1;
                resolveTeardown();
                return completeProcessTeardown();
              },
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-background-stop-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("parses agy GENERIC RUNNING background task steps", () => {
    expect(parseAntigravityBackgroundTaskStep(agyRunningStep(997).content)).toEqual({
      taskId: agyTaskId,
      description: agyCommand,
    });
    expect(
      parseAntigravityBackgroundTaskStep('Task id "task-5" moved to a background task'),
    ).toEqual({ taskId: "task-5" });
    expect(parseAntigravityBackgroundTaskStep("Created file E:\\tmp\\task-1.txt")).toBeNull();
    expect(parseAntigravityBackgroundTaskStep(undefined)).toBeNull();
    expect(normalizeAntigravityCommandLine(`"${agyCommand}"`)).toBe(agyCommand);
    expect(normalizeAntigravityCommandLine("  npm   run build ")).toBe("npm run build");
    expect(normalizeAntigravityCommandLine(undefined)).toBeUndefined();
    const keys = [{ stepIndex: 5, command: "npm test" }, { stepIndex: 5 }];
    expect(takeAntigravityBackgroundCallKey(keys, 5, "npm run build")).toBe(true);
    expect(keys).toEqual([{ stepIndex: 5, command: "npm test" }]);
    expect(takeAntigravityBackgroundCallKey(keys, 5, "npm run build")).toBe(false);
    expect(takeAntigravityBackgroundCallKey(keys, 5, undefined)).toBe(true);
    expect(takeAntigravityBackgroundCallKey(keys, undefined, "npm test")).toBe(false);
  });

  const runAgyBackgroundScenario = async (
    label: string,
    drive: (io: {
      readonly hooks: (...lines: string[]) => void;
      readonly transcript: (...steps: object[]) => void;
      readonly waitUntil: (check: () => boolean) => Effect.Effect<void>;
      readonly counts: { teardowns: number; assistantMessages: number };
      readonly taskEvents: { type: string; taskId: string }[];
      readonly taskStarts: { taskType: string | undefined; source: unknown }[];
    }) => Effect.Effect<void>,
  ) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `synara-antigravity-${label}-`));
    const transcriptFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcriptFile, "");
    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const counts = { teardowns: 0, assistantMessages: 0 };
    const taskEvents: { type: string; taskId: string }[] = [];
    const taskStarts: { taskType: string | undefined; source: unknown }[] = [];
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const waitUntil = (check: () => boolean) =>
      Effect.promise(async () => {
        for (let attempt = 0; attempt < 200 && !check(); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(check()).toBe(true);
      });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          let turnsCompleted = 0;
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "turn.completed") turnsCompleted += 1;
                if (event.type === "task.started" || event.type === "task.completed") {
                  taskEvents.push({ type: event.type, taskId: event.payload.taskId });
                }
                if (event.type === "task.started") {
                  taskStarts.push({ taskType: event.payload.taskType, source: event.raw?.payload });
                }
                if (
                  event.type === "item.completed" &&
                  event.payload.itemType === "assistant_message"
                ) {
                  counts.assistantMessages += 1;
                }
              }),
            ),
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe(`thread-antigravity-${label}`);
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({ threadId, input: "dump the overlay", attachments: [] });
          const append = (file: string, entries: unknown[]) =>
            fsSync.appendFileSync(
              file,
              entries.map((e) => `${typeof e === "string" ? e : JSON.stringify(e)}\n`).join(""),
            );
          const transcriptPath = transcriptFile;
          append(eventFile!, [`pre-invocation\t${JSON.stringify({ transcriptPath })}`]);
          yield* drive({
            hooks: (...lines) => append(eventFile!, lines),
            transcript: (...steps) => append(transcriptFile, steps),
            waitUntil,
            counts,
            taskEvents,
            taskStarts,
          });
          yield* Effect.sleep("200 millis");
          expect(counts.teardowns).toBe(1);

          child?.emit("close", 0, null);
          yield* waitUntil(() => turnsCompleted === 1);
          yield* Effect.sleep("100 millis");
          expect(turnsCompleted).toBe(1);
          yield* Fiber.interrupt(eventsFiber);
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree: async () => {
                counts.teardowns += 1;
                return completeProcessTeardown();
              },
            }).pipe(
              Layer.provideMerge(ServerConfig.layerTest(root, { prefix: `antigravity-${label}-` })),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  };

  it("keeps agy alive when a command is backgrounded before the stop hook", () =>
    runAgyBackgroundScenario("agy-transcript-background", (io) =>
      Effect.gen(function* () {
        const args = JSON.stringify({ CommandLine: agyCommand, WaitMsBeforeAsync: "5000" });
        const toolCall = `"toolCall":{"name":"run_command","args":${args}}`;
        io.hooks(`pre-tool\t{"stepIdx":996,${toolCall}}`);
        io.transcript(agyRunningStep(997), agyText(998, "Dumping native overlay hierarchy."));
        io.hooks('stop\t{"stepIdx":998}');
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        yield* Effect.sleep("200 millis");
        expect(io.counts.teardowns).toBe(0);

        io.transcript(agyCompletionStep(999), agyText(1000, "Overlay dumped."));
        yield* io.waitUntil(() => io.counts.assistantMessages === 2);
        // agy 1.2.2 sends post-tool only once the task finished: no re-registration.
        io.hooks(
          `post-tool\t{"stepIdx":996,${toolCall},"toolOutput":${JSON.stringify(agyRunningStep(997).content)}}`,
          'stop\t{"stepIdx":1000}',
        );
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it("ignores a late post-tool start for a task the transcript already settled", () =>
    runAgyBackgroundScenario("agy-background-late-post-tool", (io) =>
      Effect.gen(function* () {
        // No pre-tool hook (lost or malformed), so no PendingTool carries the marker.
        io.transcript(agyRunningStep(997), agyText(998, "Dumping native overlay hierarchy."));
        io.hooks('stop	{"stepIdx":998}');
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        yield* Effect.sleep("200 millis");
        expect(io.counts.teardowns).toBe(0);

        io.transcript(agyCompletionStep(999), agyText(1000, "Overlay dumped."));
        yield* io.waitUntil(() => io.counts.assistantMessages === 2);
        const args = JSON.stringify({ CommandLine: agyCommand, WaitMsBeforeAsync: "5000" });
        io.hooks(
          `post-tool	{"stepIdx":996,"toolCall":{"name":"run_command","args":${args}},"toolOutput":${JSON.stringify(agyRunningStep(997).content)}}`,
          'stop	{"stepIdx":1000}',
        );
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it("ignores a late post-tool start for a transcript task killed through manage_task", () =>
    runAgyBackgroundScenario("agy-background-killed-late-post-tool", (io) =>
      Effect.gen(function* () {
        io.transcript(agyRunningStep(997), agyText(998, "Dumping native overlay hierarchy."));
        io.hooks('stop	{"stepIdx":998}');
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        yield* Effect.sleep("200 millis");
        expect(io.counts.teardowns).toBe(0);

        const args = JSON.stringify({ CommandLine: agyCommand, WaitMsBeforeAsync: "5000" });
        io.hooks(
          `post-tool	{"stepIdx":1001,"toolCall":{"name":"manage_task","args":{"Action":"kill","TaskId":"task-997"}},"toolOutput":"killed"}`,
          `post-tool	{"stepIdx":996,"toolCall":{"name":"run_command","args":${args}},"toolOutput":${JSON.stringify(agyRunningStep(997).content)}}`,
        );
        io.transcript(agyText(1002, "Stopped the dump."));
        io.hooks('stop	{"stepIdx":1002}');
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it("marks a pre-tool hook read after the transcript backgrounded its call", () =>
    runAgyBackgroundScenario("agy-background-late-pre-tool", (io) =>
      Effect.gen(function* () {
        io.transcript(agyRunningStep(997), agyText(998, "Dumping native overlay hierarchy."));
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        const args = JSON.stringify({ CommandLine: agyCommand, WaitMsBeforeAsync: "5000" });
        const toolCall = `"toolCall":{"name":"run_command","args":${args}}`;
        io.hooks(`pre-tool	{"stepIdx":996,${toolCall}}`, 'stop	{"stepIdx":998}');
        yield* Effect.sleep("200 millis");
        expect(io.counts.teardowns).toBe(0);

        io.transcript(agyCompletionStep(999), agyText(1000, "Overlay dumped."));
        yield* io.waitUntil(() => io.counts.assistantMessages === 2);
        // The post-tool reports the background start without a task id.
        io.hooks(
          `post-tool	{"stepIdx":996,${toolCall},"toolOutput":"Command sent to the background"}`,
          'stop	{"stepIdx":1000}',
        );
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it("ignores an anonymous late post-tool start when the pre-tool hook was lost", () =>
    runAgyBackgroundScenario("agy-background-anonymous-late-post-tool", (io) =>
      Effect.gen(function* () {
        io.transcript(agyRunningStep(997), agyText(998, "Dumping native overlay hierarchy."));
        io.hooks('stop	{"stepIdx":998}');
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        yield* Effect.sleep("200 millis");
        expect(io.counts.teardowns).toBe(0);

        io.transcript(agyCompletionStep(999), agyText(1000, "Overlay dumped."));
        yield* io.waitUntil(() => io.counts.assistantMessages === 2);
        const args = JSON.stringify({ CommandLine: agyCommand, WaitMsBeforeAsync: "5000" });
        io.hooks(
          `post-tool	{"stepIdx":996,"toolCall":{"name":"run_command","args":${args}},"toolOutput":"Command sent to the background"}`,
          'stop	{"stepIdx":1000}',
        );
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it("reconciles an anonymous post-tool start batched before the transcript step", () =>
    runAgyBackgroundScenario("agy-background-batched-anonymous", (io) =>
      Effect.gen(function* () {
        const args = JSON.stringify({ CommandLine: agyCommand, WaitMsBeforeAsync: "5000" });
        const toolCall = `"toolCall":{"name":"run_command","args":${args}}`;
        // The command finished before the next poll: one hook batch holds the
        // pre-tool, an id-less post-tool and the Stop, and the transcript already
        // holds the background step, the wait message and the completion.
        io.hooks(
          `pre-tool	{"stepIdx":996,${toolCall}}`,
          `post-tool	{"stepIdx":996,${toolCall},"toolOutput":"Command sent to the background"}`,
          'stop	{"stepIdx":998}',
        );
        io.transcript(
          agyRunningStep(997),
          agyText(998, "Dumping native overlay hierarchy."),
          agyCompletionStep(999),
          agyText(1000, "Overlay dumped."),
        );
        yield* io.waitUntil(() => io.counts.assistantMessages === 2);
        io.hooks('stop	{"stepIdx":1000}');
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it("marks the pending call named by the task description when a step issued several", () =>
    runAgyBackgroundScenario("agy-background-two-calls-one-step", (io) =>
      Effect.gen(function* () {
        const quick = JSON.stringify({ CommandLine: '"adb devices"', WaitMsBeforeAsync: "5000" });
        const slow = JSON.stringify({ CommandLine: `"${agyCommand}"`, WaitMsBeforeAsync: "5000" });
        io.hooks(
          `pre-tool	{"stepIdx":996,"toolCall":{"name":"run_command","args":${quick}}}`,
          `pre-tool	{"stepIdx":996,"toolCall":{"name":"run_command","args":${slow}}}`,
        );
        io.transcript(agyRunningStep(997), agyText(998, "Dumping native overlay hierarchy."));
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        // The backgrounded call reports first, out of issue order.
        io.hooks(
          `post-tool	{"stepIdx":996,"toolCall":{"name":"run_command","args":${slow}},"toolOutput":"Command sent to the background"}`,
          `post-tool	{"stepIdx":996,"toolCall":{"name":"run_command","args":${quick}},"toolOutput":"The command exited with code 0."}`,
          'stop	{"stepIdx":998}',
        );
        yield* Effect.sleep("200 millis");
        expect(io.counts.teardowns).toBe(0);

        io.transcript(agyCompletionStep(999), agyText(1000, "Overlay dumped."));
        yield* io.waitUntil(() => io.counts.assistantMessages === 2);
        io.hooks('stop	{"stepIdx":1000}');
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it("keeps the transcript marker for the backgrounded call when hooks arrive late", () =>
    runAgyBackgroundScenario("agy-background-late-hooks-two-calls", (io) =>
      Effect.gen(function* () {
        const quickArgs = { CommandLine: '"adb devices"', WaitMsBeforeAsync: "5000" };
        const slowArgs = { CommandLine: `"${agyCommand}"`, WaitMsBeforeAsync: "5000" };
        // The transcript surfaces both calls before any hook is read, so the
        // late pre-tool hooks open no pending lifecycle.
        io.transcript(
          {
            step_index: 996,
            type: "PLANNER_RESPONSE",
            tool_calls: [
              { name: "run_command", args: quickArgs },
              { name: "run_command", args: slowArgs },
            ],
          },
          agyRunningStep(997),
          agyText(998, "Dumping native overlay hierarchy."),
        );
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        const quick = JSON.stringify(quickArgs);
        const slow = JSON.stringify(slowArgs);
        io.hooks(
          `pre-tool\t{"stepIdx":996,"toolCall":{"name":"run_command","args":${quick}}}`,
          `pre-tool\t{"stepIdx":996,"toolCall":{"name":"run_command","args":${slow}}}`,
          `post-tool\t{"stepIdx":996,"toolCall":{"name":"run_command","args":${quick}},"toolOutput":"The command exited with code 0."}`,
          `post-tool\t{"stepIdx":996,"toolCall":{"name":"run_command","args":${slow}},"toolOutput":"Command sent to the background"}`,
          'stop\t{"stepIdx":998}',
        );
        yield* Effect.sleep("200 millis");
        expect(io.counts.teardowns).toBe(0);

        io.transcript(agyCompletionStep(999), agyText(1000, "Overlay dumped."));
        yield* io.waitUntil(() => io.counts.assistantMessages === 2);
        io.hooks('stop\t{"stepIdx":1000}');
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it.each([
    { preHooks: "before", foregroundFirst: false },
    { preHooks: "before", foregroundFirst: true },
    { preHooks: "after", foregroundFirst: false },
    { preHooks: "after", foregroundFirst: true },
    { preHooks: "after-no-planner", foregroundFirst: false },
    { preHooks: "after-no-planner", foregroundFirst: true },
    { preHooks: "split", foregroundFirst: false },
    { preHooks: "split", foregroundFirst: true },
  ])(
    "reconciles a background start without a description ($preHooks pre-hooks, foreground first: $foregroundFirst)",
    ({ preHooks, foregroundFirst }) =>
      runAgyBackgroundScenario(`no-description-${preHooks}-${foregroundFirst}`, (io) =>
        Effect.gen(function* () {
          const calls = [
            { name: "run_command", args: { CommandLine: "echo foreground" } },
            { name: "run_command", args: { CommandLine: agyCommand } },
          ];
          const pre = calls.map(
            (toolCall) => `pre-tool\t${JSON.stringify({ stepIdx: 996, toolCall })}`,
          );
          if (preHooks === "before") io.hooks(...pre);
          if (preHooks === "split") io.hooks(pre[0]!);
          io.transcript(
            ...(preHooks === "after-no-planner"
              ? []
              : [{ step_index: 996, type: "PLANNER_RESPONSE", tool_calls: calls }]),
            {
              ...agyRunningStep(997),
              content: `Tool is running as a background task with task id: ${agyTaskId}`,
            },
            agyText(998, "Waiting for the background command."),
          );
          yield* io.waitUntil(() => io.counts.assistantMessages === 1);
          if (preHooks === "after" || preHooks === "after-no-planner") io.hooks(...pre);
          if (preHooks === "split") io.hooks(pre[1]!);
          const post = calls.map(
            (toolCall, index) =>
              `post-tool\t${JSON.stringify({ stepIdx: 996, toolCall, toolOutput: index === 0 ? "The command exited with code 0." : "Command sent to the background" })}`,
          );
          io.hooks(...(foregroundFirst ? post : post.toReversed()), 'stop\t{"stepIdx":998}');
          yield* Effect.sleep("200 millis");
          expect(io.counts.teardowns).toBe(0);
          expect(io.taskEvents).toEqual([{ type: "task.started", taskId: agyTaskId }]);

          io.transcript(agyCompletionStep(999), agyText(1000, "Done."));
          io.hooks('stop\t{"stepIdx":1000}');
          yield* io.waitUntil(() => io.counts.teardowns === 1);
          expect(io.taskEvents).toEqual([
            { type: "task.started", taskId: agyTaskId },
            { type: "task.completed", taskId: agyTaskId },
          ]);
        }),
      ),
  );

  it("does not consume a description-less marker for a different named background task", () =>
    runAgyBackgroundScenario("no-description-other-task", (io) =>
      Effect.gen(function* () {
        const calls = [
          { name: "run_command", args: { CommandLine: agyCommand } },
          { name: "run_command", args: { CommandLine: "npm run build" } },
        ];
        io.hooks(
          ...calls.map((toolCall) => `pre-tool\t${JSON.stringify({ stepIdx: 996, toolCall })}`),
        );
        io.transcript(
          { step_index: 996, type: "PLANNER_RESPONSE", tool_calls: calls },
          {
            ...agyRunningStep(997),
            content: `Tool is running as a background task with task id: ${agyTaskId}`,
          },
          agyText(998, "Waiting for both commands."),
        );
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        io.hooks(
          `post-tool\t${JSON.stringify({ stepIdx: 996, toolCall: calls[1], toolOutput: "Task id 'task-other' is running in the background" })}`,
          `post-tool\t${JSON.stringify({ stepIdx: 996, toolCall: calls[0], toolOutput: "Command sent to the background" })}`,
        );
        io.transcript(agyCompletionStep(999), agyText(1000, "The build is still running."));
        io.hooks('stop\t{"stepIdx":1000}');
        yield* io.waitUntil(() => io.counts.assistantMessages === 2);
        yield* Effect.sleep("150 millis");
        expect(io.counts.teardowns).toBe(0);
        expect(io.taskEvents).toEqual([
          { type: "task.started", taskId: agyTaskId },
          { type: "task.started", taskId: "task-other" },
          { type: "task.completed", taskId: agyTaskId },
        ]);
        io.transcript(agyCompletionStep(1001, "task-other"), agyText(1002, "Done."));
        io.hooks('stop\t{"stepIdx":1002}');
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it.each(["matched", "unmatched", "missing-description"])(
    "derives the background task type from its planner command before hooks arrive (%s)",
    (scenario) =>
      runAgyBackgroundScenario(`planner-command-${scenario}`, (io) =>
        Effect.gen(function* () {
          const running = agyRunningStep(997);
          io.transcript(
            {
              step_index: 996,
              type: "PLANNER_RESPONSE",
              tool_calls: [
                { name: "search_web", args: { Query: "overlay" } },
                { name: "write_to_file", args: { TargetFile: "/tmp/overlay.txt" } },
                ...(scenario === "unmatched"
                  ? []
                  : [{ name: "run_command", args: { CommandLine: `"${agyCommand}"` } }]),
              ],
            },
            scenario === "missing-description"
              ? {
                  ...running,
                  content: `Tool is running as a background task with task id: ${agyTaskId}`,
                }
              : running,
            agyText(998, "Waiting for the command."),
          );
          yield* io.waitUntil(() => io.counts.assistantMessages === 1);
          expect(io.taskStarts).toEqual([
            {
              taskType: "command_execution",
              source: expect.objectContaining({ taskId: agyTaskId, name: "run_command" }),
            },
          ]);
          io.hooks('stop\t{"stepIdx":998}');
          yield* Effect.sleep("150 millis");
          expect(io.counts.teardowns).toBe(0);
          io.transcript(agyCompletionStep(999), agyText(1000, "Done."));
          io.hooks('stop\t{"stepIdx":1000}');
          yield* io.waitUntil(() => io.counts.teardowns === 1);
        }),
      ),
  );

  it("preserves the sole schedule planner call when hooks have not arrived", () =>
    runAgyBackgroundScenario("schedule-no-hooks", (io) =>
      Effect.gen(function* () {
        io.transcript(
          {
            step_index: 996,
            type: "PLANNER_RESPONSE",
            tool_calls: [{ name: "schedule", args: { Prompt: "remind me" } }],
          },
          {
            step_index: 997,
            type: "GENERIC",
            status: "RUNNING",
            content:
              "Tool is running as a background task with task id: session/task-997\nTask Description: remind me",
          },
          agyText(998, "Timer started."),
        );
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        expect(io.taskStarts).toEqual([
          { taskType: "dynamic_tool_call", source: expect.objectContaining({ name: "schedule" }) },
        ]);
        io.transcript(agyCompletionStep(999, "session/task-997"), agyText(1000, "Timer finished."));
        io.hooks('stop\t{"stepIdx":1000}');
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it.each(["session/task-8", "session:task-8"])(
    "reconciles qualified id %s in a delayed post-tool output",
    (taskId) =>
      runAgyBackgroundScenario(`qualified-post-id-${taskId.replaceAll(/[^\w]/g, "-")}`, (io) =>
        Effect.gen(function* () {
          io.transcript(agyRunningStep(8, taskId), agyText(9, "Waiting for command."));
          yield* io.waitUntil(() => io.counts.assistantMessages === 1);
          io.hooks(
            `post-tool\t${JSON.stringify({ stepIdx: 7, toolCall: { name: "run_command", args: { CommandLine: agyCommand } }, toolOutput: `Task id '${taskId}' is running in the background` })}`,
          );
          io.transcript(agyCompletionStep(10, taskId), agyText(11, "Done."));
          io.hooks('stop\t{"stepIdx":11}');
          yield* io.waitUntil(() => io.counts.assistantMessages === 2);
          expect(io.taskEvents).toEqual([
            { type: "task.started", taskId: taskId },
            { type: "task.completed", taskId: taskId },
          ]);
          yield* io.waitUntil(() => io.counts.teardowns === 1);
        }),
      ),
  );

  it("tracks a transcript background task once when post-tool reports it too", () =>
    runAgyBackgroundScenario("agy-background-dedupe", (io) =>
      Effect.gen(function* () {
        io.transcript(agyRunningStep(6, "session-a/task-6"), agyText(7, "Waiting for the build."));
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        io.hooks(
          `post-tool\t{"stepIdx":5,"toolCall":{"name":"run_command","args":{"CommandLine":"npm run build","WaitMsBeforeAsync":"5000"}},"toolOutput":"Task id 'task-6' is running in the background"}`,
          'stop\t{"stepIdx":7}',
        );
        yield* Effect.sleep("200 millis");
        expect(io.counts.teardowns).toBe(0);

        io.transcript(agyCompletionStep(8, "session-a/task-6"), agyText(9, "Build done."));
        io.hooks('stop\t{"stepIdx":9}');
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it("settles a transcript background task whose completion was read first", () =>
    runAgyBackgroundScenario("agy-background-early-completion", (io) =>
      Effect.gen(function* () {
        io.transcript(
          agyCompletionStep(9, "session-b/task-8"),
          agyRunningStep(8, "session-b/task-8"),
          agyText(10, "Command finished."),
        );
        io.hooks('stop\t{"stepIdx":10}');
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it("retains a completion consumed before an anonymous task receives its transcript id", () =>
    runAgyBackgroundScenario("audit-anonymous-early-completion", (io) =>
      Effect.gen(function* () {
        const args = JSON.stringify({ CommandLine: agyCommand, WaitMsBeforeAsync: "5000" });
        const toolCall = `"toolCall":{"name":"run_command","args":${args}}`;
        io.hooks(
          `pre-tool\t{"stepIdx":7,${toolCall}}`,
          `post-tool\t{"stepIdx":7,${toolCall},"toolOutput":"Command sent to the background"}`,
          'stop\t{"stepIdx":10}',
        );
        io.transcript(
          agyCompletionStep(9, "session-b/task-8"),
          agyRunningStep(8, "session-b/task-8"),
          agyText(10, "Command finished."),
        );
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        yield* Effect.sleep("250 millis");
        expect(io.counts.teardowns).toBe(1);
        expect(io.taskEvents).toEqual([
          { type: "task.started", taskId: "session-b/task-8" },
          { type: "task.completed", taskId: "session-b/task-8" },
        ]);
      }),
    ));

  it.each([false, true])(
    "keeps another anonymous task pending after early completion (reverse starts: %s)",
    (reverseStarts) =>
      runAgyBackgroundScenario(`early-completion-two-${reverseStarts}`, (io) =>
        Effect.gen(function* () {
          for (const stepIdx of [7, 17]) {
            io.hooks(
              `post-tool\t${JSON.stringify({ stepIdx, toolCall: { name: "run_command", args: { CommandLine: agyCommand } }, toolOutput: "Command sent to the background" })}`,
            );
          }
          const starts = [
            agyRunningStep(8, "session/task-8"),
            agyRunningStep(18, "session/task-18"),
          ];
          io.transcript(
            agyCompletionStep(9, "session/task-8"),
            ...(reverseStarts ? starts.reverse() : starts),
            agyText(20, "The other command is still running."),
          );
          io.hooks('stop\t{"stepIdx":20}');
          yield* io.waitUntil(() => io.counts.assistantMessages === 1);
          expect(io.taskEvents.filter((event) => event.type === "task.completed")).toEqual([
            { type: "task.completed", taskId: "session/task-8" },
          ]);
          yield* Effect.sleep("150 millis");
          expect(io.counts.teardowns).toBe(0);
          io.transcript(
            agyCompletionStep(21, "session/task-18"),
            agyText(22, "Both commands completed."),
          );
          io.hooks('stop\t{"stepIdx":22}');
          yield* io.waitUntil(() => io.counts.teardowns === 1);
          expect(io.taskEvents.filter((event) => event.type === "task.completed")).toEqual([
            { type: "task.completed", taskId: "session/task-8" },
            { type: "task.completed", taskId: "session/task-18" },
          ]);
        }),
      ),
  );

  it.each([false, true])(
    "does not spend an unrelated named completion on an anonymous command (anonymous named first: %s)",
    (anonymousNamedFirst) =>
      runAgyBackgroundScenario(`early-completion-unrelated-${anonymousNamedFirst}`, (io) =>
        Effect.gen(function* () {
          io.hooks(
            `post-tool\t${JSON.stringify({ stepIdx: 7, toolCall: { name: "run_command", args: { CommandLine: agyCommand } }, toolOutput: "Command sent to the background" })}`,
          );
          io.transcript(
            agyCompletionStep(19, "session/task-18"),
            ...(anonymousNamedFirst ? [agyRunningStep(8, "session/task-8")] : []),
            agyRunningStep(18, "session/task-18"),
            agyText(20, "The anonymous command is still running."),
          );
          io.hooks('stop\t{"stepIdx":20}');
          yield* io.waitUntil(() => io.counts.assistantMessages === 1);
          expect(io.taskEvents.filter((event) => event.type === "task.completed")).toEqual([
            { type: "task.completed", taskId: "session/task-18" },
          ]);
          yield* Effect.sleep("150 millis");
          expect(io.counts.teardowns).toBe(0);
          io.transcript(
            ...(!anonymousNamedFirst ? [agyRunningStep(8, "session/task-8")] : []),
            agyCompletionStep(21, "session/task-8"),
            agyText(22, "All done."),
          );
          io.hooks('stop\t{"stepIdx":22}');
          yield* io.waitUntil(() => io.counts.teardowns === 1);
        }),
      ),
  );

  it.each(["completed", "killed"])(
    "keeps an anonymous command alive when an unrelated task is %s before Stop and its delayed start",
    (terminalState) =>
      runAgyBackgroundScenario(`unrelated-terminal-before-stop-${terminalState}`, (io) =>
        Effect.gen(function* () {
          io.hooks(
            `post-tool\t${JSON.stringify({ stepIdx: 7, toolCall: { name: "run_command", args: { CommandLine: agyCommand } }, toolOutput: "Command sent to the background" })}`,
          );
          if (terminalState === "completed") {
            io.transcript(agyCompletionStep(19, "session/task-18"));
          } else {
            io.hooks(
              'post-tool\t{"stepIdx":19,"toolCall":{"name":"manage_task","args":{"Action":"kill","TaskId":"task-18"}},"toolOutput":"killed"}',
            );
          }
          io.transcript(agyText(20, "The anonymous command is still running."));
          io.hooks('stop\t{"stepIdx":20}');
          yield* io.waitUntil(() => io.counts.assistantMessages === 1);
          yield* Effect.sleep("150 millis");
          expect(io.counts.teardowns).toBe(0);
          expect(io.taskEvents).toEqual([]);

          // Identifying the unrelated terminal still must not settle task-8.
          io.transcript(agyRunningStep(18, "session/task-18"), agyText(21, "Still waiting."));
          io.hooks('stop\t{"stepIdx":21}');
          yield* io.waitUntil(() => io.counts.assistantMessages === 2);
          yield* Effect.sleep("150 millis");
          expect(io.counts.teardowns).toBe(0);

          io.transcript(
            agyRunningStep(8, "session/task-8"),
            agyCompletionStep(22, "session/task-8"),
            agyText(23, "All done."),
          );
          io.hooks('stop\t{"stepIdx":23}');
          yield* io.waitUntil(() => io.counts.teardowns === 1);
          expect(io.taskEvents.filter((event) => event.type === "task.completed")).toEqual([
            ...(terminalState === "completed"
              ? [{ type: "task.completed", taskId: "session/task-18" }]
              : []),
            { type: "task.completed", taskId: "session/task-8" },
          ]);
        }),
      ),
  );

  it.each([7, undefined])(
    "does not credit a later anonymous command with an old completion (first hook step: %s)",
    (stepIdx) =>
      runAgyBackgroundScenario(`early-completion-later-${stepIdx}`, (io) =>
        Effect.gen(function* () {
          io.hooks(
            `post-tool\t${JSON.stringify({ stepIdx, toolCall: { name: "run_command", args: { CommandLine: agyCommand } }, toolOutput: "Command sent to the background" })}`,
          );
          io.transcript(
            agyCompletionStep(19, "session/task-18"),
            agyRunningStep(8, "session/task-8"),
            agyText(20, "First command is running."),
          );
          yield* io.waitUntil(() => io.counts.assistantMessages === 1);
          io.hooks(
            `post-tool\t${JSON.stringify({ stepIdx: 27, toolCall: { name: "run_command", args: { CommandLine: agyCommand } }, toolOutput: "Command sent to the background" })}`,
          );
          io.transcript(
            agyCompletionStep(21, "session/task-8"),
            agyText(30, "New command is still running."),
          );
          io.hooks('stop\t{"stepIdx":30}');
          yield* io.waitUntil(() => io.counts.assistantMessages === 2);
          yield* Effect.sleep("150 millis");
          expect(io.counts.teardowns).toBe(0);
          io.transcript(
            agyRunningStep(18, "session/task-18"),
            agyCompletionStep(29, "session/task-28"),
            agyRunningStep(28, "session/task-28"),
            agyText(31, "Everything completed."),
          );
          io.hooks('stop\t{"stepIdx":31}');
          yield* io.waitUntil(() => io.counts.teardowns === 1);
          expect(io.taskEvents.filter((event) => event.type === "task.completed")).toEqual([
            { type: "task.completed", taskId: "session/task-8" },
            { type: "task.completed", taskId: "session/task-18" },
            { type: "task.completed", taskId: "session/task-28" },
          ]);
        }),
      ),
  );

  it("does not use a repeated completion to settle a second anonymous command", () =>
    runAgyBackgroundScenario("early-completion-duplicate", (io) =>
      Effect.gen(function* () {
        for (const stepIdx of [7, 17]) {
          io.hooks(
            `post-tool\t${JSON.stringify({ stepIdx, toolCall: { name: "run_command", args: { CommandLine: agyCommand } }, toolOutput: "Command sent to the background" })}`,
          );
        }
        io.transcript(
          agyCompletionStep(9, "session/task-8"),
          agyCompletionStep(10, "task-8"),
          agyRunningStep(8, "session/task-8"),
          agyText(20, "Second command is still running."),
        );
        io.hooks('stop\t{"stepIdx":20}');
        yield* io.waitUntil(() => io.counts.assistantMessages === 1);
        expect(io.taskEvents.filter((event) => event.type === "task.completed")).toEqual([
          { type: "task.completed", taskId: "session/task-8" },
        ]);
        yield* Effect.sleep("150 millis");
        expect(io.counts.teardowns).toBe(0);
        io.transcript(
          agyCompletionStep(21, "session/task-18"),
          agyRunningStep(18, "session/task-18"),
          agyText(22, "All done."),
        );
        io.hooks('stop\t{"stepIdx":22}');
        yield* io.waitUntil(() => io.counts.teardowns === 1);
      }),
    ));

  it.each(["completed", "killed"])(
    "does not reopen a %s hook task when its first transcript start arrives late",
    (terminalState) =>
      runAgyBackgroundScenario(`late-transcript-${terminalState}`, (io) =>
        Effect.gen(function* () {
          io.hooks(
            `post-tool\t${JSON.stringify({ stepIdx: 7, toolCall: { name: "run_command", args: { CommandLine: agyCommand } }, toolOutput: terminalState === "completed" ? "Task id 'task-8' is running in the background" : "Command sent to the background" })}`,
          );
          if (terminalState === "completed") {
            io.transcript(agyCompletionStep(9, "session/task-8"));
          } else {
            io.hooks(
              'post-tool\t{"stepIdx":9,"toolCall":{"name":"manage_task","args":{"Action":"kill","TaskId":"task-8"}},"toolOutput":"killed"}',
            );
          }
          io.transcript(agyText(10, "The command is no longer running."));
          yield* io.waitUntil(() => io.counts.assistantMessages === 1);
          const settledEvents = [...io.taskEvents];
          io.transcript(agyRunningStep(8, "session/task-8"), agyText(11, "Done."));
          io.hooks('stop\t{"stepIdx":11}');
          yield* io.waitUntil(() => io.counts.teardowns === 1);
          expect(io.taskEvents).toEqual(settledEvents);
        }),
      ),
  );

  it.each([8, 18])(
    "does not lose another anonymous command when task-%s is killed before its transcript start",
    (killedStep) =>
      runAgyBackgroundScenario(`killed-anonymous-pair-${killedStep}`, (io) =>
        Effect.gen(function* () {
          for (const stepIdx of [7, 17]) {
            io.hooks(
              `post-tool\t${JSON.stringify({ stepIdx, toolCall: { name: "run_command", args: { CommandLine: agyCommand } }, toolOutput: "Command sent to the background" })}`,
            );
          }
          io.hooks(
            `post-tool\t${JSON.stringify({ stepIdx: 19, toolCall: { name: "manage_task", args: { Action: "kill", TaskId: `task-${killedStep}` } }, toolOutput: "killed" })}`,
          );
          io.transcript(
            agyRunningStep(killedStep, `session/task-${killedStep}`),
            agyText(20, "The other command is still running."),
          );
          io.hooks('stop\t{"stepIdx":20}');
          yield* io.waitUntil(() => io.counts.assistantMessages === 1);
          yield* Effect.sleep("150 millis");
          expect(io.counts.teardowns).toBe(0);
          expect(io.taskEvents).toEqual([]);
          const remainingStep = killedStep === 8 ? 18 : 8;
          io.transcript(
            agyRunningStep(remainingStep, `session/task-${remainingStep}`),
            agyCompletionStep(21, `session/task-${remainingStep}`),
            agyText(22, "Done."),
          );
          io.hooks('stop\t{"stepIdx":22}');
          yield* io.waitUntil(() => io.counts.teardowns === 1);
          expect(io.taskEvents).toEqual([
            { type: "task.started", taskId: `session/task-${remainingStep}` },
            { type: "task.completed", taskId: `session/task-${remainingStep}` },
          ]);
        }),
      ),
  );

  it.each([false, true])(
    "retains more than 32 early completions (anonymous hooks: %s)",
    (anonymousHooks) =>
      runAgyBackgroundScenario(`early-completion-many-${anonymousHooks}`, (io) =>
        Effect.gen(function* () {
          const taskCount = 33;
          if (anonymousHooks) {
            for (let index = 0; index < taskCount; index += 1) {
              io.hooks(
                `post-tool\t${JSON.stringify({ stepIdx: index * 3, toolCall: { name: "run_command", args: { CommandLine: agyCommand } }, toolOutput: "Command sent to the background" })}`,
              );
            }
          }
          for (let index = 0; index < taskCount; index += 1) {
            io.transcript(agyCompletionStep(index * 3 + 2, `session/task-${index}`));
          }
          for (let index = 0; index < taskCount; index += 1) {
            io.transcript(agyRunningStep(index * 3 + 1, `session/task-${index}`));
          }
          io.transcript(agyText(100, "All commands completed."));
          io.hooks('stop\t{"stepIdx":100}');
          yield* io.waitUntil(() => io.counts.assistantMessages === 1);
          expect(io.taskEvents.filter((event) => event.type === "task.started")).toHaveLength(
            taskCount,
          );
          expect(io.taskEvents.filter((event) => event.type === "task.completed")).toHaveLength(
            taskCount,
          );
          yield* io.waitUntil(() => io.counts.teardowns === 1);
        }),
      ),
  );

  it("ignores the old stop hook after a transcript read outlives its turn", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-audit1170-stale-stop-"));
    const transcriptFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcriptFile, "");
    const children: ChildProcess[] = [];
    const teardowns: number[] = [];
    let eventFile: string | undefined;
    let blocked = false;
    let started!: () => void;
    let release!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const readRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      children.push(child);
      return child;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const readCompleteLines: NonNullable<
      AntigravityAdapterDependencies["readCompleteLines"]
    > = async (file, offset) => {
      const batch = await readCompleteAntigravityLines(file, offset);
      if (file === transcriptFile && !blocked) {
        blocked = true;
        started();
        await readRelease;
      }
      return batch;
    };
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const events = yield* adapter.streamEvents.pipe(Stream.runDrain, Effect.forkChild);
          const threadId = ThreadId.makeUnsafe("audit-stale-stop");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
          fsSync.appendFileSync(
            eventFile!,
            `pre-invocation\t${JSON.stringify({ transcriptPath: transcriptFile })}\nstop\t{"stepIdx":10}\n`,
          );
          yield* Effect.promise(() => readStarted).pipe(Effect.timeout("2 seconds"));
          yield* adapter.interruptTurn(threadId);
          expect(teardowns).toEqual([0]);
          yield* adapter.sendTurn({ threadId, input: "second", attachments: [] });
          release();
          yield* Effect.sleep("200 millis");
          expect(teardowns).toEqual([0]);
          yield* adapter.stopSession(threadId);
          yield* Fiber.interrupt(events);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              readCompleteLines,
              teardownProcessTree: async (child) => {
                teardowns.push(children.findIndex((candidate) => candidate === child));
                return completeProcessTeardown();
              },
            }).pipe(
              Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "audit-stale-stop-" })),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      release();
      for (const child of children) child.emit("close", 0, null);
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("performs a fresh final hook drain when the process closes during a poll", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-final-drain-"));
    const transcriptFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcriptFile, "");

    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    let blockNextTranscriptRead = false;
    let transcriptReadBlocked = false;
    let resolveTranscriptReadStarted = (): void => undefined;
    const transcriptReadStarted = new Promise<void>((resolve) => {
      resolveTranscriptReadStarted = resolve;
    });
    let releaseTranscriptRead = (): void => undefined;
    const transcriptReadRelease = new Promise<void>((resolve) => {
      releaseTranscriptRead = resolve;
    });
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const readCompleteLines: NonNullable<
      AntigravityAdapterDependencies["readCompleteLines"]
    > = async (filePath, offset) => {
      if (filePath === transcriptFile && blockNextTranscriptRead && !transcriptReadBlocked) {
        transcriptReadBlocked = true;
        resolveTranscriptReadStarted();
        await transcriptReadRelease;
      }
      return readCompleteAntigravityLines(filePath, offset);
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const turnCompleted = yield* Deferred.make<void>();
          const itemsObserved = yield* Deferred.make<void>();
          const itemEventTypes: string[] = [];
          const itemEventTitles: string[] = [];
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                if (event.type === "item.started" || event.type === "item.completed") {
                  itemEventTypes.push(event.type);
                  itemEventTitles.push(event.payload.title ?? "");
                  if (itemEventTypes.length === 2) {
                    yield* Deferred.succeed(itemsObserved, undefined);
                  }
                }
                if (event.type === "turn.completed") {
                  yield* Deferred.succeed(turnCompleted, undefined);
                }
              }),
            ),
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-final-drain");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            runtimeMode: "full-access",
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          yield* adapter.sendTurn({ threadId, input: "list files", attachments: [] });
          blockNextTranscriptRead = true;
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              `pre-invocation\t${JSON.stringify({
                conversationId: "conversation-final-drain",
                transcriptPath: transcriptFile,
              })}\n`,
            ),
          );
          yield* Effect.promise(() => transcriptReadStarted).pipe(Effect.timeout("2 seconds"));
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                'pre-tool\t{"stepIdx":1,"toolCall":{"name":"list_files","args":{"Path":"."}}}',
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"list_files","args":{"Path":"."}},"toolOutput":"ok"}',
                'stop\t{"stepIdx":2}',
                "",
              ].join("\n"),
            ),
          );
          child?.emit("close", 0, null);
          releaseTranscriptRead();

          yield* Deferred.await(itemsObserved).pipe(Effect.timeout("2 seconds"));
          yield* Deferred.await(turnCompleted).pipe(Effect.timeout("2 seconds"));
          expect(itemEventTypes).toEqual(["item.started", "item.completed"]);
          expect(itemEventTitles).toEqual(["list_files", "list_files"]);
          yield* Fiber.interrupt(eventsFiber);
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              readCompleteLines,
              spawnProcess,
              teardownProcessTree: completeProcessTeardown,
            }).pipe(
              Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "final-drain-" })),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("ignores a hook poll that resumes after session replacement", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-stale-poll-"));
    const transcriptFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcriptFile, "");

    let eventFile: string | undefined;
    let blockedEventFile: string | undefined;
    let replacementEventFile: string | undefined;
    let hookReadBlocked = false;
    let resolveHookReadStarted = (): void => undefined;
    const hookReadStarted = new Promise<void>((resolve) => {
      resolveHookReadStarted = resolve;
    });
    let releaseHookRead = (): void => undefined;
    const hookReadRelease = new Promise<void>((resolve) => {
      releaseHookRead = resolve;
    });
    let resolveReplacementPoll = (): void => undefined;
    const replacementPollObserved = new Promise<void>((resolve) => {
      resolveReplacementPoll = resolve;
    });
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    const readCompleteLines: NonNullable<
      AntigravityAdapterDependencies["readCompleteLines"]
    > = async (filePath, offset) => {
      const batch = await readCompleteAntigravityLines(filePath, offset);
      if (filePath === blockedEventFile && !hookReadBlocked) {
        hookReadBlocked = true;
        resolveHookReadStarted();
        await hookReadRelease;
      }
      if (filePath === replacementEventFile) resolveReplacementPoll();
      return batch;
    };

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const staleTaskIds: string[] = [];
          const eventsFiber = yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "task.started") staleTaskIds.push(event.payload.taskId);
              }),
            ),
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-stale-poll");
          const sessionInput = {
            provider: "antigravity" as const,
            threadId,
            runtimeMode: "full-access" as const,
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          };
          yield* adapter.startSession(sessionInput);
          yield* adapter.sendTurn({ threadId, input: "start a task", attachments: [] });
          blockedEventFile = eventFile;
          yield* Effect.promise(() =>
            fs.appendFile(
              blockedEventFile!,
              [
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}},"toolOutput":"Task id \'task-stale\' is now running in the background"}',
                "",
              ].join("\n"),
            ),
          );
          yield* Effect.promise(() => hookReadStarted).pipe(Effect.timeout("2 seconds"));

          yield* adapter.startSession(sessionInput);
          releaseHookRead();
          yield* adapter.sendTurn({ threadId, input: "replacement turn", attachments: [] });
          replacementEventFile = eventFile;
          yield* Effect.promise(() => replacementPollObserved).pipe(Effect.timeout("2 seconds"));

          expect(staleTaskIds).toEqual([]);
          yield* Fiber.interrupt(eventsFiber);
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              readCompleteLines,
              spawnProcess,
              teardownProcessTree: completeProcessTeardown,
            }).pipe(
              Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "stale-poll-" })),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("settles pending background tasks on session replacement and process exit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-background-restart-"));
    const transcriptFile = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcriptFile, "");
    let eventFile: string | undefined;
    let child: ChildProcess | undefined;
    const spawnProcess = ((
      _command: string,
      _args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      eventFile = options.env?.SYNARA_ANTIGRAVITY_EVENTS;
      const spawned = new EventEmitter() as ChildProcess;
      Object.assign(spawned, {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      });
      child = spawned;
      return spawned;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const firstTaskStarted = yield* Deferred.make<void>();
          const conversationReady = yield* Deferred.make<void>();
          const completionBuffered = yield* Deferred.make<void>();
          const bufferedTaskCompleted = yield* Deferred.make<void>();
          const secondTurnCompleted = yield* Deferred.make<void>();
          const exitTaskStarted = yield* Deferred.make<void>();
          const taskEventsFiber = yield* adapter.streamEvents.pipe(
            Stream.tap((event) =>
              Effect.all(
                [
                  event.type === "task.started" && event.payload.taskId === "task-restart"
                    ? Deferred.succeed(firstTaskStarted, undefined)
                    : Effect.void,
                  event.type === "thread.started" &&
                  event.payload.providerThreadId === "conversation-background-restart"
                    ? Deferred.succeed(conversationReady, undefined)
                    : Effect.void,
                  event.type === "item.completed" && event.payload.itemType === "assistant_message"
                    ? Deferred.succeed(completionBuffered, undefined)
                    : Effect.void,
                  event.type === "task.completed" && event.payload.taskId === "task-buffered"
                    ? Deferred.succeed(bufferedTaskCompleted, undefined)
                    : Effect.void,
                  event.type === "turn.completed"
                    ? Deferred.succeed(secondTurnCompleted, undefined)
                    : Effect.void,
                  event.type === "task.started" && event.payload.taskId === "task-exit"
                    ? Deferred.succeed(exitTaskStarted, undefined)
                    : Effect.void,
                ],
                { discard: true },
              ),
            ),
            Stream.filter(
              (event) =>
                event.type === "task.started" ||
                event.type === "task.updated" ||
                event.type === "task.completed",
            ),
            Stream.take(6),
            Stream.runCollect,
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("thread-antigravity-background-restart");
          const sessionInput = {
            provider: "antigravity" as const,
            threadId,
            runtimeMode: "full-access" as const,
            cwd: root,
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          };
          yield* adapter.startSession(sessionInput);
          yield* adapter.sendTurn({ threadId, input: "run tests", attachments: [] });

          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                'pre-tool\t{"stepIdx":1,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}}}',
                'post-tool\t{"stepIdx":1,"toolCall":{"name":"run_command"},"toolOutput":"Task id \'task-restart\' is now running in the background"}',
                "",
              ].join("\n"),
            ),
          );
          yield* Deferred.await(firstTaskStarted).pipe(Effect.timeout("2 seconds"));
          yield* adapter.startSession(sessionInput);

          yield* adapter.sendTurn({ threadId, input: "run more tests", attachments: [] });
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              `pre-invocation\t${JSON.stringify({
                conversationId: "conversation-background-restart",
                transcriptPath: transcriptFile,
              })}\n`,
            ),
          );
          yield* Deferred.await(conversationReady).pipe(Effect.timeout("2 seconds"));
          yield* Effect.promise(() =>
            fs.appendFile(
              transcriptFile,
              [
                JSON.stringify({
                  step_index: 2,
                  type: "SYSTEM_MESSAGE",
                  content: "<SYSTEM_MESSAGE> Task id 'task-buffered' exited with code 0",
                }),
                JSON.stringify({
                  step_index: 3,
                  type: "PLANNER_RESPONSE",
                  content: "buffer-ready",
                }),
                "",
              ].join("\n"),
            ),
          );
          yield* Deferred.await(completionBuffered).pipe(Effect.timeout("2 seconds"));
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                'post-tool\t{"stepIdx":2,"toolCall":{"name":"run_command","args":{"CommandLine":"npm run dev","WaitMsBeforeAsync":1000}},"toolOutput":"sent to the background"}',
                'post-tool\t{"stepIdx":3,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}},"toolOutput":"Task id \'task-buffered\' is now running in the background"}',
                "",
              ].join("\n"),
            ),
          );
          yield* Deferred.await(bufferedTaskCompleted).pipe(Effect.timeout("2 seconds"));
          child?.emit("close", 0, null);
          yield* Deferred.await(secondTurnCompleted).pipe(Effect.timeout("2 seconds"));

          yield* adapter.sendTurn({ threadId, input: "run final tests", attachments: [] });
          yield* Effect.promise(() =>
            fs.appendFile(
              eventFile!,
              [
                'post-tool\t{"stepIdx":3,"toolCall":{"name":"run_command","args":{"CommandLine":"npm test","WaitMsBeforeAsync":1000}},"toolOutput":"Task id \'task-exit\' is now running in the background"}',
                "",
              ].join("\n"),
            ),
          );
          yield* Deferred.await(exitTaskStarted).pipe(Effect.timeout("2 seconds"));
          child?.emit("close", 1, null);

          const taskEvents = Array.from(
            yield* Fiber.join(taskEventsFiber).pipe(Effect.timeout("2 seconds")),
          );
          expect(taskEvents.map((event) => event.type)).toEqual([
            "task.started",
            "task.updated",
            "task.started",
            "task.completed",
            "task.started",
            "task.completed",
          ]);
          expect(taskEvents[1]?.payload).toMatchObject({
            taskId: "task-restart",
            status: "killed",
          });
          expect(taskEvents[3]?.payload).toMatchObject({
            taskId: "task-buffered",
            status: "completed",
          });
          expect(taskEvents[5]?.payload).toMatchObject({
            taskId: "task-exit",
            status: "failed",
          });
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => undefined,
              spawnProcess,
              teardownProcessTree: completeProcessTeardown,
            }).pipe(
              Layer.provideMerge(
                ServerConfig.layerTest(root, { prefix: "antigravity-background-restart-" }),
              ),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
