import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalRequestId, ThreadId } from "@synara/contracts";

import {
  buildCodexProcessEnv,
  buildCodexProcessLaunchContext,
  disableCodexConfigSections,
  readCodexSharedContinuationGeneration,
  readCodexAuthTrackingFingerprint,
  resolveCodexAuthTracking,
  resolveCodexBrowserUsePipePath,
} from "./codexProcessEnv";
import { resolveActiveCodexHomeWritePath } from "./codexHomePaths";
import { CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE } from "./provider/codexCliVersion";
import {
  buildCodexInitializeParams,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  CodexAppServerManager,
  classifyCodexStderrLine,
  isRecoverableThreadResumeError,
  normalizeCodexModelSlug,
  readCodexAuthFileFingerprint,
  readCodexAccountSnapshot,
  resolveCodexModelForAccount,
} from "./codexAppServerManager";
import { ensureIsolatedScratchWorkspace } from "./scratchWorkspaces";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function codexAuth(accountId: string, tokenVersion: string): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      account_id: accountId,
      access_token: `access-${tokenVersion}`,
      refresh_token: `refresh-${tokenVersion}`,
    },
  });
}

function readFakeCodexMethods(messagesPath: string): string[] {
  return existsSync(messagesPath)
    ? readFileSync(messagesPath, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

async function settle<T>(
  promise: Promise<T>,
): Promise<
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown }
> {
  try {
    return { status: "fulfilled", value: await promise };
  } catch (reason) {
    return { status: "rejected", reason };
  }
}

function writeFakeCodexExecutable(root: string): string {
  const binaryPath = path.join(root, "fake-codex.mjs");
  writeFileSync(
    binaryPath,
    `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
if (process.env.SYNARA_FAKE_CODEX_INVOCATIONS_PATH) {
  fs.appendFileSync(
    process.env.SYNARA_FAKE_CODEX_INVOCATIONS_PATH,
    JSON.stringify(args) + "\\n",
    "utf8",
  );
}
if (args[0] === "--version") {
  process.stdout.write((process.env.SYNARA_FAKE_CODEX_VERSION_OUTPUT ?? "codex 0.105.0") + "\\n");
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.stderr.write("unexpected command: " + JSON.stringify(args) + "\\n");
  process.exit(2);
}
if (process.env.SYNARA_FAKE_CODEX_ARGS_PATH) {
  fs.writeFileSync(process.env.SYNARA_FAKE_CODEX_ARGS_PATH, JSON.stringify(args), "utf8");
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (process.env.SYNARA_FAKE_CODEX_MESSAGES_PATH && message.method) {
    fs.appendFileSync(
      process.env.SYNARA_FAKE_CODEX_MESSAGES_PATH,
      message.method + "\\n",
      "utf8",
    );
  }
  if (message.id === undefined) return;
  if (message.method === "initialize" && process.env.SYNARA_FAKE_CODEX_EXIT_ON_INITIALIZE) {
    process.exit(Number(process.env.SYNARA_FAKE_CODEX_EXIT_ON_INITIALIZE));
  }
  if (
    message.method === "initialize" &&
    process.env.SYNARA_FAKE_CODEX_MUTATE_AUTH_PATH &&
    process.env.SYNARA_FAKE_CODEX_MUTATE_AUTH_CONTENT
  ) {
    fs.writeFileSync(
      process.env.SYNARA_FAKE_CODEX_MUTATE_AUTH_PATH,
      process.env.SYNARA_FAKE_CODEX_MUTATE_AUTH_CONTENT,
      "utf8",
    );
  }
  let result = {};
  if (message.method === "model/list") result = { data: [] };
  if (message.method === "thread/start") result = { thread: { id: "fake-provider-thread" } };
  if (message.method === "thread/fork") result = { thread: { id: "fake-forked-thread" } };
  const respond = () => {
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
  };
  if (
    message.method === "initialize" &&
    process.env.SYNARA_FAKE_CODEX_HOLD_INITIALIZE_PATH
  ) {
    const timer = setInterval(() => {
      if (!fs.existsSync(process.env.SYNARA_FAKE_CODEX_HOLD_INITIALIZE_PATH)) return;
      clearInterval(timer);
      respond();
    }, 5);
    return;
  }
  respond();
});
`,
    "utf8",
  );
  chmodSync(binaryPath, 0o755);
  return binaryPath;
}

const fullAccessTurnOverrides = {
  approvalPolicy: "never",
  sandboxPolicy: { type: "dangerFullAccess" },
} as const;
const approvalRequiredTurnOverrides = {
  approvalPolicy: "untrusted",
  sandboxPolicy: { type: "readOnly" },
} as const;

function createSendTurnHarness(runtimeMode: "approval-required" | "full-access" = "full-access") {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode,
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi
    .spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    )
    .mockResolvedValue({
      turn: {
        id: "turn_1",
      },
    });
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession };
}

function createThreadControlHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const sendRequest = vi.spyOn(
    manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
    "sendRequest",
  );
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requireSession, sendRequest, updateSession, emitEvent };
}

function createPendingUserInputHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    pendingUserInputs: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-user-input-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-user-input-1"),
          jsonRpcId: 42,
          threadId: asThreadId("thread_1"),
        },
      ],
    ]),
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
    .mockImplementation(() => {});
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, requireSession, writeMessage, emitEvent };
}

function createPendingApprovalHarness(
  runtimeMode: "approval-required" | "full-access" = "approval-required",
) {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "ready",
      threadId: "thread_1",
      runtimeMode,
      model: "gpt-5.3-codex",
      activeTurnId: undefined as string | undefined,
      resumeCursor: { threadId: "thread_1" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    pendingApprovals: new Map([
      [
        ApprovalRequestId.makeUnsafe("req-approval-1"),
        {
          requestId: ApprovalRequestId.makeUnsafe("req-approval-1"),
          jsonRpcId: 42,
          method: "item/commandExecution/requestApproval" as const,
          requestKind: "command" as const,
          threadId: asThreadId("thread_1"),
        },
      ],
    ]),
    pendingUserInputs: new Map(),
    sessionApprovalOverride: undefined as
      | undefined
      | {
          approvalPolicy: "never";
          sandboxPolicy: { type: "dangerFullAccess" };
        },
    collabReceiverTurns: new Map(),
    collabReceiverParents: new Map(),
    reviewTurnIds: new Set<string>(),
  };

  const requireSession = vi
    .spyOn(
      manager as unknown as { requireSession: (sessionId: string) => unknown },
      "requireSession",
    )
    .mockReturnValue(context);
  const writeMessage = vi
    .spyOn(manager as unknown as { writeMessage: (...args: unknown[]) => void }, "writeMessage")
    .mockImplementation(() => {});
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});
  const sendRequest = vi
    .spyOn(
      manager as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown> },
      "sendRequest",
    )
    .mockResolvedValue({
      turn: {
        id: "turn_1",
      },
    });
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return {
    manager,
    context,
    requireSession,
    writeMessage,
    emitEvent,
    sendRequest,
    updateSession,
  };
}

function createCollabNotificationHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "running",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      activeTurnId: "turn_parent",
      resumeCursor: { threadId: "provider_parent" },
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    account: {
      type: "unknown",
      planType: null,
      sparkEnabled: true,
    },
    pending: new Map(),
    pendingApprovals: new Map(),
    pendingUserInputs: new Map(),
    collabReceiverTurns: new Map<string, string>(),
    collabReceiverParents: new Map<string, string>(),
    reviewTurnIds: new Set<string>(),
    nextRequestId: 1,
    stopping: false,
  };

  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});
  const updateSession = vi
    .spyOn(manager as unknown as { updateSession: (...args: unknown[]) => void }, "updateSession")
    .mockImplementation(() => {});

  return { manager, context, emitEvent, updateSession };
}

function createProcessOutputHarness() {
  const manager = new CodexAppServerManager();
  const context = {
    session: {
      provider: "codex",
      status: "running",
      threadId: asThreadId("thread_1"),
      runtimeMode: "full-access",
      model: "gpt-5.3-codex",
      createdAt: "2026-02-10T00:00:00.000Z",
      updatedAt: "2026-02-10T00:00:00.000Z",
    },
    reviewTurnIds: new Set<string>(),
    stopping: false,
  };
  const emitEvent = vi
    .spyOn(manager as unknown as { emitEvent: (...args: unknown[]) => void }, "emitEvent")
    .mockImplementation(() => {});

  return { manager, context, emitEvent };
}

