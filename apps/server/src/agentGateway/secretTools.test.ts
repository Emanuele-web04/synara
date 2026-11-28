import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ThreadId } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SecretRequestGate } from "../secrets/SecretRequestGate.ts";
import type { McpToolCallResult } from "./protocol.ts";
import { type AgentGatewaySecretToolsInput, makeAgentGatewaySecretTools } from "./secretTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

const THREAD_ID = "thread-secret-tool";

type Appended = Parameters<AgentGatewaySecretToolsInput["appendActivity"]>[0];

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:secret",
      threadId: THREAD_ID,
      provider: "claudeAgent",
      turnId: "turn-1",
    },
    callerThreadId: THREAD_ID,
    callerThreadLabel: "Secrets",
    callerSessionKey: "gateway-session:secret",
    callerProvider: "claudeAgent",
    callerCapabilities: new Set(["thread:read", "thread:write"]),
    callerTurnId: "turn-1",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
    ...overrides,
  };
}

const json = (result: McpToolCallResult) =>
  JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "null");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "synara-secret-tool-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup() {
  const gate = new SecretRequestGate();
  const appended: Appended[] = [];
  const [tool] = makeAgentGatewaySecretTools({
    gate,
    filesDir: path.join(root, "requests"),
    appendActivity: (input) => Effect.sync(() => void appended.push(input)),
  });
  const requested = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const card = appended.find((entry) => entry.kind === "secret.requested");
      if (card) return card;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("no card was published");
  };
  return { gate, appended, tool: tool!, requested };
}

describe("synara_request_secret", () => {
  it("is always loaded for Claude and only accepts file delivery", () => {
    const { tool } = setup();
    expect(tool.definition.name).toBe("synara_request_secret");
    expect(tool.definition._meta?.["anthropic/alwaysLoad"]).toBe(true);
    expect(tool.requiresActiveTurn).toBe(true);
  });

  it("publishes a card without the value and returns only the file path", async () => {
    const { gate, appended, tool, requested } = setup();
    const call = Effect.runPromise(
      tool.handler(
        {
          label: "sudo password",
          reason: "Needed to install a package.",
          url: "https://example.com/help",
          delivery: "file",
        },
        makeContext(),
      ),
    );
    const card = await requested();
    expect(card.payload).toEqual({
      requestId: card.requestId,
      label: "sudo password",
      reason: "Needed to install a package.",
      url: "https://example.com/help",
    });
    await gate.answer({
      threadId: ThreadId.makeUnsafe(THREAD_ID),
      requestId: card.requestId,
      answer: { type: "save", secret: "correct horse" },
    });
    const result = json(await call);
    expect(result.status).toBe("saved");
    expect(Object.keys(result)).toEqual(["status", "file"]);
    expect(await readFile(result.file, "utf8")).toBe("correct horse");
    expect(appended.map((entry) => entry.kind)).toEqual(["secret.requested", "secret.resolved"]);
    expect(appended[1]!.payload).toEqual({ requestId: card.requestId, status: "saved" });
    expect(JSON.stringify(appended)).not.toContain("correct horse");
  });

  it("tells the agent not to ask again after a decline", async () => {
    const { gate, tool, requested } = setup();
    const call = Effect.runPromise(
      tool.handler({ label: "API token", reason: "Deploy." }, makeContext()),
    );
    const card = await requested();
    await gate.answer({
      threadId: ThreadId.makeUnsafe(THREAD_ID),
      requestId: card.requestId,
      answer: { type: "decline" },
    });
    const result = json(await call);
    expect(result.status).toBe("declined");
    expect(result.note).toMatch(/Don't ask for it in chat/);
  });

  it("rejects bad arguments and calls outside a turn without publishing", async () => {
    const { appended, tool } = setup();
    const bad = [
      [{ reason: "x" }, /label/],
      [{ label: "x", reason: "y", url: "javascript:alert(1)" }, /http\(s\) URL/],
      [{ label: "x", reason: "y", delivery: "secretRef" }, /must be "file"/],
      [{ label: "\u0007", reason: "y" }, /visible text/],
    ] as const;
    for (const [args, message] of bad) {
      const result = await Effect.runPromise(tool.handler({ ...args }, makeContext()));
      expect(result.isError).toBe(true);
      expect(result.content[0]?.type === "text" && result.content[0].text).toMatch(message);
    }
    const noTurn = await Effect.runPromise(
      tool.handler({ label: "x", reason: "y" }, makeContext({ callerTurnId: null })),
    );
    expect(noTurn.isError).toBe(true);
    expect(appended).toEqual([]);
  });
});
