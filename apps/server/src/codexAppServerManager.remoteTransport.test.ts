/**
 * Regression coverage for the per-session remote transport seam: a sandbox-backed
 * thread runs `codex app-server` inside its provisioned instance and streams back
 * over a supplied {@link JsonRpcLineTransport}, instead of spawning a local codex
 * process. Proves that a per-session `createTransport` on `startSession` input is
 * honored and that the host CLI version gate is skipped when one is supplied
 * (otherwise a remote thread with no local binary could never start).
 *
 * @module codexAppServerManager.remoteTransport.test
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { ThreadId } from "@t3tools/contracts";

import { CodexAppServerManager } from "./codexAppServerManager";
import {
  makeInMemoryJsonRpcTransport,
  type InMemoryTransportController,
} from "./provider/process/JsonRpcLineTransport";

interface OutboundFrame {
  readonly method?: string;
  readonly id?: number | string;
}

// Auto-answer the handshake requests the manager writes (initialize, model/list,
// account/read, thread/start) so a session can reach `ready` with no real codex.
const scriptHandshake = (controller: InMemoryTransportController): Promise<void> => {
  const responders: Record<string, () => unknown> = {
    initialize: () => ({ userAgent: "codex-remote-seam-test" }),
    "model/list": () => ({ items: [] }),
    "account/read": () => ({ account: { type: "apiKey" } }),
    "thread/start": () => ({ thread: { id: "provider_thread_remote" } }),
  };
  return (async () => {
    for (;;) {
      let frame: OutboundFrame;
      try {
        frame = (await Effect.runPromise(controller.takeOutboundMessage)) as OutboundFrame;
      } catch {
        return;
      }
      if (typeof frame.method === "string" && frame.id !== undefined) {
        const result = responders[frame.method]?.() ?? {};
        await Effect.runPromise(controller.pushInboundMessage({ id: frame.id, result }));
      }
    }
  })();
};

describe("CodexAppServerManager per-session remote transport", () => {
  it("honors a per-session createTransport and skips the local CLI version gate", async () => {
    const built = Effect.runSync(makeInMemoryJsonRpcTransport());
    const pump = scriptHandshake(built.controller);
    // No constructor factory: the manager defaults to the local-spawn path, so the
    // per-session factory is the only thing that can route this session remote.
    const manager = new CodexAppServerManager();
    let factoryCalls = 0;

    try {
      const session = await manager.startSession({
        threadId: ThreadId.makeUnsafe("thread_remote_seam"),
        provider: "codex",
        cwd: "/sandbox/root",
        runtimeMode: "full-access",
        // A binary that does not exist on this host: were the version gate to run
        // it would throw, so reaching `ready` proves the gate was skipped.
        providerOptions: { codex: { binaryPath: "codex-not-on-this-host" } },
        createTransport: async () => {
          factoryCalls += 1;
          return built.transport;
        },
      });

      expect(session.status).toBe("ready");
      // The handshake ran over the supplied transport, not a local process.
      expect(factoryCalls).toBe(1);
    } finally {
      manager.stopAll();
      await Effect.runPromise(built.transport.close).catch(() => {});
      await pump.catch(() => {});
    }
  });

  it("surfaces a per-session transport factory rejection as a session-start failure", async () => {
    // When the remote runtime fails to start the agent (e.g. exec rejects), the
    // rejection must propagate out of startSession with a usable message rather
    // than being swallowed into a stuck "connecting" session.
    const manager = new CodexAppServerManager();
    try {
      await expect(
        manager.startSession({
          threadId: ThreadId.makeUnsafe("thread_remote_reject"),
          provider: "codex",
          cwd: "/sandbox/root",
          runtimeMode: "full-access",
          createTransport: async () => {
            throw new Error("remote runtime exec failed: instance gone");
          },
        }),
      ).rejects.toThrow(/remote runtime exec failed/);
    } finally {
      manager.stopAll();
    }
  });

  it("falls back to the local spawn path when no per-session factory is supplied", async () => {
    // Without a factory and with a missing binary, the version gate must run and
    // fail — the complement of the case above, pinning the gate to the local path.
    const manager = new CodexAppServerManager();
    try {
      await expect(
        manager.startSession({
          threadId: ThreadId.makeUnsafe("thread_local_gate"),
          provider: "codex",
          cwd: "/tmp/local-gate",
          runtimeMode: "full-access",
          providerOptions: { codex: { binaryPath: "codex-not-on-this-host" } },
        }),
      ).rejects.toThrow();
    } finally {
      manager.stopAll();
    }
  });
});