describe("classifyCodexStderrLine", () => {
  it("ignores empty lines", () => {
    expect(classifyCodexStderrLine("   ")).toBeNull();
  });

  it("ignores non-error structured codex logs", () => {
    const line =
      "2026-02-08T04:24:19.241256Z  WARN codex_core::features: unknown feature key in config: skills";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("ignores known benign rollout path errors", () => {
    const line =
      "\u001b[2m2026-02-08T04:24:20.085687Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::rollout::list\u001b[0m: state db missing rollout path for thread 019c3b6c-46b8-7b70-ad23-82f824d161fb";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("ignores token usage footers emitted during shutdown", () => {
    const line =
      "^CToken usage: total=360,953 input=336,874 (+ 4,219,648 cached) output=24,079 (reasoning 7,982)";
    expect(classifyCodexStderrLine(line)).toBeNull();
  });

  it("keeps unknown structured errors", () => {
    const line = "2026-02-08T04:24:20.085687Z ERROR codex_core::runtime: unrecoverable failure";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });

  it("keeps plain stderr messages", () => {
    const line = "fatal: permission denied";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: line,
    });
  });

  it("normalizes duplicate tool argument parse failures", () => {
    const line =
      "2026-04-11T23:48:45.012578Z ERROR codex_core::tools::router: error=failed to parse function arguments: duplicate field `yield_time_ms` at line 1 column 114";
    expect(classifyCodexStderrLine(line)).toEqual({
      message: "Tool call failed because the same argument was sent twice (yield_time_ms).",
    });
  });
});

describe("buildCodexProcessEnv", () => {
  it("hydrates the active custom provider env_key from the effective CODEX_HOME", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      writeFileSync(
        path.join(tempDir, "config.toml"),
        [
          'model_provider = "my-company-proxy"',
          "",
          '[model_providers."my-company-proxy"]',
          'env_key = "MY_COMPANY_PROXY_KEY"',
        ].join("\n"),
        "utf8",
      );

      const readEnvironment = vi.fn(() => ({
        PATH: "/opt/homebrew/bin:/usr/bin",
        SSH_AUTH_SOCK: "/tmp/ssh.sock",
        MY_COMPANY_PROXY_KEY: "proxy-secret",
      }));

      const env = buildCodexProcessEnv({
        env: {
          SHELL: "/bin/zsh",
          PATH: "/usr/bin",
          SYNARA_HOME: runtimeHome,
        },
        homePath: tempDir,
        platform: "darwin",
        readEnvironment,
      });

      expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", [
        "PATH",
        "SSH_AUTH_SOCK",
        "MY_COMPANY_PROXY_KEY",
      ]);
      expect(env.CODEX_HOME).toContain("codex-home-overlay");
      expect(env.MY_COMPANY_PROXY_KEY).toBe("proxy-secret");
      expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("does not read shell env when the provider key is already present", () => {
    const readEnvironment = vi.fn();

    const env = buildCodexProcessEnv({
      env: {
        SHELL: "/bin/zsh",
        PATH: "/usr/bin",
        CODEX_HOME: "/tmp/.codex",
        AZURE_OPENAI_API_KEY: "existing-secret",
      },
      platform: "darwin",
      readEnvironment,
    });

    expect(readEnvironment).not.toHaveBeenCalled();
    expect(env.AZURE_OPENAI_API_KEY).toBe("existing-secret");
  });

  it("allows the configured desktop browser-use socket in the Codex sandbox", () => {
    const env = buildCodexProcessEnv({
      env: {
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/codex-browser-use/synara.sock",
        NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS: "/tmp/existing.sock",
      },
      platform: "darwin",
    });

    expect(env.NODE_REPL_SANDBOX_ALLOWED_UNIX_SOCKETS).toBe(
      "/tmp/existing.sock,/tmp/codex-browser-use/synara.sock",
    );
  });

  it("resolves the browser-use pipe path from desktop env aliases", () => {
    expect(
      resolveCodexBrowserUsePipePath({
        env: { SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/codex-browser-use/synara.sock" },
        platform: "darwin",
      }),
    ).toBe("/tmp/codex-browser-use/synara.sock");
  });

  it("applies durable section suppressions inside Synara's Codex overlay", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      writeFileSync(
        path.join(tempDir, "config.toml"),
        [
          '[plugins."github@openai-curated"]',
          "enabled = true",
          "",
          '[plugins."historical-plugin@local"]',
          "enabled = true",
        ].join("\n"),
        "utf8",
      );

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(
        path.join(overlayHome, "synara-config-suppressions-v1.json"),
        `${JSON.stringify({
          version: 1,
          sectionHeaders: ['[plugins."historical-plugin@local"]'],
        })}\n`,
        "utf8",
      );

      const env = buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(path.join(runtimeHome, "codex-home-overlay"));
      const codexHome = env.CODEX_HOME;
      if (typeof codexHome !== "string") {
        throw new Error("Expected CODEX_HOME to be set.");
      }
      expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(
        '[plugins."historical-plugin@local"]\nenabled = false',
      );
      expect(readFileSync(path.join(tempDir, "config.toml"), "utf8")).toContain(
        '[plugins."historical-plugin@local"]\nenabled = true',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("seeds markerless suppressions for conflicting local browser plugins", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      const conflictingHeader = '[plugins."bridge-browser@local"]';
      writeFileSync(
        path.join(tempDir, "config.toml"),
        [conflictingHeader, "enabled = true", "", '[plugins."other@local"]', "enabled = true"].join(
          "\n",
        ),
        "utf8",
      );

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const env = buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      const overlayConfig = readFileSync(path.join(overlayHome, "config.toml"), "utf8");
      expect(overlayConfig).toContain(`${conflictingHeader}\nenabled = false`);
      expect(overlayConfig).toContain('[plugins."other@local"]\nenabled = true');
      expect(readFileSync(path.join(tempDir, "config.toml"), "utf8")).toContain(
        `${conflictingHeader}\nenabled = true`,
      );
      const suppressionMarker = JSON.parse(
        readFileSync(path.join(overlayHome, "synara-config-suppressions-v1.json"), "utf8"),
      ) as { sectionHeaders?: string[] };
      expect(suppressionMarker.sectionHeaders).toContain(conflictingHeader);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("preserves a recorded suppression after its plugin disappears from source config", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(
        path.join(overlayHome, "synara-config-suppressions-v1.json"),
        `${JSON.stringify({
          version: 1,
          sectionHeaders: ['[plugins."historical-plugin@local"]'],
        })}\n`,
        "utf8",
      );

      const env = buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      const codexHome = env.CODEX_HOME;
      if (typeof codexHome !== "string") {
        throw new Error("Expected CODEX_HOME to be set.");
      }
      expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(
        '[plugins."historical-plugin@local"]\nenabled = false',
      );
      expect(readFileSync(path.join(tempDir, "config.toml"), "utf8")).not.toContain(
        "historical-plugin@local",
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("routes SQLite state through the source home without repairing stale overlay DBs", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      const sourceMemoryPath = path.join(tempDir, "memories_1.sqlite");
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");
      writeFileSync(sourceMemoryPath, "fresh-source-db", "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const overlayMemoryPath = path.join(overlayHome, "memories_1.sqlite");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(overlayMemoryPath, "stale-overlay-db", "utf8");

      const env = buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      expect(env.CODEX_SQLITE_HOME).toBe(path.resolve(tempDir));
      expect(lstatSync(overlayMemoryPath).isFile()).toBe(true);
      expect(readFileSync(overlayMemoryPath, "utf8")).toBe("stale-overlay-db");
      expect(readFileSync(sourceMemoryPath, "utf8")).toBe("fresh-source-db");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("repairs stale auth.json files in Synara's Codex home overlay", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      const sourceAuthPath = path.join(tempDir, "auth.json");
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");
      writeFileSync(sourceAuthPath, '{"tokens":{"access_token":"fresh"}}', "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const overlayAuthPath = path.join(overlayHome, "auth.json");
      mkdirSync(overlayHome, { recursive: true });
      writeFileSync(overlayAuthPath, '{"tokens":{"access_token":"stale"}}', "utf8");

      const env = buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      expect(lstatSync(overlayAuthPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(overlayAuthPath)).toBe(sourceAuthPath);
      expect(readFileSync(overlayAuthPath, "utf8")).toContain("fresh");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("uses an account-scoped overlay with private files from the Codex shadow home", () => {
    const sharedHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-shared-"));
    const shadowHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-shadow-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      const sharedSessionsDir = path.join(sharedHome, "sessions");
      mkdirSync(sharedSessionsDir, { recursive: true });
      writeFileSync(
        path.join(sharedHome, "config.toml"),
        'model = "gpt-5.5"\ncli_auth_credentials_store = "file"\n',
        "utf8",
      );
      writeFileSync(path.join(sharedHome, "auth.json"), '{"source":"shared"}', "utf8");
      writeFileSync(path.join(sharedHome, "models_cache.json"), '{"models":["shared"]}', "utf8");
      writeFileSync(path.join(shadowHome, "auth.json"), '{"source":"shadow"}', "utf8");
      writeFileSync(path.join(shadowHome, "models_cache.json"), '{"models":["shadow"]}', "utf8");

      const env = buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: sharedHome,
        shadowHomePath: shadowHome,
        accountId: "work",
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toContain(path.join("codex-home-overlay", "accounts"));
      const codexHome = env.CODEX_HOME;
      if (typeof codexHome !== "string") {
        throw new Error("Expected CODEX_HOME to be set.");
      }
      expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toContain(
        'cli_auth_credentials_store = "file"',
      );
      expect(lstatSync(path.join(codexHome, "sessions")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(codexHome, "sessions"))).toBe(sharedSessionsDir);
      expect(readlinkSync(path.join(codexHome, "auth.json"))).toBe(
        path.join(shadowHome, "auth.json"),
      );
      expect(readlinkSync(path.join(codexHome, "models_cache.json"))).toBe(
        path.join(shadowHome, "models_cache.json"),
      );
      expect(readFileSync(path.join(codexHome, "auth.json"), "utf8")).toContain("shadow");
    } finally {
      rmSync(sharedHome, { recursive: true, force: true });
      rmSync(shadowHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("links configured account private auth files into account overlays without a shadow home", () => {
    const accountHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-account-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      const accountSessionsDir = path.join(accountHome, "sessions");
      mkdirSync(accountSessionsDir, { recursive: true });
      writeFileSync(path.join(accountHome, "config.toml"), 'model = "gpt-5.5"', "utf8");
      writeFileSync(path.join(accountHome, "auth.json"), '{"source":"account"}', "utf8");
      writeFileSync(path.join(accountHome, "models_cache.json"), '{"models":["account"]}', "utf8");

      const env = buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: accountHome,
        accountId: "work",
        platform: "darwin",
      });

      const codexHome = env.CODEX_HOME;
      if (typeof codexHome !== "string") {
        throw new Error("Expected CODEX_HOME to be set.");
      }
      expect(codexHome).toContain(path.join("codex-home-overlay", "accounts"));
      expect(lstatSync(path.join(codexHome, "sessions")).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(codexHome, "sessions"))).toBe(accountSessionsDir);
      expect(readlinkSync(path.join(codexHome, "auth.json"))).toBe(
        path.join(accountHome, "auth.json"),
      );
      expect(readlinkSync(path.join(codexHome, "models_cache.json"))).toBe(
        path.join(accountHome, "models_cache.json"),
      );
      expect(readFileSync(path.join(codexHome, "auth.json"), "utf8")).toContain("account");
    } finally {
      rmSync(accountHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("preserves real generated image directories in Synara's Codex home overlay", () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-env-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "synara-runtime-home-"));
    try {
      writeFileSync(path.join(tempDir, "config.toml"), 'model = "gpt-5.5"', "utf8");
      const sourceGeneratedImagesDir = path.join(tempDir, "generated_images");
      mkdirSync(sourceGeneratedImagesDir, { recursive: true });
      writeFileSync(path.join(sourceGeneratedImagesDir, "source.png"), "source-image", "utf8");

      const overlayHome = path.join(runtimeHome, "codex-home-overlay");
      const overlayGeneratedImagesDir = path.join(overlayHome, "generated_images");
      mkdirSync(overlayGeneratedImagesDir, { recursive: true });
      const overlayImagePath = path.join(overlayGeneratedImagesDir, "overlay.png");
      writeFileSync(overlayImagePath, "overlay-image", "utf8");

      const env = buildCodexProcessEnv({
        env: { SYNARA_HOME: runtimeHome },
        homePath: tempDir,
        platform: "darwin",
      });

      expect(env.CODEX_HOME).toBe(overlayHome);
      expect(lstatSync(overlayGeneratedImagesDir).isDirectory()).toBe(true);
      expect(readFileSync(overlayImagePath, "utf8")).toBe("overlay-image");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("disables only explicitly recorded plugin sections", () => {
    expect(
      disableCodexConfigSections(
        '[plugins."historical-plugin@local"]\nenabled = true\n\n[plugins."other@local"]\nenabled = true',
        ['[plugins."historical-plugin@local"]'],
      ),
    ).toBe(
      '[plugins."historical-plugin@local"]\nenabled = false\n\n[plugins."other@local"]\nenabled = true',
    );
  });
});

describe("handleStdoutLine", () => {
  it("ignores token usage footers emitted on stdout during shutdown", () => {
    const { manager, context, emitEvent } = createProcessOutputHarness();

    (
      manager as unknown as {
        handleStdoutLine: (context: unknown, line: string) => void;
      }
    ).handleStdoutLine(
      context,
      "^CToken usage: total=360,953 input=336,874 (+ 4,219,648 cached) output=24,079 (reasoning 7,982)",
    );

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("ignores human-readable diagnostics leaked onto app-server stdout", () => {
    const { manager, context, emitEvent } = createProcessOutputHarness();
    const handleStdoutLine = (
      manager as unknown as {
        handleStdoutLine: (context: unknown, line: string) => void;
      }
    ).handleStdoutLine.bind(manager);

    for (const line of ["Reasoning trace", "Reasoning summary", "Command execution"]) {
      handleStdoutLine(context, line);
    }

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("ignores multiline and standalone JSON leaked from command output", () => {
    const { manager, context, emitEvent } = createProcessOutputHarness();
    const handleStdoutLine = (
      manager as unknown as {
        handleStdoutLine: (context: unknown, line: string) => void;
      }
    ).handleStdoutLine.bind(manager);

    for (const line of ["{", "[", '{"scripts": {', "{}", "[]", '{"name":"synara"}']) {
      handleStdoutLine(context, line);
    }

    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("ignores malformed JSON-looking fragments without poisoning the session", () => {
    const { manager, context, emitEvent } = createProcessOutputHarness();

    (
      manager as unknown as {
        handleStdoutLine: (context: unknown, line: string) => void;
      }
    ).handleStdoutLine(context, '{"method":"item/started"');

    expect(emitEvent).not.toHaveBeenCalled();
  });
});

describe("normalizeCodexModelSlug", () => {
  it("maps 5.3 aliases to gpt-5.3-codex", () => {
    expect(normalizeCodexModelSlug("5.3")).toBe("gpt-5.3-codex");
    expect(normalizeCodexModelSlug("gpt-5.3")).toBe("gpt-5.3-codex");
  });

  it("prefers codex id when model differs", () => {
    expect(normalizeCodexModelSlug("gpt-5.3", "gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  it("keeps non-aliased models as-is", () => {
    expect(normalizeCodexModelSlug("gpt-5.2-codex")).toBe("gpt-5.2-codex");
    expect(normalizeCodexModelSlug("gpt-5.2")).toBe("gpt-5.2");
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches not-found resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/resume failed: thread not found")),
    ).toBe(true);
  });

  it("ignores non-resume errors", () => {
    expect(
      isRecoverableThreadResumeError(new Error("thread/start failed: permission denied")),
    ).toBe(false);
  });

  it("ignores non-recoverable resume errors", () => {
    expect(
      isRecoverableThreadResumeError(
        new Error("thread/resume failed: timed out waiting for server"),
      ),
    ).toBe(false);
  });
});

describe("readCodexAccountSnapshot", () => {
  it("disables spark for chatgpt plus accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "plus@example.com",
        planType: "plus",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "plus",
      sparkEnabled: false,
    });
  });

  it("keeps spark enabled for chatgpt pro accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "chatgpt",
        email: "pro@example.com",
        planType: "pro",
      }),
    ).toEqual({
      type: "chatgpt",
      planType: "pro",
      sparkEnabled: true,
    });
  });

  it("keeps spark enabled for api key accounts", () => {
    expect(
      readCodexAccountSnapshot({
        type: "apiKey",
      }),
    ).toEqual({
      type: "apiKey",
      planType: null,
      sparkEnabled: true,
    });
  });
});

describe("resolveCodexModelForAccount", () => {
  it("falls back from spark to default for unsupported chatgpt plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "plus",
        sparkEnabled: false,
      }),
    ).toBe("gpt-5.5");
  });

  it("keeps spark for supported plans", () => {
    expect(
      resolveCodexModelForAccount("gpt-5.3-codex-spark", {
        type: "chatgpt",
        planType: "pro",
        sparkEnabled: true,
      }),
    ).toBe("gpt-5.3-codex-spark");
  });
});

describe("startSession", () => {
  it("enables Codex experimental api capabilities during initialize", () => {
    expect(buildCodexInitializeParams()).toEqual({
      clientInfo: {
        name: "synara_desktop",
        title: "Synara Desktop",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });

  it("uses an isolated scratch workspace path when no cwd is provided", () => {
    const cwd = ensureIsolatedScratchWorkspace(asThreadId("thread-1"));
    expect(cwd).toContain(`${path.sep}synara-codex-workspaces${path.sep}thread-1`);
  });

  it("removes a stopped session before adapter-style event inspection can re-enter pruning", () => {
    const authHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-stop-reentry-"));
    const authPath = path.join(authHome, "auth.json");
    writeFileSync(authPath, codexAuth("workspace-first", "1"), "utf8");
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-stop-listener-reentry");
    const kill = vi.fn();
    const close = vi.fn();
    const closedEvents: string[] = [];
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, {
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child: { killed: false, kill },
      output: { close },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
      authHomePath: authHome,
      authFingerprint: readCodexAuthFileFingerprint(authHome),
    });
    manager.on("event", (event) => {
      if (event.method !== "session/closed") return;
      closedEvents.push(event.method);
      expect(manager.listSessions()).toEqual([]);
      expect(manager.getSessionCodexOptions(threadId)).toBeUndefined();
    });

    try {
      writeFileSync(authPath, codexAuth("workspace-second", "2"), "utf8");
      manager.stopSession(threadId);
      manager.stopSession(threadId);

      expect(closedEvents).toEqual(["session/closed"]);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      manager.stopAll();
      rmSync(authHome, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when the selected account changes while a new session initializes",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-launch-auth-swap-"));
      const sourceHome = path.join(root, "codex-home");
      const projectPath = path.join(root, "project");
      const authPath = path.join(sourceHome, "auth.json");
      const messagesPath = path.join(root, "messages.txt");
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      writeFileSync(authPath, codexAuth("workspace-first", "1"), "utf8");
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();

      try {
        await expect(
          manager.startSession({
            threadId: asThreadId("thread-launch-auth-swap"),
            provider: "codex",
            cwd: projectPath,
            runtimeMode: "full-access",
            providerOptions: {
              codex: {
                binaryPath,
                homePath: sourceHome,
                environment: {
                  HOME: root,
                  SYNARA_HOME: path.join(root, "runtime"),
                  SYNARA_FAKE_CODEX_MESSAGES_PATH: messagesPath,
                  SYNARA_FAKE_CODEX_MUTATE_AUTH_PATH: authPath,
                  SYNARA_FAKE_CODEX_MUTATE_AUTH_CONTENT: codexAuth("workspace-second", "2"),
                },
              },
            },
          }),
        ).rejects.toThrow(/authentication changed on disk/);

        expect(readFakeCodexMethods(messagesPath)).toEqual(["initialize"]);
        expect(manager.listSessions()).toEqual([]);
      } finally {
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows same-account token rotation while a new session initializes",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-launch-token-rotation-"));
      const sourceHome = path.join(root, "codex-home");
      const projectPath = path.join(root, "project");
      const authPath = path.join(sourceHome, "auth.json");
      const messagesPath = path.join(root, "messages.txt");
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      writeFileSync(authPath, codexAuth("workspace-stable", "1"), "utf8");
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();

      try {
        const session = await manager.startSession({
          threadId: asThreadId("thread-launch-token-rotation"),
          provider: "codex",
          cwd: projectPath,
          runtimeMode: "full-access",
          providerOptions: {
            codex: {
              binaryPath,
              homePath: sourceHome,
              environment: {
                HOME: root,
                SYNARA_HOME: path.join(root, "runtime"),
                SYNARA_FAKE_CODEX_MESSAGES_PATH: messagesPath,
                SYNARA_FAKE_CODEX_MUTATE_AUTH_PATH: authPath,
                SYNARA_FAKE_CODEX_MUTATE_AUTH_CONTENT: codexAuth("workspace-stable", "2"),
              },
            },
          },
        });

        expect(session.status).toBe("ready");
        expect(readFakeCodexMethods(messagesPath)).toContain("thread/start");
        expect(manager.listSessions()).toHaveLength(1);
      } finally {
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not let a superseded start failure stop its replacement session",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-start-replacement-"));
      const sourceHome = path.join(root, "codex-home");
      const projectPath = path.join(root, "project");
      const firstMessagesPath = path.join(root, "first-messages.txt");
      const secondMessagesPath = path.join(root, "second-messages.txt");
      const initializeGatePath = path.join(root, "release-first-initialize");
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      writeFileSync(path.join(sourceHome, "auth.json"), codexAuth("workspace-stable", "1"), "utf8");
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();
      const threadId = asThreadId("thread-start-replacement");

      try {
        const firstOutcome = settle(
          manager.startSession({
            threadId,
            provider: "codex",
            cwd: projectPath,
            runtimeMode: "full-access",
            providerOptions: {
              codex: {
                binaryPath,
                homePath: sourceHome,
                environment: {
                  HOME: root,
                  SYNARA_HOME: path.join(root, "runtime"),
                  SYNARA_FAKE_CODEX_MESSAGES_PATH: firstMessagesPath,
                  SYNARA_FAKE_CODEX_HOLD_INITIALIZE_PATH: initializeGatePath,
                },
              },
            },
          }),
        );
        await vi.waitFor(() => {
          expect(readFakeCodexMethods(firstMessagesPath)).toContain("initialize");
        });

        const replacement = await manager.startSession({
          threadId,
          provider: "codex",
          cwd: projectPath,
          runtimeMode: "full-access",
          providerOptions: {
            codex: {
              binaryPath,
              homePath: sourceHome,
              environment: {
                HOME: root,
                SYNARA_HOME: path.join(root, "runtime"),
                SYNARA_FAKE_CODEX_MESSAGES_PATH: secondMessagesPath,
              },
            },
          },
        });
        const superseded = await firstOutcome;

        expect(superseded.status).toBe("rejected");
        expect(replacement.status).toBe("ready");
        expect(readFakeCodexMethods(secondMessagesPath)).toContain("thread/start");
        expect(manager.listSessions()).toEqual([replacement]);
      } finally {
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a synchronous start replacement installed when the old app-server exits during initialize",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-start-exit-replacement-"));
      const sourceHome = path.join(root, "codex-home");
      const projectPath = path.join(root, "project");
      const runtimeHome = path.join(root, "runtime");
      const replacementMessagesPath = path.join(root, "replacement-messages.txt");
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      writeFileSync(path.join(sourceHome, "auth.json"), codexAuth("workspace-stable", "1"), "utf8");
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();
      const threadId = asThreadId("thread-start-exit-replacement");
      const methods: string[] = [];
      let replacementPromise: ReturnType<typeof manager.startSession> | undefined;
      const listener = (event: { readonly threadId: ThreadId; readonly method: string }) => {
        if (event.threadId !== threadId) return;
        methods.push(event.method);
        if (event.method !== "session/exited" || replacementPromise) return;
        replacementPromise = manager.startSession({
          threadId,
          provider: "codex",
          providerInstanceId: "codex_work",
          cwd: projectPath,
          runtimeMode: "full-access",
          providerOptions: {
            codex: {
              binaryPath,
              homePath: sourceHome,
              environment: {
                HOME: root,
                SYNARA_HOME: runtimeHome,
                SYNARA_FAKE_CODEX_MESSAGES_PATH: replacementMessagesPath,
              },
            },
          },
        });
      };
      manager.on("event", listener);

      try {
        const first = await settle(
          manager.startSession({
            threadId,
            provider: "codex",
            providerInstanceId: "codex_work",
            cwd: projectPath,
            runtimeMode: "full-access",
            providerOptions: {
              codex: {
                binaryPath,
                homePath: sourceHome,
                environment: {
                  HOME: root,
                  SYNARA_HOME: runtimeHome,
                  SYNARA_FAKE_CODEX_EXIT_ON_INITIALIZE: "17",
                },
              },
            },
          }),
        );
        expect(first.status).toBe("rejected");
        expect(replacementPromise).toBeDefined();
        const replacement = await replacementPromise!;

        expect(replacement.status).toBe("ready");
        expect(replacement.providerInstanceId).toBe("codex_work");
        expect(readFakeCodexMethods(replacementMessagesPath)).toContain("thread/start");
        expect(manager.listSessions()).toEqual([replacement]);
        expect(methods).toContain("session/exited");
        expect(methods).not.toContain("session/startFailed");
        expect(methods).not.toContain("session/closed");
      } finally {
        manager.off("event", listener);
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed before native fork when the selected account changes during initialization",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-fork-auth-swap-"));
      const sourceHome = path.join(root, "codex-home");
      const projectPath = path.join(root, "project");
      const runtimeHome = path.join(root, "runtime");
      const authPath = path.join(sourceHome, "auth.json");
      const messagesPath = path.join(root, "messages.txt");
      const environment = { HOME: root, SYNARA_HOME: runtimeHome };
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      writeFileSync(authPath, codexAuth("workspace-first", "1"), "utf8");
      buildCodexProcessEnv({ env: environment, homePath: sourceHome });
      const generation = readCodexSharedContinuationGeneration({
        env: environment,
        homePath: sourceHome,
      });
      expect(generation).toMatch(/^[0-9a-f-]{36}$/);
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();

      try {
        await expect(
          manager.forkThread({
            sourceThreadId: asThreadId("source-auth-swap"),
            sourceResumeCursor: { threadId: "provider-source-thread" },
            threadId: asThreadId("fork-auth-swap"),
            cwd: projectPath,
            runtimeMode: "full-access",
            expectedCodexContinuationGeneration: generation!,
            providerOptions: {
              codex: {
                binaryPath,
                homePath: sourceHome,
                environment: {
                  ...environment,
                  SYNARA_FAKE_CODEX_MESSAGES_PATH: messagesPath,
                  SYNARA_FAKE_CODEX_MUTATE_AUTH_PATH: authPath,
                  SYNARA_FAKE_CODEX_MUTATE_AUTH_CONTENT: codexAuth("workspace-second", "2"),
                },
              },
            },
          }),
        ).rejects.toThrow(/authentication changed on disk/);

        expect(readFakeCodexMethods(messagesPath)).toEqual(["initialize"]);
        expect(manager.listSessions()).toEqual([]);
      } finally {
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not let a superseded fork failure stop its replacement session",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-fork-replacement-"));
      const sourceHome = path.join(root, "codex-home");
      const projectPath = path.join(root, "project");
      const runtimeHome = path.join(root, "runtime");
      const firstMessagesPath = path.join(root, "first-messages.txt");
      const secondMessagesPath = path.join(root, "second-messages.txt");
      const initializeGatePath = path.join(root, "release-first-initialize");
      const environment = { HOME: root, SYNARA_HOME: runtimeHome };
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      writeFileSync(path.join(sourceHome, "auth.json"), codexAuth("workspace-stable", "1"), "utf8");
      buildCodexProcessEnv({ env: environment, homePath: sourceHome });
      const generation = readCodexSharedContinuationGeneration({
        env: environment,
        homePath: sourceHome,
      });
      expect(generation).toMatch(/^[0-9a-f-]{36}$/);
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();
      const threadId = asThreadId("thread-fork-replacement");

      try {
        const firstOutcome = settle(
          manager.forkThread({
            sourceThreadId: asThreadId("source-first-fork"),
            sourceResumeCursor: { threadId: "provider-source-first" },
            threadId,
            cwd: projectPath,
            runtimeMode: "full-access",
            expectedCodexContinuationGeneration: generation!,
            providerOptions: {
              codex: {
                binaryPath,
                homePath: sourceHome,
                environment: {
                  ...environment,
                  SYNARA_FAKE_CODEX_MESSAGES_PATH: firstMessagesPath,
                  SYNARA_FAKE_CODEX_HOLD_INITIALIZE_PATH: initializeGatePath,
                },
              },
            },
          }),
        );
        await vi.waitFor(() => {
          expect(readFakeCodexMethods(firstMessagesPath)).toContain("initialize");
        });

        const replacement = await manager.forkThread({
          sourceThreadId: asThreadId("source-second-fork"),
          sourceResumeCursor: { threadId: "provider-source-second" },
          threadId,
          cwd: projectPath,
          runtimeMode: "full-access",
          expectedCodexContinuationGeneration: generation!,
          providerOptions: {
            codex: {
              binaryPath,
              homePath: sourceHome,
              environment: {
                ...environment,
                SYNARA_FAKE_CODEX_MESSAGES_PATH: secondMessagesPath,
              },
            },
          },
        });
        const superseded = await firstOutcome;

        expect(superseded.status).toBe("rejected");
        expect(replacement).toEqual({
          threadId,
          resumeCursor: { threadId: "fake-forked-thread" },
        });
        expect(readFakeCodexMethods(secondMessagesPath)).toContain("thread/fork");
        expect(manager.listSessions()).toEqual([
          expect.objectContaining({
            threadId,
            status: "ready",
            resumeCursor: { threadId: "fake-forked-thread" },
          }),
        ]);
      } finally {
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps a synchronous fork replacement installed when the old app-server exits during initialize",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-fork-exit-replacement-"));
      const sourceHome = path.join(root, "codex-home");
      const projectPath = path.join(root, "project");
      const runtimeHome = path.join(root, "runtime");
      const replacementMessagesPath = path.join(root, "replacement-messages.txt");
      const environment = { HOME: root, SYNARA_HOME: runtimeHome };
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      writeFileSync(path.join(sourceHome, "auth.json"), codexAuth("workspace-stable", "1"), "utf8");
      buildCodexProcessEnv({ env: environment, homePath: sourceHome });
      const generation = readCodexSharedContinuationGeneration({
        env: environment,
        homePath: sourceHome,
      });
      expect(generation).toMatch(/^[0-9a-f-]{36}$/);
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();
      const threadId = asThreadId("thread-fork-exit-replacement");
      const methods: string[] = [];
      let replacementPromise: ReturnType<typeof manager.forkThread> | undefined;
      const replacementInput = {
        sourceThreadId: asThreadId("source-fork-exit-replacement"),
        sourceResumeCursor: { threadId: "provider-source-replacement" },
        threadId,
        cwd: projectPath,
        runtimeMode: "full-access" as const,
        expectedCodexContinuationGeneration: generation!,
        providerOptions: {
          codex: {
            binaryPath,
            homePath: sourceHome,
            environment: {
              ...environment,
              SYNARA_FAKE_CODEX_MESSAGES_PATH: replacementMessagesPath,
            },
          },
        },
      };
      const listener = (event: { readonly threadId: ThreadId; readonly method: string }) => {
        if (event.threadId !== threadId) return;
        methods.push(event.method);
        if (event.method !== "session/exited" || replacementPromise) return;
        replacementPromise = manager.forkThread(replacementInput);
      };
      manager.on("event", listener);

      try {
        const first = await settle(
          manager.forkThread({
            sourceThreadId: asThreadId("source-fork-exit-first"),
            sourceResumeCursor: { threadId: "provider-source-first" },
            threadId,
            cwd: projectPath,
            runtimeMode: "full-access",
            expectedCodexContinuationGeneration: generation!,
            providerOptions: {
              codex: {
                binaryPath,
                homePath: sourceHome,
                environment: {
                  ...environment,
                  SYNARA_FAKE_CODEX_EXIT_ON_INITIALIZE: "18",
                },
              },
            },
          }),
        );
        expect(first.status).toBe("rejected");
        expect(replacementPromise).toBeDefined();
        const replacement = await replacementPromise!;

        expect(replacement).toEqual({
          threadId,
          resumeCursor: { threadId: "fake-forked-thread" },
        });
        expect(readFakeCodexMethods(replacementMessagesPath)).toContain("thread/fork");
        expect(manager.listSessions()).toEqual([
          expect.objectContaining({
            threadId,
            status: "ready",
            resumeCursor: { threadId: "fake-forked-thread" },
          }),
        ]);
        expect(methods).toContain("session/exited");
        expect(methods).not.toContain("session/threadForkFailed");
        expect(methods).not.toContain("session/closed");
      } finally {
        manager.off("event", listener);
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("evicts a live app-server session when the ChatGPT account changes", () => {
    const authHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-auth-fingerprint-"));
    const authPath = path.join(authHome, "auth.json");
    writeFileSync(
      authPath,
      '{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-first","access_token":"access-1","refresh_token":"refresh-1"}}',
      "utf8",
    );
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-auth-refresh");
    const kill = vi.fn();
    const close = vi.fn();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        model: "gpt-5.5",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child: { killed: false, kill },
      output: { close },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
      authHomePath: authHome,
      authFingerprint: readCodexAuthFileFingerprint(authHome),
    };
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, context);

    writeFileSync(
      authPath,
      '{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-second","access_token":"access-2","refresh_token":"refresh-2"}}',
      "utf8",
    );

    expect(manager.listSessions()).toEqual([]);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    rmSync(authHome, { recursive: true, force: true });
  });

  it("omits stale-auth sessions from inspection without stopping them until lifecycle listing", () => {
    const authHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-auth-inspection-"));
    const authPath = path.join(authHome, "auth.json");
    writeFileSync(
      authPath,
      '{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-first"}}',
      "utf8",
    );
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-auth-read-only-inspection");
    const kill = vi.fn();
    const close = vi.fn();
    const session = {
      provider: "codex" as const,
      status: "ready" as const,
      threadId,
      runtimeMode: "full-access" as const,
      providerInstanceId: "codex_work",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    };
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, {
      session,
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child: { killed: false, kill },
      output: { close },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
      authHomePath: authHome,
      authFingerprint: readCodexAuthFileFingerprint(authHome),
      codexOptions: { homePath: authHome, accountId: "work" },
    });

    try {
      writeFileSync(
        authPath,
        '{"auth_mode":"chatgpt","tokens":{"account_id":"workspace-second"}}',
        "utf8",
      );

      expect(manager.inspectSessions()).toEqual([]);
      expect(kill).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();

      expect(manager.listSessions()).toEqual([]);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      manager.stopAll();
      rmSync(authHome, { recursive: true, force: true });
    }
  });

  it("reuses a live app-server session after same-account token rotation", () => {
    const authHome = mkdtempSync(path.join(os.tmpdir(), "synara-codex-auth-rotation-"));
    const authPath = path.join(authHome, "auth.json");
    const auth = (accessToken: string, refreshToken: string) =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: "workspace-stable",
          access_token: accessToken,
          refresh_token: refreshToken,
        },
      });
    writeFileSync(authPath, auth("access-1", "refresh-1"), "utf8");
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-auth-same-account-rotation");
    const kill = vi.fn();
    const close = vi.fn();
    const session = {
      provider: "codex" as const,
      status: "ready" as const,
      threadId,
      runtimeMode: "full-access" as const,
      model: "gpt-5.5",
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:00.000Z",
    };
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, {
      session,
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child: { killed: false, kill },
      output: { close },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
      authHomePath: authHome,
      authFingerprint: readCodexAuthFileFingerprint(authHome),
      codexOptions: { homePath: authHome, accountId: "work" },
    });

    try {
      writeFileSync(authPath, auth("access-2", "refresh-2"), "utf8");
      expect(manager.inspectSessions()).toEqual([
        {
          session,
          codexOptions: { homePath: authHome, accountId: "work" },
        },
      ]);
      expect(manager.listSessions()).toEqual([session]);
      expect(kill).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
    } finally {
      manager.stopAll();
      rmSync(authHome, { recursive: true, force: true });
    }
  });

  it("evicts a live session when copied overlay auth diverges from its source", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-auth-copy-source-"));
    const sourceHome = path.join(root, "codex-home");
    const runtimeHome = path.join(root, "runtime");
    mkdirSync(sourceHome, { recursive: true });
    writeFileSync(path.join(sourceHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    const sourceAuthPath = path.join(sourceHome, "auth.json");
    writeFileSync(sourceAuthPath, '{"account":"first"}', "utf8");
    const launch = buildCodexProcessLaunchContext({
      env: { HOME: root, SYNARA_HOME: runtimeHome, CODEX_HOME: sourceHome },
      platform: "win32",
      overlayEntryLinker: {
        symlink: (sourcePath, targetPath, type) => {
          if (path.basename(String(targetPath)) === "auth.json") {
            throw new Error("auth symlinks unavailable");
          }
          return symlinkSync(sourcePath, targetPath, type);
        },
        copyFile: copyFileSync,
      },
    });
    const overlayHome = launch.env.CODEX_HOME;
    expect(overlayHome).toBeTruthy();
    if (!overlayHome) throw new Error("Expected managed Codex home");
    const overlayAuthPath = path.join(overlayHome, "auth.json");
    expect(lstatSync(overlayAuthPath).isFile()).toBe(true);

    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-auth-copy-refresh");
    const kill = vi.fn();
    const close = vi.fn();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        model: "gpt-5.5",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child: { killed: false, kill },
      output: { close },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
      authTracking: launch.authTracking,
      authFingerprint: readCodexAuthTrackingFingerprint(launch.authTracking),
    };
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, context);

    try {
      writeFileSync(sourceAuthPath, '{"account":"second"}', "utf8");
      expect(manager.listSessions()).toEqual([]);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(readFileSync(overlayAuthPath, "utf8")).toBe('{"account":"first"}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicts a live session when authoritative auth is deleted after a fallback copy", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-auth-copy-logout-"));
    const sourceHome = path.join(root, "codex-home");
    const runtimeHome = path.join(root, "runtime");
    mkdirSync(sourceHome, { recursive: true });
    writeFileSync(path.join(sourceHome, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    const sourceAuthPath = path.join(sourceHome, "auth.json");
    writeFileSync(sourceAuthPath, '{"account":"first"}', "utf8");
    const launch = buildCodexProcessLaunchContext({
      env: { HOME: root, SYNARA_HOME: runtimeHome, CODEX_HOME: sourceHome },
      platform: "win32",
      overlayEntryLinker: {
        symlink: (sourcePath, targetPath, type) => {
          if (path.basename(String(targetPath)) === "auth.json") {
            throw new Error("auth symlinks unavailable");
          }
          return symlinkSync(sourcePath, targetPath, type);
        },
        copyFile: copyFileSync,
      },
    });
    const overlayHome = launch.env.CODEX_HOME;
    expect(overlayHome).toBeTruthy();
    if (!overlayHome) throw new Error("Expected managed Codex home");
    const overlayAuthPath = path.join(overlayHome, "auth.json");
    expect(lstatSync(overlayAuthPath).isFile()).toBe(true);

    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-auth-copy-logout");
    const kill = vi.fn();
    const close = vi.fn();
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, {
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        model: "gpt-5.5",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child: { killed: false, kill },
      output: { close },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
      authTracking: launch.authTracking,
      authFingerprint: readCodexAuthTrackingFingerprint(launch.authTracking),
    });

    try {
      unlinkSync(sourceAuthPath);
      expect(manager.listSessions()).toEqual([]);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(readFileSync(overlayAuthPath, "utf8")).toBe('{"account":"first"}');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicts file-backed sessions and rejects refreshes after config switches to keyring", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-auth-store-switch-"));
    const sourceHome = path.join(root, "codex-home");
    const runtimeHome = path.join(root, "runtime");
    mkdirSync(sourceHome, { recursive: true });
    const configPath = path.join(sourceHome, "config.toml");
    writeFileSync(configPath, 'cli_auth_credentials_store = "file"\n', "utf8");
    writeFileSync(path.join(sourceHome, "auth.json"), '{"account":"first"}', "utf8");
    const launch = buildCodexProcessLaunchContext({
      env: { HOME: root, SYNARA_HOME: runtimeHome, CODEX_HOME: sourceHome },
      platform: "win32",
    });
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-auth-store-switch");
    const kill = vi.fn();
    const close = vi.fn();
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, {
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        model: "gpt-5.5",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child: { killed: false, kill },
      output: { close },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
      authTracking: launch.authTracking,
      authFingerprint: readCodexAuthTrackingFingerprint(launch.authTracking),
    });

    try {
      writeFileSync(configPath, 'cli_auth_credentials_store = "keyring"\n', "utf8");
      expect(manager.listSessions()).toEqual([]);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
      await expect(
        manager.listModels({
          cwd: "/repo",
          codexOptions: {
            homePath: sourceHome,
            environment: { HOME: root, SYNARA_HOME: runtimeHome },
          },
        }),
      ).rejects.toThrow(/require file-backed Codex auth/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("evicts a live session when malformed config prevents safe auth revalidation", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-auth-config-malformed-"));
    const sourceHome = path.join(root, "codex-home");
    const runtimeHome = path.join(root, "runtime");
    mkdirSync(sourceHome, { recursive: true });
    const configPath = path.join(sourceHome, "config.toml");
    writeFileSync(configPath, 'cli_auth_credentials_store = "file"\n', "utf8");
    writeFileSync(path.join(sourceHome, "auth.json"), '{"account":"first"}', "utf8");
    const launch = buildCodexProcessLaunchContext({
      env: { HOME: root, SYNARA_HOME: runtimeHome, CODEX_HOME: sourceHome },
      platform: "win32",
    });
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-auth-config-malformed");
    const kill = vi.fn();
    const close = vi.fn();
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, {
      session: {
        provider: "codex",
        status: "ready",
        threadId,
        runtimeMode: "full-access",
        model: "gpt-5.5",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      child: { killed: false, kill },
      output: { close },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      reviewTurnIds: new Set(),
      nextRequestId: 1,
      stopping: false,
      authTracking: launch.authTracking,
      authFingerprint: readCodexAuthTrackingFingerprint(launch.authTracking),
    });

    try {
      writeFileSync(configPath, 'cli_auth_credentials_store = ["file"\n', "utf8");
      expect(manager.listSessions()).toEqual([]);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      manager.stopAll();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "passes enforced config flags to the app-server after project override attempts",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-app-args-"));
      const sourceHome = path.join(root, "source codex home");
      const runtimeHome = path.join(root, "runtime");
      const projectPath = path.join(root, "project");
      const argsPath = path.join(root, "app-server-args.json");
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(path.join(projectPath, ".codex"), { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      writeFileSync(
        path.join(projectPath, ".codex", "config.toml"),
        `sqlite_home = ${JSON.stringify(path.join(root, "project-wrong-sqlite"))}\ncli_auth_credentials_store = "keyring"\n`,
        "utf8",
      );
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();

      try {
        await manager.startSession({
          threadId: asThreadId("thread-enforced-app-args"),
          provider: "codex",
          cwd: projectPath,
          runtimeMode: "full-access",
          providerOptions: {
            codex: {
              binaryPath,
              homePath: sourceHome,
              environment: {
                HOME: root,
                SYNARA_HOME: runtimeHome,
                SYNARA_FAKE_CODEX_ARGS_PATH: argsPath,
                CODEX_SQLITE_HOME: path.join(root, "environment-wrong-sqlite"),
              },
            },
          },
        });

        expect(JSON.parse(readFileSync(argsPath, "utf8"))).toEqual([
          "app-server",
          "--config",
          `sqlite_home=${JSON.stringify(path.resolve(sourceHome))}`,
          "--config",
          'cli_auth_credentials_store="file"',
        ]);
      } finally {
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not recreate or spawn after a persisted source is deleted between preflight and launch",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-generation-guard-"));
      const sourceHome = path.join(root, "source-home");
      const runtimeHome = path.join(root, "runtime");
      const projectPath = path.join(root, "project");
      const argsPath = path.join(root, "app-server-args.json");
      const invocationsPath = path.join(root, "codex-invocations.jsonl");
      const environment = { HOME: root, SYNARA_HOME: runtimeHome };
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      buildCodexProcessEnv({ env: environment, homePath: sourceHome });
      const generation = readCodexSharedContinuationGeneration({
        env: environment,
        homePath: sourceHome,
      });
      expect(generation).toMatch(/^[0-9a-f-]{36}$/);
      const overlayHome = resolveActiveCodexHomeWritePath({
        env: environment,
        homePath: sourceHome,
      });
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(overlayHome, { recursive: true, force: true });
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();

      try {
        await expect(
          manager.startSession({
            threadId: asThreadId("thread-generation-guard"),
            provider: "codex",
            cwd: projectPath,
            runtimeMode: "full-access",
            resumeCursor: { threadId: "persisted-provider-thread" },
            expectedCodexContinuationGeneration: generation!,
            providerOptions: {
              codex: {
                binaryPath,
                homePath: sourceHome,
                environment: {
                  ...environment,
                  SYNARA_FAKE_CODEX_ARGS_PATH: argsPath,
                  SYNARA_FAKE_CODEX_INVOCATIONS_PATH: invocationsPath,
                },
              },
            },
          }),
        ).rejects.toThrow(/missing or damaged|refusing to recreate persisted session state/);
        expect(existsSync(sourceHome)).toBe(false);
        expect(existsSync(overlayHome)).toBe(false);
        expect(existsSync(invocationsPath)).toBe(false);
        expect(existsSync(argsPath)).toBe(false);
      } finally {
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a native resume that bypasses the generation-pinned adapter path", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-unpinned-resume-"));
    const sourceHome = path.join(root, "source-home");
    const invocationsPath = path.join(root, "codex-invocations.jsonl");
    const binaryPath = writeFakeCodexExecutable(root);
    const manager = new CodexAppServerManager();

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-unpinned-resume"),
          provider: "codex",
          cwd: root,
          runtimeMode: "full-access",
          resumeCursor: { threadId: "provider-thread" },
          providerOptions: {
            codex: {
              binaryPath,
              homePath: sourceHome,
              environment: {
                HOME: root,
                SYNARA_FAKE_CODEX_INVOCATIONS_PATH: invocationsPath,
              },
            },
          },
        }),
      ).rejects.toThrow(/requires a verified continuation source generation/);
      await expect(
        manager.forkThread({
          sourceThreadId: asThreadId("source-unpinned-fork"),
          sourceResumeCursor: { threadId: "provider-source-thread" },
          threadId: asThreadId("target-unpinned-fork"),
          cwd: root,
          runtimeMode: "full-access",
          providerOptions: {
            codex: {
              binaryPath,
              homePath: sourceHome,
              environment: {
                HOME: root,
                SYNARA_FAKE_CODEX_INVOCATIONS_PATH: invocationsPath,
              },
            },
          },
        }),
      ).rejects.toThrow(/fork requires a verified continuation source generation/);
      expect(existsSync(sourceHome)).toBe(false);
      expect(existsSync(invocationsPath)).toBe(false);
    } finally {
      manager.stopAll();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when a successful Codex version check cannot be parsed",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-version-unparseable-"));
      const sourceHome = path.join(root, "source-home");
      const argsPath = path.join(root, "app-server-args.json");
      mkdirSync(sourceHome, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();

      try {
        await expect(
          manager.startSession({
            threadId: asThreadId("thread-unparseable-version"),
            provider: "codex",
            cwd: root,
            runtimeMode: "full-access",
            providerOptions: {
              codex: {
                binaryPath,
                homePath: sourceHome,
                environment: {
                  HOME: root,
                  SYNARA_HOME: path.join(root, "runtime"),
                  SYNARA_FAKE_CODEX_ARGS_PATH: argsPath,
                  SYNARA_FAKE_CODEX_VERSION_OUTPUT: "Codex development build",
                },
              },
            },
          }),
        ).rejects.toThrow(CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE);
        expect(existsSync(argsPath)).toBe(false);
      } finally {
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("fails fast with an upgrade message when codex is below the minimum supported version", async () => {
    const manager = new CodexAppServerManager();
    const events: Array<{ method: string; kind: string; message?: string }> = [];
    manager.on("event", (event) => {
      events.push({
        method: event.method,
        kind: event.kind,
        ...(event.message ? { message: event.message } : {}),
      });
    });

    const versionCheck = vi
      .spyOn(
        manager as unknown as {
          assertSupportedCodexCliVersion: (input: {
            binaryPath: string;
            cwd: string;
            homePath?: string;
          }) => void;
        },
        "assertSupportedCodexCliVersion",
      )
      .mockImplementation(() => {
        throw new Error(
          "Codex CLI v0.104.0 is too old for Synara. Upgrade to v0.105.0 or newer and restart Synara.",
        );
      });

    try {
      await expect(
        manager.startSession({
          threadId: asThreadId("thread-1"),
          provider: "codex",
          runtimeMode: "full-access",
        }),
      ).rejects.toThrow(
        "Codex CLI v0.104.0 is too old for Synara. Upgrade to v0.105.0 or newer and restart Synara.",
      );
      expect(versionCheck).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        {
          method: "session/startFailed",
          kind: "error",
          message:
            "Codex CLI v0.104.0 is too old for Synara. Upgrade to v0.105.0 or newer and restart Synara.",
        },
      ]);
    } finally {
      versionCheck.mockRestore();
      manager.stopAll();
    }
  });
});

describe("sendTurn", () => {
  it("sends text and image user input items to turn/start", async () => {
    const { manager, context, requireSession, sendRequest, updateSession } =
      createSendTurnHarness();

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Inspect this image",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3",
      serviceTier: "fast",
      effort: "high",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      input: [
        {
          type: "text",
          text: "Inspect this image",
          text_elements: [],
        },
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.3-codex",
      serviceTier: "fast",
      effort: "high",
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      activeTurnId: "turn_1",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it("uses approval-required Codex overrides on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness("approval-required");

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Check this before changing files",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...approvalRequiredTurnOverrides,
      input: [
        {
          type: "text",
          text: "Check this before changing files",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("supports image-only turns", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      input: [
        {
          type: "image",
          url: "data:image/png;base64,BBBB",
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("adds selected skills as structured turn/start input items", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Use $check-code for this repo",
      skills: [
        {
          name: "check-code",
          path: "/Users/test/.codex/skills/check-code/SKILL.md",
        },
      ],
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      input: [
        {
          type: "text",
          text: "Use $check-code for this repo",
          text_elements: [],
        },
        {
          type: "skill",
          name: "check-code",
          path: "/Users/test/.codex/skills/check-code/SKILL.md",
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("adds selected plugin mentions as structured turn/start input items", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Use @github to inspect the PR",
      mentions: [
        {
          name: "github",
          path: "plugin://github@openai-curated",
        },
      ],
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      input: [
        {
          type: "text",
          text: "Use @github to inspect the PR",
          text_elements: [],
        },
        {
          type: "mention",
          name: "github",
          path: "plugin://github@openai-curated",
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("passes Codex plan mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan the work",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      input: [
        {
          type: "text",
          text: "Plan the work",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("passes Codex default mode as a collaboration preset on turn/start", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
      interactionMode: "default",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      input: [
        {
          type: "text",
          text: "PLEASE IMPLEMENT THIS PLAN:\n- step 1",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("keeps the session model when interaction mode is set without an explicit model", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.model = "gpt-5.2-codex";

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Plan this with my current session model",
      interactionMode: "plan",
    });

    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      input: [
        {
          type: "text",
          text: "Plan this with my current session model",
          text_elements: [],
        },
      ],
      model: "gpt-5.2-codex",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.2-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("starts a fresh turn even when the session currently reports running", async () => {
    const { manager, context, sendRequest, updateSession } = createSendTurnHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_active";
    sendRequest.mockResolvedValueOnce({
      turn: { id: "turn_next" },
    });

    const result = await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Focus on the failing tests first",
      attachments: [
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.4",
      serviceTier: "fast",
      effort: "high",
      interactionMode: "plan",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_next",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      input: [
        {
          type: "text",
          text: "Focus on the failing tests first",
          text_elements: [],
        },
        {
          type: "image",
          url: "data:image/png;base64,AAAA",
        },
      ],
      model: "gpt-5.4",
      serviceTier: "fast",
      effort: "high",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.4",
          reasoning_effort: "high",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "running",
      activeTurnId: "turn_next",
      resumeCursor: { threadId: "thread_1" },
    });
  });

  it("rejects empty turn input", async () => {
    const { manager } = createSendTurnHarness();

    await expect(
      manager.sendTurn({
        threadId: asThreadId("thread_1"),
      }),
    ).rejects.toThrow("Turn input must include text or attachments.");
  });
});

describe("steerTurn", () => {
  it("steers the active Codex turn when the session is already running", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_active";
    sendRequest.mockResolvedValueOnce({
      turnId: "turn_active",
    });

    const result = await manager.steerTurn({
      threadId: asThreadId("thread_1"),
      input: "Keep going",
    });

    expect(result).toEqual({
      threadId: "thread_1",
      turnId: "turn_active",
      resumeCursor: { threadId: "thread_1" },
    });
    expect(sendRequest).toHaveBeenCalledWith(context, "turn/steer", {
      threadId: "thread_1",
      input: [
        {
          type: "text",
          text: "Keep going",
          text_elements: [],
        },
      ],
      expectedTurnId: "turn_active",
    });
  });

  it("requires turn/steer to return the active turn id", async () => {
    const { manager, context, sendRequest } = createSendTurnHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_active";
    sendRequest.mockResolvedValueOnce({});

    await expect(
      manager.steerTurn({
        threadId: asThreadId("thread_1"),
        input: "Keep going",
      }),
    ).rejects.toThrow("turn/steer response did not include a turn id.");
  });
});

describe("CodexAppServerManager discovery", () => {
  it.runIf(process.platform !== "win32")(
    "does not launch or cache discovery under an auth fingerprint superseded during version check",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-discovery-key-race-"));
      const sourceHome = path.join(root, "codex-home");
      const projectPath = path.join(root, "project");
      const runtimeHome = path.join(root, "runtime");
      const authPath = path.join(sourceHome, "auth.json");
      const messagesPath = path.join(root, "messages.txt");
      const environment = { HOME: root, SYNARA_HOME: runtimeHome };
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      writeFileSync(authPath, codexAuth("workspace-first", "1"), "utf8");
      const authTracking = resolveCodexAuthTracking({
        env: { ...process.env, ...environment },
        homePath: sourceHome,
      });
      const firstFingerprint = readCodexAuthTrackingFingerprint(authTracking);
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();
      const versionCheck = vi
        .spyOn(
          manager as unknown as {
            assertSupportedCodexCliVersion: (input: unknown) => void;
          },
          "assertSupportedCodexCliVersion",
        )
        .mockImplementationOnce(() => {
          writeFileSync(authPath, codexAuth("workspace-second", "2"), "utf8");
        })
        .mockImplementation(() => {});
      const input = {
        cwd: projectPath,
        codexOptions: {
          binaryPath,
          homePath: sourceHome,
          environment: {
            ...environment,
            SYNARA_FAKE_CODEX_MESSAGES_PATH: messagesPath,
          },
        },
      } as const;

      try {
        await expect(manager.listModels(input)).rejects.toThrow(
          /authentication changed before discovery launch/,
        );
        const secondFingerprint = readCodexAuthTrackingFingerprint(authTracking);
        expect(secondFingerprint).not.toBe(firstFingerprint);
        expect(existsSync(messagesPath)).toBe(false);
        expect(
          (
            manager as unknown as {
              discoverySessions: Map<string, unknown>;
              modelCache: Map<string, unknown>;
            }
          ).discoverySessions.size,
        ).toBe(0);
        expect(
          (
            manager as unknown as {
              discoverySessions: Map<string, unknown>;
              modelCache: Map<string, unknown>;
            }
          ).modelCache.size,
        ).toBe(0);

        const fresh = await manager.listModels(input);
        const methodsAfterFreshRequest = readFakeCodexMethods(messagesPath);
        const cached = await manager.listModels(input);
        const internals = manager as unknown as {
          discoverySessions: Map<string, unknown>;
          modelCache: Map<string, unknown>;
        };

        expect(fresh.cached).toBe(false);
        expect(cached.cached).toBe(true);
        expect(readFakeCodexMethods(messagesPath)).toEqual(methodsAfterFreshRequest);
        expect(internals.discoverySessions.size).toBe(1);
        expect(internals.modelCache.size).toBe(1);
        expect(
          JSON.parse([...internals.discoverySessions.keys()][0] ?? "{}") as { auth?: string },
        ).toEqual(expect.objectContaining({ auth: secondFingerprint }));
        expect(
          JSON.parse([...internals.modelCache.keys()][0] ?? "{}") as { auth?: string },
        ).toEqual(expect.objectContaining({ auth: secondFingerprint }));

        const originalCacheGet = internals.modelCache.get.bind(internals.modelCache);
        const cacheGet = vi.spyOn(internals.modelCache, "get").mockImplementationOnce((key) => {
          writeFileSync(authPath, codexAuth("workspace-third", "3"), "utf8");
          return originalCacheGet(key);
        });
        await expect(manager.listModels(input)).rejects.toThrow(
          /authentication changed while resolving discovery metadata/,
        );
        cacheGet.mockRestore();
        const thirdFingerprint = readCodexAuthTrackingFingerprint(authTracking);

        expect(thirdFingerprint).not.toBe(secondFingerprint);
        expect(readFakeCodexMethods(messagesPath)).toEqual(methodsAfterFreshRequest);
        expect(internals.modelCache.size).toBe(1);

        const thirdAccount = await manager.listModels(input);
        const cachedFingerprints = new Set(
          [...internals.modelCache.keys()].map(
            (key) => (JSON.parse(key) as { auth?: string }).auth,
          ),
        );
        expect(thirdAccount.cached).toBe(false);
        expect(internals.discoverySessions.size).toBe(1);
        expect(internals.modelCache.size).toBe(2);
        expect(cachedFingerprints).toEqual(new Set([secondFingerprint, thirdFingerprint]));
        expect(versionCheck).toHaveBeenCalledTimes(3);
      } finally {
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not reuse an auth-unbound active context for fingerprint-bound discovery", async () => {
    const manager = new CodexAppServerManager();
    const threadId = asThreadId("thread-unbound-discovery");
    const activeContext = {
      session: {
        provider: "codex",
        status: "ready",
        runtimeMode: "full-access",
        threadId,
        cwd: "/repo",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
      child: { killed: false },
      stopping: false,
      codexOptions: undefined,
      authFingerprint: undefined,
    };
    const discoveryContext = { session: { ...activeContext.session, threadId: "discovery" } };
    (
      manager as unknown as {
        sessions: Map<ThreadId, unknown>;
      }
    ).sessions.set(threadId, activeContext);
    const getOrCreateDiscoverySession = vi
      .spyOn(
        manager as unknown as {
          getOrCreateDiscoverySession: (
            cwd: string,
            codexOptions?: unknown,
            expectedAuthFingerprint?: string,
          ) => Promise<unknown>;
        },
        "getOrCreateDiscoverySession",
      )
      .mockResolvedValue(discoveryContext);

    const resolved = await (
      manager as unknown as {
        resolveContextForDiscovery: (
          threadId: string | undefined,
          cwd: string | undefined,
          codexOptions: undefined,
          expectedAuthFingerprint: string,
        ) => Promise<unknown>;
      }
    ).resolveContextForDiscovery(undefined, "/repo", undefined, "expected-auth-fingerprint");

    expect(resolved).toBe(discoveryContext);
    expect(getOrCreateDiscoverySession).toHaveBeenCalledWith(
      "/repo",
      undefined,
      "expected-auth-fingerprint",
    );
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when the selected account changes while discovery initializes",
    async () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-discovery-auth-swap-"));
      const sourceHome = path.join(root, "codex-home");
      const projectPath = path.join(root, "project");
      const authPath = path.join(sourceHome, "auth.json");
      const messagesPath = path.join(root, "messages.txt");
      mkdirSync(sourceHome, { recursive: true });
      mkdirSync(projectPath, { recursive: true });
      writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
      writeFileSync(authPath, codexAuth("workspace-first", "1"), "utf8");
      const binaryPath = writeFakeCodexExecutable(root);
      const manager = new CodexAppServerManager();

      try {
        await expect(
          manager.listModels({
            cwd: projectPath,
            codexOptions: {
              binaryPath,
              homePath: sourceHome,
              environment: {
                HOME: root,
                SYNARA_HOME: path.join(root, "runtime"),
                SYNARA_FAKE_CODEX_MESSAGES_PATH: messagesPath,
                SYNARA_FAKE_CODEX_MUTATE_AUTH_PATH: authPath,
                SYNARA_FAKE_CODEX_MUTATE_AUTH_CONTENT: codexAuth("workspace-second", "2"),
              },
            },
          }),
        ).rejects.toThrow(/authentication changed on disk/);

        expect(readFakeCodexMethods(messagesPath)).toEqual(["initialize"]);
        expect(
          (
            manager as unknown as {
              discoverySessions: Map<string, unknown>;
            }
          ).discoverySessions.size,
        ).toBe(0);
      } finally {
        manager.stopAll();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("reuses discovery across token rotation but invalidates account swaps and logout", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "synara-codex-discovery-auth-"));
    const homePath = path.join(root, "codex-home");
    const runtimeHome = path.join(root, "runtime");
    mkdirSync(homePath, { recursive: true });
    writeFileSync(path.join(homePath, "config.toml"), 'model = "gpt-5.5"\n', "utf8");
    const authPath = path.join(homePath, "auth.json");
    const auth = (accountId: string, token: string) =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: accountId,
          access_token: `access-${token}`,
          refresh_token: `refresh-${token}`,
        },
      });
    writeFileSync(authPath, auth("workspace-first", "1"), "utf8");
    const launch = buildCodexProcessLaunchContext({
      env: { ...process.env, SYNARA_HOME: runtimeHome },
      homePath,
      platform: "win32",
      overlayEntryLinker: {
        symlink: (sourcePath, targetPath, type) => {
          if (path.basename(String(targetPath)) === "auth.json") {
            throw new Error("auth symlinks unavailable");
          }
          return symlinkSync(sourcePath, targetPath, type);
        },
        copyFile: copyFileSync,
      },
    });
    const overlayHome = launch.env.CODEX_HOME;
    expect(overlayHome).toBeTruthy();
    if (!overlayHome) throw new Error("Expected managed Codex home");
    const overlayAuthPath = path.join(overlayHome, "auth.json");
    expect(lstatSync(overlayAuthPath).isFile()).toBe(true);
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.5",
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
      account: { type: "unknown", planType: null, sparkEnabled: true },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };
    vi.spyOn(
      manager as unknown as {
        resolveContextForDiscovery: () => unknown;
      },
      "resolveContextForDiscovery",
    ).mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({ result: { items: [] } });
    const input = {
      cwd: "/repo",
      codexOptions: {
        homePath,
        environment: { SYNARA_HOME: runtimeHome },
      },
    } as const;

    try {
      await manager.listModels(input);
      await manager.listModels(input);
      expect(sendRequest).toHaveBeenCalledTimes(1);

      writeFileSync(authPath, auth("workspace-first", "2"), "utf8");
      await manager.listModels(input);
      expect(sendRequest).toHaveBeenCalledTimes(1);

      writeFileSync(authPath, auth("workspace-second", "3"), "utf8");
      await manager.listModels(input);
      expect(sendRequest).toHaveBeenCalledTimes(2);
      expect(readFileSync(overlayAuthPath, "utf8")).toBe(auth("workspace-first", "1"));

      unlinkSync(authPath);
      await manager.listModels(input);
      expect(sendRequest).toHaveBeenCalledTimes(3);
      expect(readFileSync(overlayAuthPath, "utf8")).toBe(auth("workspace-first", "1"));

      buildCodexProcessEnv({
        env: { ...process.env, SYNARA_HOME: runtimeHome },
        homePath,
        platform: "win32",
        overlayEntryLinker: {
          symlink: (sourcePath, targetPath, type) => {
            if (path.basename(String(targetPath)) === "auth.json") {
              throw new Error("auth symlinks unavailable");
            }
            return symlinkSync(sourcePath, targetPath, type);
          },
          copyFile: copyFileSync,
        },
      });
      expect(existsSync(overlayAuthPath)).toBe(false);
    } finally {
      manager.stopAll();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes model/list fast mode metadata from runtime discovery", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.5",
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };

    vi.spyOn(
      manager as unknown as {
        resolveContextForDiscovery: (threadId?: string) => unknown;
      },
      "resolveContextForDiscovery",
    ).mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({
        result: {
          items: [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              supported_reasoning_efforts: ["low", "medium", "high", "xhigh"],
              default_reasoning_effort: "medium",
              additionalSpeedTiers: ["fast"],
            },
          ],
        },
      });

    const result = await manager.listModels("thread_1");

    expect(sendRequest).toHaveBeenCalledWith(context, "model/list", {
      cursor: null,
      limit: 50,
      includeHidden: false,
    });
    expect(result.models).toEqual([
      {
        slug: "gpt-5.5",
        name: "GPT-5.5",
        supportedReasoningEfforts: [
          { value: "low" },
          { value: "medium" },
          { value: "high" },
          { value: "xhigh" },
        ],
        defaultReasoningEffort: "medium",
        supportsFastMode: true,
      },
    ]);
  });

  it("passes explicit Codex account options to model discovery context resolution", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.5",
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };

    const resolveContextForDiscovery = vi
      .spyOn(
        manager as unknown as {
          resolveContextForDiscovery: (
            threadId?: string,
            cwd?: string,
            codexOptions?: unknown,
          ) => unknown;
        },
        "resolveContextForDiscovery",
      )
      .mockReturnValue(context);
    vi.spyOn(
      manager as unknown as {
        sendRequest: (...args: unknown[]) => Promise<unknown>;
      },
      "sendRequest",
    ).mockResolvedValue({
      result: {
        items: [],
      },
    });

    await manager.listModels({
      codexOptions: {
        accountId: "default",
      },
    });

    expect(resolveContextForDiscovery).toHaveBeenCalledWith(
      undefined,
      undefined,
      {
        accountId: "default",
      },
      expect.any(String),
    );
  });

  it("uses a cwd-scoped discovery session instead of an unrelated active session", async () => {
    const manager = new CodexAppServerManager();
    const activeContext = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_active",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        cwd: "/repo-a",
        resumeCursor: { threadId: "thread_active" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      child: {
        killed: false,
      },
      output: {
        close: vi.fn(),
      },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      nextRequestId: 1,
      stopping: false,
    };
    const discoveryContext = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "__codex_discovery__:/repo-b",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        cwd: "/repo-b",
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      child: {
        killed: false,
      },
      output: {
        close: vi.fn(),
      },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      nextRequestId: 1,
      stopping: false,
      discovery: true,
    };

    (
      manager as unknown as {
        sessions: Map<string, unknown>;
      }
    ).sessions.set("thread_active", activeContext);

    const getOrCreateDiscoverySession = vi
      .spyOn(
        manager as unknown as {
          getOrCreateDiscoverySession: (cwd: string) => Promise<unknown>;
        },
        "getOrCreateDiscoverySession",
      )
      .mockResolvedValue(discoveryContext);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({
        result: {
          skills: [],
        },
      });

    await manager.listSkills({
      cwd: "/repo-b",
      threadId: "thread_missing",
    });

    expect(getOrCreateDiscoverySession).toHaveBeenCalledWith(
      "/repo-b",
      undefined,
      expect.any(String),
    );
    expect(sendRequest).toHaveBeenCalledWith(discoveryContext, "skills/list", {
      cwds: ["/repo-b"],
    });
  });

  it("does not satisfy default discovery from an account-scoped active session", async () => {
    const manager = new CodexAppServerManager();
    const activeContext = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_active",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        cwd: "/repo",
        resumeCursor: { threadId: "thread_active" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      codexOptions: {
        accountId: "work",
        shadowHomePath: "/tmp/work-codex-auth",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      child: {
        killed: false,
      },
      output: {
        close: vi.fn(),
      },
      pending: new Map(),
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
      nextRequestId: 1,
      stopping: false,
    };
    const discoveryContext = {
      ...activeContext,
      session: {
        ...activeContext.session,
        threadId: "__codex_discovery__:/repo",
      },
      codexOptions: undefined,
      discovery: true,
    };

    (
      manager as unknown as {
        sessions: Map<string, unknown>;
      }
    ).sessions.set("thread_active", activeContext);

    const getOrCreateDiscoverySession = vi
      .spyOn(
        manager as unknown as {
          getOrCreateDiscoverySession: (cwd: string, codexOptions?: unknown) => Promise<unknown>;
        },
        "getOrCreateDiscoverySession",
      )
      .mockResolvedValue(discoveryContext);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({
        result: {
          items: [],
        },
      });

    await manager.listModels({ cwd: "/repo" });

    expect(getOrCreateDiscoverySession).toHaveBeenCalledWith(
      "/repo",
      undefined,
      expect.any(String),
    );
    expect(sendRequest).toHaveBeenCalledWith(discoveryContext, "model/list", {
      cursor: null,
      limit: 50,
      includeHidden: false,
    });
  });

  it("parses bucketed skills/list responses for the requested cwd", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };

    const resolveContextForDiscovery = vi
      .spyOn(
        manager as unknown as {
          resolveContextForDiscovery: (threadId?: string) => unknown;
        },
        "resolveContextForDiscovery",
      )
      .mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({
        result: {
          data: [
            {
              cwd: "/other",
              skills: [
                {
                  name: "ignore-me",
                  path: "/ignore",
                },
              ],
            },
            {
              cwd: "/repo",
              skills: [
                {
                  name: "check-code",
                  description: "Review repo changes for bugs and risks.",
                  path: "/Users/test/.codex/skills/check-code/SKILL.md",
                  scope: "project",
                  interface: {
                    displayName: "Check Code",
                    shortDescription: "Review code changes",
                  },
                  dependencies: ["rg"],
                },
              ],
            },
          ],
        },
      });

    const result = await manager.listSkills({
      cwd: "/repo",
      threadId: "thread_1",
    });

    expect(resolveContextForDiscovery).toHaveBeenCalledWith(
      "thread_1",
      "/repo",
      undefined,
      expect.any(String),
    );
    expect(sendRequest).toHaveBeenCalledWith(context, "skills/list", {
      cwds: ["/repo"],
    });
    expect(result).toEqual({
      skills: [
        {
          name: "check-code",
          description: "Review repo changes for bugs and risks.",
          path: "/Users/test/.codex/skills/check-code/SKILL.md",
          enabled: true,
          scope: "project",
          interface: {
            displayName: "Check Code",
            shortDescription: "Review code changes",
          },
          dependencies: ["rg"],
        },
      ],
      source: "codex-app-server",
      cached: false,
    });
  });

  it("retries skills/list with cwd when a runtime rejects cwds", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };

    vi.spyOn(
      manager as unknown as {
        resolveContextForDiscovery: (threadId?: string) => unknown;
      },
      "resolveContextForDiscovery",
    ).mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockRejectedValueOnce(new Error('skills/list failed: invalid params: unknown field "cwds"'))
      .mockResolvedValueOnce({
        result: {
          skills: [
            {
              name: "check-code",
              path: "/Users/test/.codex/skills/check-code/SKILL.md",
            },
          ],
        },
      });

    const result = await manager.listSkills({
      cwd: "/repo",
      threadId: "thread_1",
    });

    expect(sendRequest).toHaveBeenNthCalledWith(1, context, "skills/list", {
      cwds: ["/repo"],
    });
    expect(sendRequest).toHaveBeenNthCalledWith(2, context, "skills/list", {
      cwd: "/repo",
    });
    expect(result.skills).toEqual([
      {
        name: "check-code",
        path: "/Users/test/.codex/skills/check-code/SKILL.md",
        enabled: true,
      },
    ]);
  });

  it("parses plugin/list responses for the requested cwd", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };

    const resolveContextForDiscovery = vi
      .spyOn(
        manager as unknown as {
          resolveContextForDiscovery: (threadId?: string, cwd?: string) => unknown;
        },
        "resolveContextForDiscovery",
      )
      .mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({
        result: {
          marketplaces: [
            {
              name: "openai-curated",
              path: "/Users/test/.agents/plugins/marketplace.json",
              interface: {
                displayName: "OpenAI Curated",
              },
              plugins: [
                {
                  id: "plugin/github",
                  name: "github",
                  source: {
                    path: "/Users/test/.codex/plugins/cache/openai-curated/github",
                  },
                  installed: true,
                  enabled: true,
                  installPolicy: "INSTALLED_BY_DEFAULT",
                  authPolicy: "ON_USE",
                  interface: {
                    displayName: "GitHub",
                    shortDescription: "Inspect repositories and pull requests",
                    capabilities: ["pull_requests", "issues"],
                    defaultPrompt: ["Help with repository tasks"],
                    websiteUrl: "https://github.com",
                    screenshots: ["https://example.com/github.png"],
                  },
                },
              ],
            },
          ],
          marketplaceLoadErrors: [
            {
              marketplacePath: "/broken/marketplace.json",
              message: "Invalid marketplace manifest",
            },
          ],
          featuredPluginIds: ["plugin/github"],
          remoteSyncError: "Remote sync unavailable",
        },
      });

    const result = await manager.listPlugins({
      cwd: "/repo",
      threadId: "thread_1",
      forceRemoteSync: true,
    });

    expect(resolveContextForDiscovery).toHaveBeenCalledWith(
      "thread_1",
      "/repo",
      undefined,
      expect.any(String),
    );
    expect(sendRequest).toHaveBeenCalledWith(context, "plugin/list", {
      cwds: ["/repo"],
      forceRemoteSync: true,
    });
    expect(result).toEqual({
      marketplaces: [
        {
          name: "openai-curated",
          path: "/Users/test/.agents/plugins/marketplace.json",
          interface: {
            displayName: "OpenAI Curated",
          },
          plugins: [
            {
              id: "plugin/github",
              name: "github",
              source: {
                type: "local",
                path: "/Users/test/.codex/plugins/cache/openai-curated/github",
              },
              installed: true,
              enabled: true,
              installPolicy: "INSTALLED_BY_DEFAULT",
              authPolicy: "ON_USE",
              interface: {
                displayName: "GitHub",
                shortDescription: "Inspect repositories and pull requests",
                capabilities: ["pull_requests", "issues"],
                defaultPrompt: ["Help with repository tasks"],
                websiteUrl: "https://github.com",
                screenshots: ["https://example.com/github.png"],
              },
            },
          ],
        },
      ],
      marketplaceLoadErrors: [
        {
          marketplacePath: "/broken/marketplace.json",
          message: "Invalid marketplace manifest",
        },
      ],
      featuredPluginIds: ["plugin/github"],
      remoteSyncError: "Remote sync unavailable",
      source: "codex-app-server",
      cached: false,
    });
  });

  it("parses plugin/read responses into plugin detail", async () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        provider: "codex",
        status: "ready",
        threadId: "thread_1",
        runtimeMode: "full-access",
        model: "gpt-5.3-codex",
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      account: {
        type: "unknown",
        planType: null,
        sparkEnabled: true,
      },
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };

    const resolveContextForDiscovery = vi
      .spyOn(
        manager as unknown as {
          resolveContextForDiscovery: (threadId?: string, cwd?: string) => unknown;
        },
        "resolveContextForDiscovery",
      )
      .mockReturnValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (...args: unknown[]) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({
        result: {
          plugin: {
            marketplaceName: "openai-curated",
            marketplacePath: "/Users/test/.agents/plugins/marketplace.json",
            summary: {
              id: "plugin/github",
              name: "github",
              source: {
                path: "/Users/test/.codex/plugins/cache/openai-curated/github",
              },
              installed: true,
              enabled: true,
              installPolicy: "INSTALLED_BY_DEFAULT",
              authPolicy: "ON_USE",
              interface: {
                displayName: "GitHub",
                shortDescription: "Inspect repositories and pull requests",
                longDescription: "Use GitHub tools to work with repositories, issues, and PRs.",
                developerName: "OpenAI",
                category: "Developer Tools",
                capabilities: ["pull_requests", "issues"],
                defaultPrompt: ["Help with repository tasks"],
                websiteUrl: "https://github.com",
                privacyPolicyUrl: "https://github.com/privacy",
                termsOfServiceUrl:
                  "https://docs.github.com/site-policy/github-terms/github-terms-of-service",
                brandColor: "#24292f",
                composerIcon: "github",
                logo: "https://example.com/github-logo.png",
                screenshots: ["https://example.com/github.png"],
              },
            },
            description: "GitHub connector for repository workflows.",
            skills: [
              {
                name: "gh-fix-ci",
                description: "Debug failing GitHub Actions checks.",
                path: "/Users/test/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
                scope: "user",
                dependencies: ["gh"],
              },
            ],
            apps: [
              {
                id: "github-app",
                name: "GitHub App",
                description: "Connected GitHub account",
                installUrl: "https://github.com/apps/openai",
                needsAuth: true,
              },
            ],
            mcpServers: ["GitHub"],
          },
        },
      });

    const result = await manager.readPlugin({
      marketplacePath: "/Users/test/.agents/plugins/marketplace.json",
      pluginName: "github",
    });

    expect(resolveContextForDiscovery).toHaveBeenCalledWith(
      undefined,
      undefined,
      undefined,
      expect.any(String),
    );
    expect(sendRequest).toHaveBeenCalledWith(context, "plugin/read", {
      marketplacePath: "/Users/test/.agents/plugins/marketplace.json",
      pluginName: "github",
    });
    expect(result).toEqual({
      plugin: {
        marketplaceName: "openai-curated",
        marketplacePath: "/Users/test/.agents/plugins/marketplace.json",
        summary: {
          id: "plugin/github",
          name: "github",
          source: {
            type: "local",
            path: "/Users/test/.codex/plugins/cache/openai-curated/github",
          },
          installed: true,
          enabled: true,
          installPolicy: "INSTALLED_BY_DEFAULT",
          authPolicy: "ON_USE",
          interface: {
            displayName: "GitHub",
            shortDescription: "Inspect repositories and pull requests",
            longDescription: "Use GitHub tools to work with repositories, issues, and PRs.",
            developerName: "OpenAI",
            category: "Developer Tools",
            capabilities: ["pull_requests", "issues"],
            defaultPrompt: ["Help with repository tasks"],
            websiteUrl: "https://github.com",
            privacyPolicyUrl: "https://github.com/privacy",
            termsOfServiceUrl:
              "https://docs.github.com/site-policy/github-terms/github-terms-of-service",
            brandColor: "#24292f",
            composerIcon: "github",
            logo: "https://example.com/github-logo.png",
            screenshots: ["https://example.com/github.png"],
          },
        },
        description: "GitHub connector for repository workflows.",
        skills: [
          {
            name: "gh-fix-ci",
            description: "Debug failing GitHub Actions checks.",
            path: "/Users/test/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
            enabled: true,
            scope: "user",
            dependencies: ["gh"],
          },
        ],
        apps: [
          {
            id: "github-app",
            name: "GitHub App",
            description: "Connected GitHub account",
            installUrl: "https://github.com/apps/openai",
            needsAuth: true,
          },
        ],
        mcpServers: ["GitHub"],
      },
      source: "codex-app-server",
      cached: false,
    });
  });
});

describe("thread checkpoint control", () => {
  it("reads thread turns from thread/read", async () => {
    const { manager, context, requireSession, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [
          {
            id: "turn_1",
            items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
          },
        ],
      },
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      cwd: null,
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it("reads thread turns from flat thread/read responses", async () => {
    const { manager, context, sendRequest } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      threadId: "thread_1",
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });

    const result = await manager.readThread(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      cwd: null,
      turns: [
        {
          id: "turn_1",
          items: [{ type: "userMessage", content: [{ type: "text", text: "hello" }] }],
        },
      ],
    });
  });

  it.skipIf(!process.env.CODEX_BINARY_PATH)("forks a provider thread via thread/fork", async () => {
    const { manager, sendRequest } = createThreadControlHarness();
    buildCodexProcessEnv();
    const continuationGeneration = readCodexSharedContinuationGeneration();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_forked",
      },
    });

    const result = await manager.forkThread({
      sourceThreadId: asThreadId("thread_1"),
      sourceResumeCursor: {
        threadId: "thread_1",
      },
      expectedCodexContinuationGeneration: continuationGeneration!,
      threadId: asThreadId("thread_2"),
      runtimeMode: "full-access",
    });

    expect(sendRequest).toHaveBeenNthCalledWith(
      3,
      expect.anything(),
      "thread/fork",
      expect.objectContaining({
        threadId: "thread_1",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
    expect(result).toEqual({
      threadId: "thread_2",
      resumeCursor: {
        threadId: "thread_forked",
      },
    });
  });

  it("rolls back turns via thread/rollback and resets session running state", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    sendRequest.mockResolvedValue({
      thread: {
        id: "thread_1",
        turns: [],
      },
    });

    const result = await manager.rollbackThread(asThreadId("thread_1"), 2);

    expect(sendRequest).toHaveBeenCalledWith(context, "thread/rollback", {
      threadId: "thread_1",
      numTurns: 2,
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    expect(result).toEqual({
      threadId: "thread_1",
      cwd: null,
      turns: [],
    });
  });

  it("retries review interrupt with the latest review turn from thread/read after timeout", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_review_old";
    context.reviewTurnIds.add("turn_review_old");

    sendRequest
      .mockRejectedValueOnce(new Error("Timed out waiting for turn/interrupt."))
      .mockResolvedValueOnce({
        thread: {
          id: "thread_1",
          turns: [
            {
              id: "turn_review_new",
              items: [{ type: "enteredReviewMode" }],
            },
          ],
        },
      })
      .mockResolvedValueOnce({});

    await manager.interruptTurn(asThreadId("thread_1"));

    expect(sendRequest).toHaveBeenNthCalledWith(1, context, "turn/interrupt", {
      threadId: "thread_1",
      turnId: "turn_review_old",
    });
    expect(sendRequest).toHaveBeenNthCalledWith(2, context, "thread/read", {
      threadId: "thread_1",
      includeTurns: true,
    });
    expect(sendRequest).toHaveBeenNthCalledWith(3, context, "turn/interrupt", {
      threadId: "thread_1",
      turnId: "turn_review_new",
    });
    expect(updateSession).toHaveBeenCalledWith(context, {
      activeTurnId: "turn_review_new",
    });
  });

  it("settles review interrupt when thread/read already shows exited review mode", async () => {
    const { manager, context, sendRequest, updateSession } = createThreadControlHarness();
    context.session.status = "running";
    context.session.activeTurnId = "turn_review_old";
    context.reviewTurnIds.add("turn_review_old");

    sendRequest
      .mockRejectedValueOnce(new Error("Timed out waiting for turn/interrupt."))
      .mockResolvedValueOnce({
        thread: {
          id: "thread_1",
          turns: [
            {
              id: "turn_review_old",
              items: [{ type: "enteredReviewMode" }, { type: "exitedReviewMode" }],
            },
          ],
        },
      });

    await manager.interruptTurn(asThreadId("thread_1"));

    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
  });

  it("emits compaction progress before waiting for thread/compact/start", async () => {
    const { manager, context, sendRequest, updateSession, emitEvent } =
      createThreadControlHarness();
    let resolveRequest: (() => void) | undefined;
    sendRequest.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = () => resolve({});
        }),
    );

    const compactPromise = manager.compactThread(asThreadId("thread_1"));

    await vi.waitFor(() => {
      expect(sendRequest).toHaveBeenCalledWith(context, "thread/compact/start", {
        threadId: "thread_1",
      });
      expect(updateSession).toHaveBeenCalledWith(context, {
        status: "running",
      });
      expect(emitEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "notification",
          provider: "codex",
          threadId: "thread_1",
          method: "thread/compacting",
          message: "Compacting context",
          payload: {
            threadId: "thread_1",
            state: "compacting",
          },
        }),
      );
    });

    resolveRequest?.();
    await compactPromise;
  });
});

describe("respondToRequest", () => {
  it("keeps acceptForSession active for later Codex turns", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent, sendRequest } =
      createPendingApprovalHarness();

    await manager.respondToRequest(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-approval-1"),
      "acceptForSession",
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        decision: "acceptForSession",
      },
    });
    expect(context.sessionApprovalOverride).toEqual(fullAccessTurnOverrides);
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/requestApproval/decision",
        requestKind: "command",
        payload: {
          requestId: "req-approval-1",
          requestKind: "command",
          decision: "acceptForSession",
        },
      }),
    );

    await manager.sendTurn({
      threadId: asThreadId("thread_1"),
      input: "Continue without asking again",
    });

    expect(sendRequest).toHaveBeenLastCalledWith(context, "turn/start", {
      threadId: "thread_1",
      ...fullAccessTurnOverrides,
      input: [
        {
          type: "text",
          text: "Continue without asking again",
          text_elements: [],
        },
      ],
      model: "gpt-5.3-codex",
    });
  });

  it("auto-resolves later approval requests during an always-allowed Codex session", async () => {
    const { manager, context, writeMessage, emitEvent } = createPendingApprovalHarness();

    await manager.respondToRequest(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-approval-1"),
      "acceptForSession",
    );
    writeMessage.mockClear();
    emitEvent.mockClear();

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 99,
      method: "item/fileChange/requestApproval",
      params: {
        turnId: "turn_2",
        itemId: "item_file_change",
        path: "apps/web/src/components/chat/ComposerPendingApprovalActions.tsx",
      },
    });

    expect(context.pendingApprovals.size).toBe(0);
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 99,
      result: {
        decision: "acceptForSession",
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notification",
        method: "item/requestApproval/decision",
        turnId: "turn_2",
        itemId: "item_file_change",
        requestKind: "file-change",
        payload: expect.objectContaining({
          requestKind: "file-change",
          decision: "acceptForSession",
        }),
      }),
    );
    expect(
      emitEvent.mock.calls.some(([event]) => (event as { kind?: string }).kind === "request"),
    ).toBe(false);
  });
});

