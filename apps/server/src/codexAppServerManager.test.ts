import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";

import {
  buildCodexProcessEnv,
  buildCodexInitializeParams,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  CodexAppServerManager,
  classifyCodexStderrLine,
  isRecoverableThreadResumeError,
  normalizeCodexModelSlug,
  readCodexAccountSnapshot,
  resolveCodexModelForAccount,
} from "./codexAppServerManager";

const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);

function createSendTurnHarness() {
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
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "t3-codex-env-"));
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
        env: { SHELL: "/bin/zsh", PATH: "/usr/bin" },
        homePath: tempDir,
        platform: "darwin",
        readEnvironment,
      });

      expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", [
        "PATH",
        "SSH_AUTH_SOCK",
        "MY_COMPANY_PROXY_KEY",
      ]);
      expect(env.CODEX_HOME).toBe(tempDir);
      expect(env.MY_COMPANY_PROXY_KEY).toBe("proxy-secret");
      expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
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
    ).toBe("gpt-5.3-codex");
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
        name: "t3code_desktop",
        title: "DP Code Desktop",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
  });

  it("uses an isolated scratch workspace when startSession receives no cwd", async () => {
    const manager = new CodexAppServerManager();

    try {
      const session = await manager.startSession({
        threadId: asThreadId("thread-1"),
        provider: "codex",
        runtimeMode: "full-access",
      });
      expect(session.cwd).toContain(`${path.sep}dpcode-codex-workspaces${path.sep}thread-1`);
    } finally {
      manager.stopAll();
    }
  });

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
          "Codex CLI v0.36.0 is too old for DP Code. Upgrade to v0.37.0 or newer and restart DP Code.",
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
        "Codex CLI v0.36.0 is too old for DP Code. Upgrade to v0.37.0 or newer and restart DP Code.",
      );
      expect(versionCheck).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        {
          method: "session/startFailed",
          kind: "error",
          message:
            "Codex CLI v0.36.0 is too old for DP Code. Upgrade to v0.37.0 or newer and restart DP Code.",
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

    expect(getOrCreateDiscoverySession).toHaveBeenCalledWith("/repo-b");
    expect(sendRequest).toHaveBeenCalledWith(discoveryContext, "skills/list", {
      cwds: ["/repo-b"],
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

    expect(resolveContextForDiscovery).toHaveBeenCalledWith("thread_1", "/repo");
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

    expect(resolveContextForDiscovery).toHaveBeenCalledWith("thread_1", "/repo");
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

    expect(resolveContextForDiscovery).toHaveBeenCalledWith(undefined);
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
      threadId: asThreadId("thread_2"),
      runtimeMode: "full-access",
    });

    expect(sendRequest).toHaveBeenNthCalledWith(3, expect.anything(), "thread/fork", {
      threadId: "thread_1",
    });
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

      manager.stopSession(firstSession.threadId);

      const resumedSession = await manager.startSession({
        threadId: firstSession.threadId,
        provider: "codex",
        cwd: workspaceDir,
        runtimeMode: "approval-required",
        resumeCursor: firstSession.resumeCursor,
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
