import * as NodeServices from "@effect/platform-node/NodeServices";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

import { ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { Effect, Layer, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { ServerConfig } from "../../config.ts";
import { KiroAdapter } from "../Services/KiroAdapter.ts";
import {
  extractKiroTerminalPlanMarkdown,
  makeKiroAdapterLive,
  parseKiroResume,
  resolveKiroTurnModeId,
} from "./KiroAdapter.ts";

const modes = {
  currentModeId: "kiro_default",
  availableModes: [
    { id: "kiro_default", name: "kiro_default" },
    { id: "kiro_planner", name: "kiro_planner", description: "Plans before implementing" },
    { id: "reviewer", name: "reviewer" },
  ],
};

describe("parseKiroResume", () => {
  it("reads only the versioned Kiro cursor", () => {
    expect(parseKiroResume({ schemaVersion: 1, sessionId: " kiro-1 " })).toEqual({
      sessionId: "kiro-1",
    });
    expect(parseKiroResume({ schemaVersion: 2, sessionId: "kiro-1" })).toBeUndefined();
    expect(parseKiroResume({ schemaVersion: 1, sessionId: " " })).toBeUndefined();
    expect(parseKiroResume("kiro-1")).toBeUndefined();
  });
});

describe("resolveKiroTurnModeId", () => {
  it("switches Plan turns to Kiro's planning agent", () => {
    expect(
      resolveKiroTurnModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: modes,
        initialModeId: "kiro_default",
      }),
    ).toBe("kiro_planner");
  });

  it("returns default turns to the agent the session started with", () => {
    expect(
      resolveKiroTurnModeId({
        interactionMode: "default",
        runtimeMode: "full-access",
        modeState: { ...modes, currentModeId: "kiro_planner" },
        initialModeId: "reviewer",
      }),
    ).toBe("reviewer");
  });

  it("does nothing when the session is already in the target agent", () => {
    expect(
      resolveKiroTurnModeId({
        interactionMode: "default",
        runtimeMode: "full-access",
        modeState: modes,
        initialModeId: "kiro_default",
      }),
    ).toBeUndefined();
    expect(
      resolveKiroTurnModeId({
        interactionMode: "plan",
        runtimeMode: "full-access",
        modeState: undefined,
        initialModeId: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("extractKiroTerminalPlanMarkdown", () => {
  it("captures the final answer of Plan turns only", () => {
    expect(
      extractKiroTerminalPlanMarkdown({ interactionMode: "plan", assistantText: "\n# Plan\n" }),
    ).toBe("# Plan");
    expect(
      extractKiroTerminalPlanMarkdown({ interactionMode: "default", assistantText: "# Plan" }),
    ).toBeUndefined();
    expect(
      extractKiroTerminalPlanMarkdown({ interactionMode: "plan", assistantText: "  " }),
    ).toBeUndefined();
  });
});

// Drives the real spawn path: a `kiro-cli` wrapper that execs the repository's
// deterministic ACP mock agent, so startup, model selection, mode switching,
// prompting and teardown all cross an actual stdio JSON-RPC boundary.
describe.skipIf(process.platform === "win32")("KiroAdapter over a real ACP subprocess", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const makeWrapper = (env: Readonly<Record<string, string>> = {}) => {
    const dir = mkdtempSync(nodePath.join(tmpdir(), "kiro-adapter-test-"));
    tempDirs.push(dir);
    const requestLog = nodePath.join(dir, "requests.log");
    const mockAgent = fileURLToPath(new URL("../../../scripts/acp-mock-agent.ts", import.meta.url));
    const wrapper = nodePath.join(dir, "kiro-cli");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        [
          ...Object.entries({ ...env, SYNARA_ACP_REQUEST_LOG_PATH: requestLog }).map(
            ([key, value]) => `${key}=${JSON.stringify(value)}`,
          ),
          "exec",
          JSON.stringify(process.execPath),
          JSON.stringify(mockAgent),
        ].join(" "),
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);
    const requests = () =>
      readFileSync(requestLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    return { wrapper, requests };
  };

  const layerFor = (binaryPath: string) =>
    makeKiroAdapterLive({ binaryPath }).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "kiro-adapter-" })),
      Layer.provideMerge(NodeServices.layer),
    );

  const runPlanThenDefaultTurn = async (wrapper: string) => {
    const events: ProviderRuntimeEvent[] = [];
    const threadId = ThreadId.makeUnsafe("kiro-wire");

    const { planTurnId, defaultTurnId } = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        yield* adapter.streamEvents.pipe(
          Stream.runForEach((event) => Effect.sync(() => events.push(event))),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        const session = yield* adapter.startSession({
          provider: "kiro",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
          modelSelection: { provider: "kiro", model: "composer-2" },
        });
        expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "mock-session-1" });

        const waitForCompletion = (turnId: string) =>
          Effect.gen(function* () {
            for (let attempt = 0; attempt < 400; attempt += 1) {
              if (events.some((e) => e.type === "turn.completed" && e.turnId === turnId)) return;
              yield* Effect.sleep(10);
            }
            throw new Error(`turn ${turnId} did not complete`);
          });

        const planTurn = yield* adapter.sendTurn({
          threadId,
          input: "plan the change",
          attachments: [],
          interactionMode: "plan",
        });
        yield* waitForCompletion(planTurn.turnId);
        // Model changes apply in-session on the next turn, without a restart.
        const defaultTurn = yield* adapter.sendTurn({
          threadId,
          input: "implement it",
          attachments: [],
          modelSelection: { provider: "kiro", model: "default" },
        });
        yield* waitForCompletion(defaultTurn.turnId);
        yield* adapter.stopSession(threadId);
        return { planTurnId: planTurn.turnId, defaultTurnId: defaultTurn.turnId };
      }).pipe(Effect.scoped, Effect.provide(layerFor(wrapper))),
    );
    return { events, threadId, planTurnId, defaultTurnId };
  };

  it("starts, selects the model, runs a Plan turn and returns to the start agent", async () => {
    const { wrapper, requests } = makeWrapper({ SYNARA_ACP_SUPPORT_SET_MODE: "1" });
    const { events, threadId, planTurnId, defaultTurnId } = await runPlanThenDefaultTurn(wrapper);

    const methods = requests().map((request) => request.method);
    expect(methods).toEqual(
      expect.arrayContaining(["initialize", "session/new", "session/prompt"]),
    );
    expect(methods).not.toContain("authenticate");
    expect(
      requests()
        .filter((request) => request.params?.configId === "model")
        .map((request) => request.params?.value),
    ).toEqual(["composer-2", "default"]);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
    const modeSwitches = requests()
      .filter((request) => request.method === "session/set_mode")
      .map((request) => request.params?.modeId);
    // The mock advertises ask/architect/code and starts in "ask": Plan uses the
    // planning-like agent, the next default turn returns to the start agent.
    expect(modeSwitches).toEqual(["architect", "ask"]);

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn.proposed.completed",
        turnId: planTurnId,
        payload: { planMarkdown: "hello from mock" },
      }),
    );
    expect(
      events.filter(
        (event) => event.type === "turn.proposed.completed" && event.turnId === defaultTurnId,
      ),
    ).toEqual([]);
    for (const turnId of [planTurnId, defaultTurnId]) {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.completed",
          turnId,
          payload: expect.objectContaining({ state: "completed", stopReason: "end_turn" }),
        }),
      );
    }
    expect(events).toContainEqual(
      expect.objectContaining({ type: "session.exited", threadId, provider: "kiro" }),
    );
    expect(events.filter((event) => event.type === "runtime.warning")).toEqual([]);
  });

  it("keeps the turn running when Kiro rejects the agent switch", async () => {
    const { wrapper, requests } = makeWrapper();
    const { events, planTurnId } = await runPlanThenDefaultTurn(wrapper);

    // Only the Plan switch is attempted; the session never left its start agent.
    expect(
      requests()
        .filter((request) => request.method === "session/set_mode")
        .map((request) => request.params?.modeId),
    ).toEqual(["architect"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "runtime.warning",
        payload: expect.objectContaining({
          detail: expect.objectContaining({ reason: "mode_switch_failed", modeId: "architect" }),
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn.completed",
        turnId: planTurnId,
        payload: expect.objectContaining({ state: "completed" }),
      }),
    );
  });

  it("reopens a saved session with session/load and reselects the model in-session", async () => {
    const { wrapper, requests } = makeWrapper();
    const session = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* KiroAdapter;
        const threadId = ThreadId.makeUnsafe("kiro-resume");
        const resumed = yield* adapter.startSession({
          provider: "kiro",
          threadId,
          runtimeMode: "full-access",
          cwd: process.cwd(),
          resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
          modelSelection: { provider: "kiro", model: "composer-2" },
        });
        yield* adapter.stopSession(threadId);
        return resumed;
      }).pipe(Effect.scoped, Effect.provide(layerFor(wrapper))),
    );
    expect(session.resumeCursor).toEqual({ schemaVersion: 1, sessionId: "mock-session-1" });
    const methods = requests().map((request) => request.method);
    expect(methods).toContain("session/load");
    expect(methods).not.toContain("session/new");
    expect(requests()).toContainEqual(
      expect.objectContaining({
        method: "session/set_config_option",
        params: expect.objectContaining({ configId: "model", value: "composer-2" }),
      }),
    );
  });
});