describe("respondToUserInput", () => {
  it("serializes canonical answers to Codex native answer objects", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: "All request methods",
        compat: "Keep current envelope",
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: ["All request methods"] },
          compat: { answers: ["Keep current envelope"] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: ["All request methods"] },
            compat: { answers: ["Keep current envelope"] },
          },
        },
      }),
    );
  });

  it("preserves explicit empty multi-select answers", async () => {
    const { manager, context, requireSession, writeMessage, emitEvent } =
      createPendingUserInputHarness();

    await manager.respondToUserInput(
      asThreadId("thread_1"),
      ApprovalRequestId.makeUnsafe("req-user-input-1"),
      {
        scope: [],
      },
    );

    expect(requireSession).toHaveBeenCalledWith("thread_1");
    expect(writeMessage).toHaveBeenCalledWith(context, {
      id: 42,
      result: {
        answers: {
          scope: { answers: [] },
        },
      },
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/tool/requestUserInput/answered",
        payload: {
          requestId: "req-user-input-1",
          answers: {
            scope: { answers: [] },
          },
        },
      }),
    );
  });

  it("tracks file-read approval requests with the correct method", () => {
    const manager = new CodexAppServerManager();
    const context = {
      session: {
        sessionId: "sess_1",
        provider: "codex",
        status: "ready",
        threadId: asThreadId("thread_1"),
        resumeCursor: { threadId: "thread_1" },
        createdAt: "2026-02-10T00:00:00.000Z",
        updatedAt: "2026-02-10T00:00:00.000Z",
      },
      pendingApprovals: new Map(),
      pendingUserInputs: new Map(),
      collabReceiverTurns: new Map(),
      collabReceiverParents: new Map(),
    };
    type ApprovalRequestContext = {
      session: typeof context.session;
      pendingApprovals: typeof context.pendingApprovals;
      pendingUserInputs: typeof context.pendingUserInputs;
    };

    (
      manager as unknown as {
        handleServerRequest: (
          context: ApprovalRequestContext,
          request: Record<string, unknown>,
        ) => void;
      }
    ).handleServerRequest(context, {
      jsonrpc: "2.0",
      id: 42,
      method: "item/fileRead/requestApproval",
      params: {},
    });

    const request = Array.from(context.pendingApprovals.values())[0];
    expect(request?.requestKind).toBe("file-read");
    expect(request?.method).toBe("item/fileRead/requestApproval");
  });
});

describe("collab child conversation routing", () => {
  it("preserves child notification turn ids and annotates the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/agentMessage/delta",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "msg_child_1",
        delta: "working",
      },
    });

    expect(emitEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        turnId: "turn_child_1",
        parentTurnId: "turn_parent",
        itemId: "msg_child_1",
        providerThreadId: "child_provider_1",
        providerParentThreadId: "provider_parent",
      }),
    );
  });

  it("suppresses child lifecycle notifications without mutating the parent session state", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();
    updateSession.mockClear();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/started",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1" },
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/completed",
      params: {
        threadId: "child_provider_1",
        turn: { id: "turn_child_1", status: "completed" },
      },
    });

    expect(emitEvent).not.toHaveBeenCalled();
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("forwards child plan notifications so the active plan card can advance", () => {
    // Plan events (`turn/plan/updated`, `item/plan/delta`) are intentionally NOT
    // suppressed for child conversations. Suppressing them freezes the plan UI at
    // its initial all-pending snapshot and prevents the card from ticking off steps
    // as work progresses.
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/plan/updated",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        plan: [{ step: "Plan child work", status: "inProgress" }],
      },
    });

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/plan/delta",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "plan_item_child_1",
        delta: "still planning",
      },
    });

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "turn/plan/updated",
        turnId: "turn_child_1",
        parentTurnId: "turn_parent",
      }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/plan/delta",
        turnId: "turn_child_1",
        parentTurnId: "turn_parent",
      }),
    );
  });

  it("does not suppress provider-parent-only child notifications without a mapped parent turn", () => {
    const { manager, context, emitEvent, updateSession } = createCollabNotificationHarness();
    context.collabReceiverParents.set("child_provider_1", "provider_parent");

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/plan/updated",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        plan: [{ step: "Plan child work", status: "inProgress" }],
      },
    });

    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "turn/plan/updated",
        turnId: "turn_child_1",
        providerThreadId: "child_provider_1",
        providerParentThreadId: "provider_parent",
      }),
    );
    expect(updateSession).not.toHaveBeenCalled();
  });

  it("preserves child approval requests and annotates the parent turn", () => {
    const { manager, context, emitEvent } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "collabAgentToolCall",
          id: "call_collab_1",
          receiverThreadIds: ["child_provider_1"],
        },
        threadId: "provider_parent",
        turnId: "turn_parent",
      },
    });
    emitEvent.mockClear();

    (
      manager as unknown as {
        handleServerRequest: (context: unknown, request: Record<string, unknown>) => void;
      }
    ).handleServerRequest(context, {
      id: 42,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "child_provider_1",
        turnId: "turn_child_1",
        itemId: "call_child_1",
        command: "bun install",
      },
    });

    expect(Array.from(context.pendingApprovals.values())[0]).toEqual(
      expect.objectContaining({
        turnId: "turn_child_1",
        itemId: "call_child_1",
      }),
    );
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "item/commandExecution/requestApproval",
        turnId: "turn_child_1",
        parentTurnId: "turn_parent",
        itemId: "call_child_1",
        providerThreadId: "child_provider_1",
        providerParentThreadId: "provider_parent",
      }),
    );
  });
});

describe("handleServerNotification error normalization", () => {
  it("settles native review when review mode exits", () => {
    const { manager, context, updateSession, emitEvent } = createCollabNotificationHarness();
    context.reviewTurnIds.add("turn_parent");
    context.reviewTurnIds.add("turn_child");
    context.session.activeTurnId = "turn_child";

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "item/completed",
      params: {
        item: {
          type: "exitedReviewMode",
          id: "turn_parent",
          review: "The working tree is clean.",
        },
        threadId: "provider_parent",
      },
    });

    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "notification",
        method: "turn/completed",
        turnId: "turn_child",
        threadId: "thread_1",
        payload: {
          turn: {
            id: "turn_child",
            status: "completed",
          },
        },
      }),
    );
  });

  it("clears the running session turn when Codex aborts a turn", () => {
    const { manager, context, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/aborted",
      params: {
        threadId: "provider_parent",
        turn: {
          id: "turn_parent",
          status: "interrupted",
        },
      },
    });

    expect(updateSession).toHaveBeenCalledWith(context, {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
  });

  it("normalizes duplicate tool argument errors on turn completion", () => {
    const { manager, context, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "turn/completed",
      params: {
        threadId: "provider_parent",
        turn: {
          id: "turn_parent",
          status: "failed",
          error: {
            message:
              "failed to parse function arguments: duplicate field `yield_time_ms` at line 1 column 114",
          },
        },
      },
    });

    expect(updateSession).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        status: "error",
        lastError: "Tool call failed because the same argument was sent twice (yield_time_ms).",
      }),
    );
  });

  it("normalizes duplicate tool argument errors on runtime error notifications", () => {
    const { manager, context, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "error",
      params: {
        threadId: "provider_parent",
        error: {
          message:
            "failed to parse function arguments: duplicate field `yield_time_ms` at line 1 column 114",
        },
        willRetry: false,
      },
    });

    expect(updateSession).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        status: "error",
        lastError: "Tool call failed because the same argument was sent twice (yield_time_ms).",
      }),
    );
  });

  it("does not promote non-fatal tool runtime errors to session lastError", () => {
    const { manager, context, updateSession } = createCollabNotificationHarness();

    (
      manager as unknown as {
        handleServerNotification: (context: unknown, notification: Record<string, unknown>) => void;
      }
    ).handleServerNotification(context, {
      method: "error",
      params: {
        threadId: "provider_parent",
        error: {
          message:
            "write_stdin failed: stdin is closed for this session; rerun exec_command with tty=true to keep stdin open",
        },
        willRetry: false,
      },
    });

    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe.skipIf(!process.env.CODEX_BINARY_PATH)("startSession live Codex resume", () => {
  it("keeps prior thread history when resuming with a changed runtime mode", async () => {
    const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "codex-live-resume-"));
    writeFileSync(path.join(workspaceDir, "README.md"), "hello\n", "utf8");

    const manager = new CodexAppServerManager();

    try {
      const firstSession = await manager.startSession({
        threadId: asThreadId("thread-live"),
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "full-access",
        providerOptions: {
          codex: {
            ...(process.env.CODEX_BINARY_PATH ? { binaryPath: process.env.CODEX_BINARY_PATH } : {}),
            ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
          },
        },
      });

      const firstTurn = await manager.sendTurn({
        threadId: firstSession.threadId,
        input: `Reply with exactly the word ALPHA ${randomUUID()}`,
      });

      expect(firstTurn.threadId).toBe(firstSession.threadId);

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(firstSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(0);
        },
        { timeout: 120_000, interval: 1_000 },
      );

      const firstSnapshot = await manager.readThread(firstSession.threadId);
      const originalThreadId = firstSnapshot.threadId;
      const originalTurnCount = firstSnapshot.turns.length;
      const continuationGeneration = readCodexSharedContinuationGeneration({
        ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
      });
      expect(continuationGeneration).toMatch(/^[0-9a-f-]{36}$/);

      manager.stopSession(firstSession.threadId);

      const resumedSession = await manager.startSession({
        threadId: firstSession.threadId,
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "approval-required",
        resumeCursor: firstSession.resumeCursor,
        expectedCodexContinuationGeneration: continuationGeneration!,
        providerOptions: {
          codex: {
            ...(process.env.CODEX_BINARY_PATH ? { binaryPath: process.env.CODEX_BINARY_PATH } : {}),
            ...(process.env.CODEX_HOME_PATH ? { homePath: process.env.CODEX_HOME_PATH } : {}),
          },
        },
      });

      expect(resumedSession.threadId).toBe(originalThreadId);

      const resumedSnapshotBeforeTurn = await manager.readThread(resumedSession.threadId);
      expect(resumedSnapshotBeforeTurn.threadId).toBe(originalThreadId);
      expect(resumedSnapshotBeforeTurn.turns.length).toBeGreaterThanOrEqual(originalTurnCount);

      await manager.sendTurn({
        threadId: resumedSession.threadId,
        input: `Reply with exactly the word BETA ${randomUUID()}`,
      });

      await vi.waitFor(
        async () => {
          const snapshot = await manager.readThread(resumedSession.threadId);
          expect(snapshot.turns.length).toBeGreaterThan(originalTurnCount);
        },
        { timeout: 120_000, interval: 1_000 },
      );
    } finally {
      manager.stopAll();
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }, 180_000);
});
