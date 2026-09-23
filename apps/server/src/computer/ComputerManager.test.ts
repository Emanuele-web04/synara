import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ComputerEvent,
  ComputerUiNode,
  ComputerWindow,
  ThreadComputerState,
} from "@synara/contracts";
import { decodeComputerFrame } from "@synara/shared/computerFrame";

import {
  COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
  ComputerBackendError,
  type ComputerBackendActionResult,
} from "./ComputerBackend.ts";
import { computerApprovalGate } from "./ComputerApprovalGate.ts";
import { COMPUTER_CONTROL_ENABLE_TIMEOUT_MS, ComputerManager } from "./ComputerManager.ts";
import {
  ComputerCallContext,
  ComputerCallTiming,
  withComputerCallContext,
} from "./computerCallContext.ts";
import { withComputerTask } from "./computerTaskContext.ts";
import { withDesktopDeliveryMode } from "./DesktopOperationQueue.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import type { FrameSink } from "@synara/shared/frameTransport";

class RecordingSink implements FrameSink {
  readonly received: Uint8Array[] = [];
  open = true;

  send = (bytes: Uint8Array): void => {
    this.received.push(bytes);
  };
  bufferedAmount = (): number => 0;
  isOpen = (): boolean => this.open;
}

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/**
 * A calculator buried under a full-screen browser: the live failure window
 * scoping exists for, where a bare coordinate click lands on the browser.
 */
function coveredCalculatorWindows(): readonly ComputerWindow[] {
  return [
    {
      id: "fake-browser",
      title: "Browser",
      bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
      focused: true,
      minimized: false,
      visible: true,
      stackingIndex: 0,
      occludedBy: [],
    },
    {
      id: "fake-calculator",
      title: "Calculator",
      bounds: { x: 1_050, y: 120, width: 420, height: 620 },
      focused: false,
      minimized: false,
      visible: true,
      stackingIndex: 1,
      occludedBy: ["fake-browser"],
    },
  ];
}

function semanticTextRoot(windowIds: readonly string[]): ComputerUiNode {
  return {
    role: "desktop",
    label: null,
    value: null,
    description: "Semantic text test desktop",
    frame: { x: 0, y: 0, width: 1_920, height: 1_080 },
    activationPoint: null,
    onScreen: true,
    windowId: null,
    children: windowIds.map((windowId, index) => ({
      role: "AXWindow",
      label: `Window ${index + 1}`,
      value: null,
      description: null,
      frame: { x: index * 400, y: 0, width: 360, height: 300 },
      activationPoint: null,
      onScreen: true,
      windowId,
      children: [
        {
          role: "AXTextArea",
          label: null,
          value: "",
          description: null,
          frame: { x: index * 400 + 20, y: 40, width: 320, height: 220 },
          activationPoint: { x: index * 400 + 180, y: 150 },
          onScreen: true,
          windowId,
          children: [],
        },
      ],
    })),
  };
}

function backgroundTargetBackend() {
  const ids = ["editor-a", "editor-b", "editor-a-other"];
  const windows = ids.map(
    (id, index): ComputerWindow => ({
      id,
      title: id,
      appName: index === 1 ? "Editor B" : "Editor A",
      pid: index === 1 ? 220 : 110,
      bounds: { x: index * 400, y: 0, width: 360, height: 300 },
      focused: false,
      minimized: false,
      visible: true,
    }),
  );
  return Object.assign(
    new FakeComputerBackend({
      windows,
      root: semanticTextRoot(ids),
      apps: [
        { pid: 110, name: "Editor A", bundleId: "app.editor.a", running: true, active: false },
        { pid: 220, name: "Editor B", bundleId: "app.editor.b", running: true, active: false },
      ],
    }),
    {
      exactTargetBackgroundInput: true,
      focusNeutralSemanticText: true,
      agentDialect: "macos" as const,
    },
  );
}

describe("ComputerManager window-scoped typing", () => {
  it("types through keyboard focus when the window's text field cannot be singled out", async () => {
    const backend = backgroundTargetBackend();
    // Two writable fields in one window: the unique-target rule cannot choose.
    const root = semanticTextRoot(["editor-a", "editor-a"]);
    Object.assign(backend, { currentRoot: root });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    await expect(manager.typeText("a", "hello world", "editor-a")).resolves.toMatchObject({
      action: "computer_type_text",
      windowId: "editor-a",
    });
    // One whole-string dispatch with no element target, not a refusal.
    const call = backend.callsFor("typeText").at(-1);
    expect(call?.args[0]).toBe("hello world");
    expect(call?.args[2]).toBeUndefined();

    // A window that does not exist still refuses before any key is sent.
    const typeCalls = backend.callsFor("typeText").length;
    await expect(manager.typeText("a", "x", "gone")).rejects.toMatchObject({
      code: "computer_target_not_found",
    });
    expect(backend.callsFor("typeText")).toHaveLength(typeCalls);

    await manager.dispose();
  });
});

describe("ComputerManager background task ownership", () => {
  it("lets separate apps progress while protecting one app's keyboard and modal state", async () => {
    const backend = backgroundTargetBackend();
    const manager = new ComputerManager({ backend });
    try {
      await manager.click("a", { windowId: "editor-a", x: 20, y: 50 });
      await manager.click("b", { windowId: "editor-b", x: 420, y: 50 });
      await manager.pressKey("a", "enter", "editor-a");
      await manager.pressKey("b", "enter", "editor-b");
      expect(backend.callsFor("pressKey")).toHaveLength(2);
      expect(backend.callsFor("raiseWindow")).toHaveLength(0);
      await expect(manager.pressKey("b", "enter", "editor-a-other")).rejects.toHaveProperty(
        "code",
        "computer_controlled_by_other_thread",
      );
      expect((await manager.getThreadState("b")).controlledByOtherThread).toBe(false);
      expect((await manager.getThreadState("b")).sharedPreviewUnavailable).toBe(true);
      await manager.releaseDesktopControl("a");
      expect((await manager.getThreadState("b")).sharedPreviewUnavailable).toBeUndefined();
      await manager.pressKey("b", "enter", "editor-a-other");
    } finally {
      await manager.dispose();
    }
  });

  it("allows independent semantic windows but blocks conflicting app-wide input", async () => {
    const backend = backgroundTargetBackend();
    const manager = new ComputerManager({ backend });
    try {
      await manager.typeText("a", "alpha", "editor-a");
      await manager.setValue("b", { windowId: "editor-a-other", role: "AXTextArea" }, "bravo");
      expect(backend.callsFor("focusWindow")).toHaveLength(0);
      await expect(
        manager.setValue("b", { windowId: "editor-a", role: "AXTextArea" }, "wrong"),
      ).rejects.toHaveProperty("code", "computer_controlled_by_other_thread");
      await expect(manager.pressKey("b", "enter", "editor-a-other")).rejects.toHaveProperty(
        "code",
        "computer_controlled_by_other_thread",
      );
      await manager.releaseDesktopControl("a");
      await manager.pressKey("b", "enter", "editor-a-other");
    } finally {
      await manager.dispose();
    }
  });

  it("keeps foreground, clipboard and drags globally exclusive", async () => {
    const backend = backgroundTargetBackend();
    const manager = new ComputerManager({ backend });
    try {
      await manager.pressKey("a", "enter", "editor-a");
      await expect(manager.writeClipboard("b", "clipboard")).rejects.toHaveProperty(
        "code",
        "computer_controlled_by_other_thread",
      );
      await expect(
        manager.drag(
          "b",
          { windowId: "editor-b", x: 420, y: 50 },
          { windowId: "editor-b", x: 440, y: 60 },
        ),
      ).rejects.toHaveProperty("code", "computer_controlled_by_other_thread");
      await expect(
        manager.activateWindow("b", "editor-b", VISIBLE_USE_AUTHORIZED),
      ).rejects.toHaveProperty("code", "computer_controlled_by_other_thread");
      expect(backend.callsFor("drag")).toHaveLength(0);
      expect(backend.callsFor("writeClipboard")).toHaveLength(0);
      expect(backend.callsFor("raiseWindow")).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("protects a running app from another task's launch alias and permits other apps", async () => {
    const backend = backgroundTargetBackend();
    const manager = new ComputerManager({ backend });
    try {
      await manager.pressKey("a", "enter", "editor-a");
      await expect(manager.launchApp("b", "app.editor.a")).rejects.toHaveProperty(
        "code",
        "computer_controlled_by_other_thread",
      );
      await manager.launchApp("b", "Editor B");
      expect(backend.callsFor("launchApp")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("does not release a newer background turn after a late old completion", async () => {
    const backend = backgroundTargetBackend();
    const manager = new ComputerManager({ backend });
    try {
      await manager.withAgentActivity(
        "a",
        () => manager.pressKey("a", "enter", "editor-a"),
        undefined,
        "old",
      );
      await manager.releaseDesktopControl("a", "old");
      await manager.withAgentActivity(
        "a",
        () => manager.pressKey("a", "enter", "editor-a"),
        undefined,
        "new",
      );
      await manager.releaseDesktopControl("a", "old");
      await expect(manager.pressKey("b", "enter", "editor-a")).rejects.toHaveProperty(
        "code",
        "computer_controlled_by_other_thread",
      );
      await manager.releaseDesktopControl("a", "new");
      await manager.pressKey("b", "enter", "editor-a");
    } finally {
      await manager.dispose();
    }
  });

  it("does not inherit an evicted background turn on a later anonymous claim", async () => {
    let now = 0;
    const backend = backgroundTargetBackend();
    const manager = new ComputerManager({ backend, now: () => now, leaseIdleMs: 100 });
    try {
      await manager.withAgentActivity(
        "a",
        () => manager.pressKey("a", "enter", "editor-a"),
        undefined,
        "old-a",
      );
      now = 200;
      await manager.withAgentActivity(
        "b",
        () => manager.pressKey("b", "enter", "editor-a"),
        undefined,
        "turn-b",
      );
      await manager.releaseDesktopControl("b", "turn-b");
      await manager.withAgentActivity("a", () => manager.pressKey("a", "enter", "editor-a"));
      // An anonymous lease is released by any named completion; inheriting
      // old-a would incorrectly retain it against this terminal identity.
      await manager.releaseDesktopControl("a", "current-a");
      await manager.pressKey("b", "enter", "editor-a");
    } finally {
      await manager.dispose();
    }
  });

  it("releases a completed background turn only after its admitted input drains", async () => {
    const backend = backgroundTargetBackend();
    const started = deferred();
    const finish = deferred();
    const press = vi.spyOn(backend, "pressKey").mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return {};
    });
    const manager = new ComputerManager({ backend });
    const active = manager.withAgentActivity(
      "a",
      () => manager.pressKey("a", "enter", "editor-a"),
      undefined,
      "turn-a",
    );
    try {
      await started.promise;
      await manager.releaseDesktopControl("a", "turn-a");
      const next = manager.withAgentActivity(
        "b",
        () => manager.pressKey("b", "enter", "editor-a"),
        undefined,
        "turn-b",
      );
      expect(press).toHaveBeenCalledTimes(1);
      finish.resolve();
      await Promise.all([active, next]);
      expect(press).toHaveBeenCalledTimes(2);
    } finally {
      finish.resolve();
      await active;
      await manager.dispose();
    }
  });

  it("revokes a queued task without stopping the other app's active input", async () => {
    const backend = backgroundTargetBackend();
    const started = deferred();
    const finish = deferred();
    const stop = vi.fn(async () => {});
    Object.assign(backend, { stopInput: stop });
    const press = vi.spyOn(backend, "pressKey").mockImplementationOnce(async () => {
      started.resolve();
      await finish.promise;
      return {};
    });
    const manager = new ComputerManager({ backend });
    const active = manager.withAgentActivity(
      "b",
      () => manager.pressKey("b", "enter", "editor-b"),
      undefined,
      "turn-b",
    );
    try {
      await started.promise;
      const queued = manager.withAgentActivity(
        "a",
        () => manager.pressKey("a", "enter", "editor-a"),
        undefined,
        "turn-a",
      );
      const refused = expect(queued).rejects.toHaveProperty("controlRevoked", true);
      await manager.setControlEnabled("a", false);
      expect(stop).not.toHaveBeenCalled();
      finish.resolve();
      await Promise.all([active, refused]);
      expect(press).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      await active;
      await manager.dispose();
    }
  });

  it("forwards exact key targets without focus changes and rejects window mismatches", async () => {
    const backend = backgroundTargetBackend();
    const press = vi.spyOn(backend, "pressKey");
    const manager = new ComputerManager({ backend });
    try {
      await manager.pressKey("a", "enter", "editor-a", {
        windowId: "editor-a",
        role: "AXTextArea",
      });
      expect(press).toHaveBeenCalledWith(
        "enter",
        "editor-a",
        expect.objectContaining({ node: expect.objectContaining({ windowId: "editor-a" }) }),
      );
      expect(backend.callsFor("focusWindow")).toHaveLength(0);
      await expect(
        manager.pressKey("a", "enter", "editor-a", { windowId: "editor-b", role: "AXTextArea" }),
      ).rejects.toHaveProperty("code", "computer_target_invalid");
      expect(press).toHaveBeenCalledTimes(1);
    } finally {
      await manager.dispose();
    }
  });

  it("pauses after observed launch activation without losing the launch outcome or replaying", async () => {
    const backend = backgroundTargetBackend();
    const launch = vi.spyOn(backend, "launchApp").mockResolvedValue({
      computerId: backend.computerId,
      app: "Editor A",
      pid: 110,
      window: (await backend.listWindows())[0]!,
      focusChangedDuringLaunch: true,
    });
    Object.assign(backend, { checkInputReady: async () => {} });
    const manager = new ComputerManager({ backend });
    try {
      const result = await manager.launchApp("a", "Editor A");
      expect(result.focusChangedDuringLaunch).toBe(true);
      await expect(manager.pressKey("a", "enter", "editor-a")).rejects.toHaveProperty("inputPause");
      expect(launch).toHaveBeenCalledTimes(1);
      await withComputerTask({ threadId: "a" }, () => manager.getState({ windowId: "editor-a" }));
      await manager.pressKey("a", "enter", "editor-a");
    } finally {
      await manager.dispose();
    }
  });

  it("retains a bounded list of previously observed app names without probing", async () => {
    const backend = backgroundTargetBackend();
    const manager = new ComputerManager({ backend });
    try {
      await manager.listWindows();
      backend.emitWindowsChanged([]);
      const reads = backend.callsFor("listWindows").length;
      expect(manager.observedAppNames()).toEqual(["Editor B", "Editor A"]);
      expect(backend.callsFor("listWindows")).toHaveLength(reads);
    } finally {
      await manager.dispose();
    }
  });
});

describe("ComputerManager and FakeComputerBackend", () => {
  it("publishes thread snapshots, activity transitions, and backend window events", async () => {
    const backend = new FakeComputerBackend({
      now: () => "2026-08-15T00:00:00.000Z",
    });
    const manager = new ComputerManager({ backend });
    const events: Array<{ type: string; state?: { agentActive: boolean } }> = [];
    manager.onEvent((event) => {
      events.push({
        type: event.type,
        ...("state" in event ? { state: { agentActive: event.state.agentActive } } : {}),
      });
    });

    const initial = await manager.getThreadState("thread-1");
    expect(initial.threadId).toBe("thread-1");
    expect(initial.version).toBeGreaterThanOrEqual(0);
    // Seeding a panel is not a use of the desktop, so it costs the desktop
    // nothing: the passive probe answers whether the feature works, and the
    // window list stays empty until something really asks for the backend.
    expect(initial.windows).toEqual([]);
    expect(backend.calls.map((call) => call.method)).toEqual(["probeAvailability"]);
    expect(initial.availability).toEqual({
      kind: "available",
      backend: "fake",
    });

    const result = await manager.withAgentActivity("thread-1", async () => {
      const active = events.findLast((event) => event.type === "computer.thread-state");
      expect(active?.state?.agentActive).toBe(true);
      return await manager.click("thread-1", {
        label: "Calculate",
        role: "button",
      });
    });
    expect(result.point).toEqual({ x: 1_180, y: 228 });
    expect(
      events.filter((event) => event.type === "computer.thread-state").length,
    ).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)?.state?.agentActive).toBe(false);

    const newWindow = {
      id: "fake-notes",
      title: "Notes",
      appName: "org.kde.kwrite",
      bounds: { x: 200, y: 200, width: 500, height: 400 },
      focused: true,
      minimized: false,
      visible: true,
    };
    backend.emitWindowsChanged([newWindow]);
    await Promise.resolve();
    await Promise.resolve();
    const refreshed = await manager.getThreadState("thread-1");
    expect(refreshed.windows).toEqual([newWindow]);
    expect(events.some((event) => event.type === "computer.windows-changed")).toBe(true);

    await manager.dispose();
  });

  it("republishes every thread when backend health changes, without touching the backend", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const states: ThreadComputerState[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") states.push(event.state);
    });
    // Health only corrects the availability of a backend something has actually
    // asked for; before that there is nothing to be disconnected from.
    await manager.listWindows();
    const seeded = await Promise.all([
      manager.getThreadState("thread-a"),
      manager.getThreadState("thread-b"),
    ]);
    expect(seeded.map((state) => state.health.status)).toEqual(["connected", "connected"]);
    const callsBeforeHealth = backend.calls.length;

    backend.emitHealthChanged({
      status: "reconnecting",
      consecutiveFailures: 1,
      reconnects: 0,
      lastFailure: {
        message: "The backend vanished",
        at: "2026-08-16T10:00:00.000Z",
      },
      captureAvailable: false,
    });

    // A supervision event is answered from cache: asking the backend anything
    // here would put a round trip — and a connect attempt — on every failure.
    expect(backend.calls).toHaveLength(callsBeforeHealth);
    const degraded = ["thread-a", "thread-b"].map((threadId) =>
      states.findLast((state) => state.threadId === threadId),
    );
    expect(degraded.map((state) => state?.health.status)).toEqual(["reconnecting", "reconnecting"]);
    expect(degraded.map((state) => state?.availability.kind)).toEqual([
      "backend-unavailable",
      "backend-unavailable",
    ]);
    expect(degraded[0]?.availability).toMatchObject({
      message: expect.stringContaining("The backend vanished"),
    });
    // Panels drop stale snapshots by version, so a live change must move it.
    expect(degraded[0]?.version).toBeGreaterThan(seeded[0]!.version);

    backend.emitHealthChanged({
      status: "connected",
      consecutiveFailures: 0,
      reconnects: 1,
      lastFailure: {
        message: "The backend vanished",
        at: "2026-08-16T10:00:00.000Z",
      },
      captureAvailable: true,
    });

    const recovered = await manager.getThreadState("thread-a");
    expect(recovered.availability).toEqual({
      kind: "available",
      backend: "fake",
    });
    expect(recovered.health).toMatchObject({
      status: "connected",
      reconnects: 1,
    });

    await manager.dispose();
  });

  it("answers getStatus without a thread, corrected by live health", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    const status = await manager.getStatus();
    expect(status.computerId).toBe("desktop");
    expect(status.availability).toEqual({ kind: "available", backend: "fake" });
    expect(status.health.status).toBe("connected");
    expect(status.capabilities.input).toBe(true);
    // No thread state was created as a side effect of asking, and merely
    // opening settings must not be the thing that establishes (and on a cold
    // backend: pre-engagement it is the probe.
    expect(backend.calls.map((call) => call.method)).not.toContain("getState");
    expect(backend.calls.map((call) => call.method)).toContain("probeAvailability");
    expect(backend.calls.map((call) => call.method)).not.toContain("availability");

    // Health corrections only apply once something real engaged the backend —
    // supervision cannot report on connections that were never made.
    await manager.listWindows();

    backend.emitHealthChanged({
      status: "reconnecting",
      consecutiveFailures: 2,
      reconnects: 1,
      lastFailure: {
        message: "The backend vanished",
        at: "2026-08-16T10:00:00.000Z",
      },
      captureAvailable: false,
    });
    const degraded = await manager.getStatus();
    expect(degraded.health.status).toBe("reconnecting");
    expect(degraded.availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("The backend vanished"),
    });

    await manager.dispose();
  });

  it("reports a failed availability probe as backend-unavailable instead of throwing", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    // Both reads degrade the same way: the pre-engagement probe and the
    // establishing read a live backend answers with.
    backend.failNext("probeAvailability", new Error("probe exploded"));
    const status = await manager.getStatus();
    expect(status.availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("probe exploded"),
    });

    await manager.listWindows();
    backend.failNext("availability", new Error("live read exploded"));
    const engaged = await manager.getStatus();
    expect(engaged.availability).toMatchObject({
      kind: "backend-unavailable",
      message: expect.stringContaining("live read exploded"),
    });

    await manager.dispose();
  });

  /**
   * `lastError` and availability messages are schema-bounded at 2048
   * characters, and both are composed from backend error text nothing here
   * controls. One oversized D-Bus diagnostic used to fail the encode of the
   * whole getThreadState payload — breaking thread-state pushes for that
   * thread until the message changed.
   */
  it("clamps an oversized backend error before it reaches a state payload", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    const oversized = "E".repeat(100_000);
    backend.failNext("probeAvailability", new Error(oversized));
    const state = await manager.getThreadState("thread-oversize");

    expect(state.lastError).toBeDefined();
    expect(state.lastError!.length).toBeLessThanOrEqual(2_048);
    // The availability verdict on the same payload is clamped the same way,
    // so encoding the state succeeds end to end.
    expect(state.availability.kind).toBe("backend-unavailable");
    if (state.availability.kind === "backend-unavailable") {
      expect(state.availability.message.length).toBeLessThanOrEqual(2_048);
    }

    await manager.dispose();
  });

  it("dispatches a supported semantic click once and never retries an uncertain AX effect", async () => {
    const backend = Object.assign(new FakeComputerBackend(), {
      agentDialect: "macos" as const,
      supportsAction: (_target: unknown, action: string) => action === "AXPress",
    });
    const press = vi.spyOn(backend, "performAction").mockResolvedValue({
      effect: "dispatched-unknown",
      verified: "unverifiable",
    });
    const manager = new ComputerManager({ backend });
    await manager.click("thread-1", { label: "Calculate", role: "button" });
    expect(press).toHaveBeenCalledTimes(1);
    expect(press.mock.calls[0]?.[1]).toBe("AXPress");
    expect(backend.callsFor("click")).toHaveLength(0);
    press.mockRejectedValueOnce(new Error("Unknown dispatch"));
    await expect(manager.click("thread-1", { label: "Calculate", role: "button" })).rejects.toThrow(
      "Unknown dispatch",
    );
    expect(press).toHaveBeenCalledTimes(2);
    expect(backend.callsFor("click")).toHaveLength(0);
    await manager.doubleClick("thread-1", {
      label: "Calculate",
      role: "button",
    });
    await manager.click("thread-1", { label: "Calculate", role: "button" }, ["shift"]);
    expect(press).toHaveBeenCalledTimes(2);
    expect(backend.callsFor("doubleClick")).toHaveLength(1);
    expect(backend.callsFor("click")).toHaveLength(1);
    await manager.dispose();
  });

  it("re-walks a fresh tree when a cached-tree target lookup misses", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const realGetState = backend.getState.bind(backend);
    let calls = 0;
    vi.spyOn(backend, "getState").mockImplementation(async (options) => {
      calls += 1;
      const state = await realGetState(options);
      // First read serves a stale tree whose target has not appeared yet —
      // what a recent-tree cache hit looks like after a UI change.
      if (calls === 1 && state.root) {
        return {
          ...state,
          root: {
            ...state.root,
            children: state.root.children.map((child) => ({
              ...child,
              children: [],
            })),
          },
        };
      }
      return state;
    });

    const result = await manager.click("thread-1", {
      label: "Calculate",
      role: "button",
    });
    expect(result.point).toEqual({ x: 1_180, y: 228 });
    expect(calls).toBe(2);
    expect(backend.callsFor("getState")[0]?.args[0]).toMatchObject({
      reuseRecentTree: true,
    });
    expect(backend.callsFor("getState")[1]?.args[0]).not.toMatchObject({
      reuseRecentTree: true,
    });
    await manager.dispose();
  });

  it("falls back to a coordinate click when no AXPress token is advertised", async () => {
    const backend = Object.assign(new FakeComputerBackend(), {
      agentDialect: "macos" as const,
      supportsAction: () => false,
    });
    const press = vi.spyOn(backend, "performAction");
    const manager = new ComputerManager({ backend });
    await manager.click("thread-1", { label: "Calculate", role: "button" });
    expect(press).not.toHaveBeenCalled();
    expect(backend.callsFor("click")).toHaveLength(1);
    await manager.dispose();
  });

  it("performs semantic writes only against a fresh, unambiguous snapshot", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    await expect(manager.setValue("thread-1", { label: "Display" }, "468")).resolves.toMatchObject({
      action: "computer_set_value",
      value: "468",
    });
    await expect(
      manager.performAction("thread-1", { label: "Calculate", role: "button" }, "activate"),
    ).resolves.toMatchObject({
      action: "computer_perform_action",
      point: { x: 1_180, y: 228 },
    });
    // The fake's read-back is the substring the range covers: "468"[0..2].
    await expect(
      manager.selectText("thread-1", { label: "Display" }, { start: 0, length: 2 }),
    ).resolves.toMatchObject({
      action: "computer_select_text",
      value: "46",
    });

    await expect(manager.click("thread-1", { x: 1_920, y: 1_080 })).rejects.toMatchObject({
      code: "computer_target_offscreen",
    });
    await expect(manager.click("thread-1", { x: 10 })).rejects.toMatchObject({
      code: "computer_target_invalid",
    });

    // A bare window id is a real scroll target — the window itself, at its
    // own point — while for the semantic writes below a target that names no
    // control refuses up front with what is missing, instead of matching
    // every node in scope and dumping the whole tree as an ambiguity refusal.
    await expect(
      manager.scroll("thread-1", { windowId: "fake-calculator" }, 0, 300),
    ).resolves.toMatchObject({
      action: "computer_scroll",
      point: { x: 1_260, y: 430 },
    });
    await expect(manager.setValue("thread-1", {}, "468")).rejects.toMatchObject({
      code: "computer_target_invalid",
    });
    await expect(manager.performAction("thread-1", {}, "activate")).rejects.toMatchObject({
      code: "computer_target_invalid",
    });
    await expect(manager.selectText("thread-1", {}, { start: 0, length: 1 })).rejects.toMatchObject(
      {
        code: "computer_target_invalid",
      },
    );

    await manager.dispose();
  });

  it("reveals a hover target without changing keyboard aim", async () => {
    const backend = new FakeComputerBackend({
      windows: coveredCalculatorWindows(),
    });
    const manager = new ComputerManager({ backend });
    // An untargeted move takes the lease first, so the hover below runs with
    // control already held and must not clear the pinned focus again.
    await manager.moveCursor("thread-1", { x: 100, y: 100 });
    const cleared = backend.callsFor("clearFocusWindow").length;
    await manager.moveCursor("thread-1", {
      x: 1_100,
      y: 200,
      windowId: "fake-calculator",
    });
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("focusWindow")).toHaveLength(0);
    expect(backend.callsFor("clearFocusWindow")).toHaveLength(cleared);
    expect(backend.callsFor("moveCursor").at(-1)?.args[0]).toEqual({
      x: 1_100,
      y: 200,
    });
    await manager.dispose();
  });

  it("raises a target window before focusing it and scopes a coordinate click to it", async () => {
    const backend = new FakeComputerBackend({
      windows: coveredCalculatorWindows(),
    });
    const manager = new ComputerManager({ backend });

    await manager.click("thread-1", { label: "Calculate", role: "button" });
    expect(
      backend.calls
        .map((call) => call.method)
        .filter((method) => ["raiseWindow", "focusWindow", "click"].includes(method)),
    ).toEqual(["raiseWindow", "focusWindow", "click"]);
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);

    const perceptionCalls = backend.callsFor("getState").length;
    const scoped = await manager.click("thread-1", {
      x: 1_100,
      y: 200,
      windowId: "fake-calculator",
    });
    expect(scoped.point).toEqual({ x: 1_100, y: 200 });
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("click").at(-1)?.args[0]).toEqual({
      x: 1_100,
      y: 200,
    });
    // The coordinate is authoritative, so no accessibility tree is read for it.
    expect(backend.callsFor("getState")).toHaveLength(perceptionCalls);

    // A coordinate that misses the window is refused rather than clicked
    // wherever it happens to land.
    await expect(
      manager.click("thread-1", { x: 40, y: 40, windowId: "fake-calculator" }),
    ).rejects.toMatchObject({ code: "computer_target_offscreen" });
    await expect(
      manager.click("thread-1", { x: 40, y: 40, windowId: "gone" }),
    ).rejects.toMatchObject({
      code: "computer_target_not_found",
      notFound: true,
    });

    await manager.dispose();
  });

  it("scopes a drag to the window its origin names", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    // Both endpoints inside fake-calculator (1050,120,420,620). The drag grabs
    // the named window: its origin's frame is the authority for scoping.
    await manager.drag(
      "thread-1",
      { x: 1_100, y: 200, windowId: "fake-calculator" },
      { x: 1_200, y: 400, windowId: "fake-calculator" },
      400,
    );
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    // The Fake records the gesture itself; the focusWindow call above is what
    // proves the window the drag was scoped to.
    expect(backend.callsFor("drag").at(-1)?.args).toEqual([
      { x: 1_100, y: 200 },
      { x: 1_200, y: 400 },
      400,
    ]);

    await manager.dispose();
  });

  it("keeps window targeting working on a backend that cannot raise windows", async () => {
    const backend = new FakeComputerBackend();
    (backend as unknown as { raiseWindow?: undefined }).raiseWindow = undefined;
    const manager = new ComputerManager({ backend });

    await expect(
      manager.click("thread-1", { label: "Calculate", role: "button" }),
    ).resolves.toMatchObject({ point: { x: 1_180, y: 228 } });
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);

    await manager.dispose();
  });

  it("refuses a covered target the desktop cannot raise, and clicks it once it can", async () => {
    const backend = new FakeComputerBackend({
      windows: coveredCalculatorWindows(),
    });
    (backend as unknown as { raiseWindow?: undefined }).raiseWindow = undefined;
    const manager = new ComputerManager({ backend });

    const covered = manager.click("thread-1", {
      x: 1_100,
      y: 200,
      windowId: "fake-calculator",
    });
    await expect(covered).rejects.toMatchObject({
      code: "computer_target_occluded",
    });
    // The refusal has to name what is in the way, or the model has nothing to
    // act on but a retry.
    await expect(covered).rejects.toThrow(/Browser/);
    // Nothing was injected: the point of refusing is that no click lands in the
    // covering window.
    expect(backend.callsFor("click")).toHaveLength(0);
    expect(backend.callsFor("focusWindow")).toHaveLength(0);

    // A label target resolves to the same buried window and is refused too.
    await expect(
      manager.click("thread-1", { label: "Calculate", role: "button" }),
    ).rejects.toMatchObject({ code: "computer_target_occluded" });

    // A point the covering window does not contain is safe to click without a
    // raise, so it goes through.
    await expect(
      manager.click("thread-1", { x: 1_100, y: 200, windowId: "fake-browser" }),
    ).resolves.toMatchObject({
      point: { x: 1_100, y: 200 },
      windowId: "fake-browser",
    });

    await manager.dispose();
  });

  it("refuses a covered target when the raise itself fails", async () => {
    const backend = new FakeComputerBackend({
      windows: coveredCalculatorWindows(),
    });
    const manager = new ComputerManager({ backend });
    backend.failNext("raiseWindow", new Error("plugin has no raiseWindow"));

    await expect(
      manager.click("thread-1", {
        x: 1_100,
        y: 200,
        windowId: "fake-calculator",
      }),
    ).rejects.toThrow(/plugin has no raiseWindow/);
    expect(backend.callsFor("click")).toHaveLength(0);

    // The next call raises normally and is not held against the target.
    await expect(
      manager.click("thread-1", {
        x: 1_100,
        y: 200,
        windowId: "fake-calculator",
      }),
    ).resolves.toMatchObject({
      point: { x: 1_100, y: 200 },
      windowId: "fake-calculator",
    });

    await manager.dispose();
  });

  it("routes keyboard input to a named window and leaves focus alone without one", async () => {
    const backend = new FakeComputerBackend({
      windows: coveredCalculatorWindows(),
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    await expect(manager.typeText("thread-1", "12", "fake-calculator")).resolves.toMatchObject({
      action: "computer_type_text",
      windowId: "fake-calculator",
    });
    expect(backend.callsFor("raiseWindow").at(-1)?.args).toEqual(["fake-calculator"]);
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-calculator"]);

    await expect(manager.pressKey("thread-1", "enter", "fake-browser")).resolves.toMatchObject({
      windowId: "fake-browser",
    });
    expect(backend.callsFor("focusWindow").at(-1)?.args).toEqual(["fake-browser"]);
    await expect(manager.hotkey("thread-1", ["ctrl", "t"], "fake-browser")).resolves.toMatchObject({
      windowId: "fake-browser",
    });

    // Without a window the keystroke follows whatever focus the last action
    // left, which is what click-then-type depends on: focus is never cleared.
    const focusCalls = backend.callsFor("focusWindow").length;
    await expect(manager.typeText("thread-1", "9")).resolves.not.toHaveProperty("windowId");
    expect(backend.callsFor("focusWindow")).toHaveLength(focusCalls);
    expect(backend.callsFor("clearFocusWindow")).toHaveLength(1);

    // A stale id fails before any key is sent rather than typing into whatever
    // holds focus instead.
    const typeCalls = backend.callsFor("typeText").length;
    await expect(manager.typeText("thread-1", "9", "gone")).rejects.toMatchObject({
      code: "computer_target_not_found",
      notFound: true,
    });
    expect(backend.callsFor("typeText")).toHaveLength(typeCalls);

    await manager.dispose();
  });

  it("explains a scoped injection the desktop refused, and passes other failures through", async () => {
    const backend = new FakeComputerBackend({
      windows: coveredCalculatorWindows(),
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    // A refusal means nothing was delivered, so the caller has to be told that
    // and told what to change; the compositor only names the call it declined.
    backend.failNext(
      "click",
      new ComputerBackendError("The computer backend rejected pressButton.", {
        retryable: true,
        rejectedOperation: "pressButton",
      }),
    );
    const refused = manager.click("thread-1", {
      x: 1_100,
      y: 200,
      windowId: "fake-calculator",
    });
    await expect(refused).rejects.toMatchObject({
      code: "computer_target_refused",
    });
    await expect(refused).rejects.toThrow(/no input was sent/);
    await expect(refused).rejects.toThrow(/label instead of a coordinate/);

    // An unscoped action has no window to blame, so its error is left alone.
    backend.failNext(
      "click",
      new ComputerBackendError("The computer backend rejected pressButton.", {
        rejectedOperation: "pressButton",
      }),
    );
    await expect(manager.click("thread-1", { x: 1_100, y: 200 })).rejects.toThrow(
      /computer backend rejected pressButton/,
    );

    // A fault is not a refusal: rewriting it would claim an injection never
    // happened when it may well have.
    backend.failNext("click", new ComputerBackendError("session bus disconnected"));
    await expect(
      manager.click("thread-1", {
        x: 1_100,
        y: 200,
        windowId: "fake-calculator",
      }),
    ).rejects.toThrow(/session bus disconnected/);

    await manager.dispose();
  });

  describe("the post-action settle", () => {
    const ENV = ["SYNARA_CUA_CONDITIONAL_SETTLE", "SYNARA_CUA_ACTION_SETTLE_MS"] as const;
    const savedEnv = new Map<string, string | undefined>();

    afterEach(() => {
      for (const name of ENV) {
        if (savedEnv.has(name)) {
          const value = savedEnv.get(name);
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      savedEnv.clear();
      vi.restoreAllMocks();
    });

    const setEnv = (name: (typeof ENV)[number], value: string | undefined) => {
      if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };

    /**
     * The settle is a bare `setTimeout(resolve, actionSettleMs)`: whether it
     * ran is visible as a timer scheduled with exactly that delay, which is a
     * deterministic check no elapsed-time assertion can match.
     */
    const settleWaitedFor = (
      spy: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } },
      ms: number,
    ) => spy.mock.calls.some((call) => call[1] === ms);

    /** A backend whose key presses report whatever verdict the test sets. */
    class ProvenBackend extends FakeComputerBackend {
      proof: ComputerBackendActionResult = {};
      override async pressKey(key: string): Promise<ComputerBackendActionResult> {
        const result = await super.pressKey(key);
        return { ...result, ...this.proof };
      }
    }

    const pressThenObserve = (manager: ComputerManager, spy = vi.spyOn(globalThis, "setTimeout")) =>
      manager
        .withAgentActivity("thread-1", async () => {
          await manager.pressKey("thread-1", "enter");
          return manager.captureActionScreenshot();
        })
        .then((observation) => ({ observation, spy }));

    it("SYNARA_CUA_CONDITIONAL_SETTLE=0 restores the fixed wait even on a verified effect", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "0");
      const backend = new ProvenBackend();
      backend.proof = { effect: "verified", verified: "confirmed" };
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const { spy } = await pressThenObserve(manager);
      expect(settleWaitedFor(spy, 60)).toBe(true);
      await manager.dispose();
    });

    it("skips the wait on a verified effect by default — no flag needed", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", undefined);
      const backend = new ProvenBackend();
      backend.proof = { effect: "verified", verified: "confirmed" };
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const { spy } = await pressThenObserve(manager);
      expect(settleWaitedFor(spy, 60)).toBe(false);
      await manager.dispose();
    });

    it("still waits the compiled 300 ms when nothing overrides it", async () => {
      setEnv("SYNARA_CUA_ACTION_SETTLE_MS", undefined);
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", undefined);
      const manager = new ComputerManager({ backend: new FakeComputerBackend() });
      const { spy } = await pressThenObserve(manager);
      expect(settleWaitedFor(spy, 300)).toBe(true);
      await manager.dispose();
    });

    it("SYNARA_CUA_ACTION_SETTLE_MS overrides the wait, and an explicit 0 removes it", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", undefined);
      setEnv("SYNARA_CUA_ACTION_SETTLE_MS", "45");
      const manager = new ComputerManager({ backend: new FakeComputerBackend() });
      const { spy } = await pressThenObserve(manager);
      expect(settleWaitedFor(spy, 45)).toBe(true);
      await manager.dispose();

      setEnv("SYNARA_CUA_ACTION_SETTLE_MS", "0");
      const zeroed = new ComputerManager({ backend: new FakeComputerBackend() });
      const zero = await pressThenObserve(zeroed);
      // 0 means no settle leg at all — no timer is even scheduled.
      expect(zero.spy.mock.calls.some((call) => call[1] === 0)).toBe(false);
      await zeroed.dispose();
    });

    it("a constructor override wins over SYNARA_CUA_ACTION_SETTLE_MS", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", undefined);
      setEnv("SYNARA_CUA_ACTION_SETTLE_MS", "45");
      const manager = new ComputerManager({
        backend: new FakeComputerBackend(),
        actionSettleMs: 60,
      });
      const { spy } = await pressThenObserve(manager);
      expect(settleWaitedFor(spy, 60)).toBe(true);
      expect(settleWaitedFor(spy, 45)).toBe(false);
      await manager.dispose();
    });

    it("SYNARA_CUA_CONDITIONAL_SETTLE skips the wait on a verified effect", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const backend = new ProvenBackend();
      backend.proof = { effect: "verified" };
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const { spy } = await pressThenObserve(manager);
      expect(settleWaitedFor(spy, 60)).toBe(false);
      await manager.dispose();
    });

    it("SYNARA_CUA_CONDITIONAL_SETTLE skips the wait on a confirmed read-back", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const backend = new ProvenBackend();
      backend.proof = { verified: "confirmed" };
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const { spy } = await pressThenObserve(manager);
      expect(settleWaitedFor(spy, 60)).toBe(false);
      await manager.dispose();
    });

    it.each([
      ["an unconfirmed read-back", { verified: "unconfirmed" }],
      ["an unverifiable surface", { verified: "unverifiable" }],
      ["an unknown dispatch", { effect: "dispatched-unknown" }],
      ["no verdict at all", {}],
    ] as const)("SYNARA_CUA_CONDITIONAL_SETTLE keeps the wait after %s", async (_label, proof) => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const backend = new ProvenBackend();
      backend.proof = proof;
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const { spy } = await pressThenObserve(manager);
      expect(settleWaitedFor(spy, 60)).toBe(true);
      await manager.dispose();
    });

    it("consumes the proof once: a second observation in the same call settles again", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const backend = new ProvenBackend();
      backend.proof = { effect: "verified" };
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const spy = vi.spyOn(globalThis, "setTimeout");
      await manager.withAgentActivity("thread-1", async () => {
        await manager.pressKey("thread-1", "enter");
        await manager.captureActionScreenshot();
        expect(settleWaitedFor(spy, 60)).toBe(false);
        await manager.captureActionScreenshot();
        expect(settleWaitedFor(spy, 60)).toBe(true);
      });
      await manager.dispose();
    });

    it("a second action's verdict replaces the first inside one call", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const backend = new ProvenBackend();
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const spy = vi.spyOn(globalThis, "setTimeout");
      await manager.withAgentActivity("thread-1", async () => {
        backend.proof = { effect: "verified" };
        await manager.pressKey("thread-1", "enter");
        // The second action could not prove itself; its verdict is the one
        // the following observation must honor.
        backend.proof = { effect: "dispatched-unknown" };
        await manager.pressKey("thread-1", "enter");
        await manager.captureActionScreenshot();
        expect(settleWaitedFor(spy, 60)).toBe(true);
      });
      await manager.dispose();
    });

    it("a verdict never waives a later call's settle", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const backend = new ProvenBackend();
      backend.proof = { effect: "verified" };
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const spy = vi.spyOn(globalThis, "setTimeout");
      await manager.withAgentActivity("thread-1", async () => {
        await manager.pressKey("thread-1", "enter");
        // The observation was never taken inside this call, so the proof is
        // still sitting on the context when the call ends — and must die
        // with it.
      });
      await manager.withAgentActivity("thread-1", async () => {
        await manager.captureActionScreenshot();
        expect(settleWaitedFor(spy, 60)).toBe(true);
      });
      await manager.dispose();
    });

    /**
     * The same press-and-observe pair, but with the window the action named —
     * the only case the driver observer can scope to.
     */
    const pressThenObserveWindow = (
      manager: ComputerManager,
      spy = vi.spyOn(globalThis, "setTimeout"),
    ) =>
      manager
        .withAgentActivity("thread-1", async () => {
          await manager.pressKey("thread-1", "enter");
          return manager.captureActionScreenshot("fake-terminal");
        })
        .then((observation) => ({ observation, spy }));

    it("prefers the driver's observed settle when the backend offers it and a window is known", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", undefined);
      const backend = new ProvenBackend({ waitForSettle: true });
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const { spy } = await pressThenObserveWindow(manager);
      const settleCalls = backend.callsFor("waitForSettle");
      expect(settleCalls).toHaveLength(1);
      expect(settleCalls[0]?.args[0]).toMatchObject({
        windowId: "fake-terminal",
        timeoutMs: 5_000,
        quietMs: 60,
      });
      // The observer answered the settle itself; no blind timer ran beside it.
      expect(settleWaitedFor(spy, 60)).toBe(false);
      await manager.dispose();
    });

    it("a busy verdict from the observer still ends the wait — the timeout already covered the bound", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", undefined);
      const backend = new ProvenBackend({
        waitForSettle: () => ({ settled: false, waitedMs: 5_000, eventsSeen: 14 }),
      });
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const { spy } = await pressThenObserveWindow(manager);
      expect(backend.callsFor("waitForSettle")).toHaveLength(1);
      expect(settleWaitedFor(spy, 60)).toBe(false);
      await manager.dispose();
    });

    it("falls back to the fixed wait without a window hint, even when the observer exists", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", undefined);
      const backend = new ProvenBackend({ waitForSettle: true });
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const { spy } = await pressThenObserve(manager);
      expect(backend.callsFor("waitForSettle")).toHaveLength(0);
      expect(settleWaitedFor(spy, 60)).toBe(true);
      await manager.dispose();
    });

    it.each([
      ["Unknown tool: wait_for_settle [effect=not-dispatched; automatic replay is forbidden]"],
      ["Unsupported computer host request."],
    ] as const)(
      "a backend that cannot name the tool falls back once and is never probed again — %s",
      async (refusalMessage) => {
        setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", undefined);
        let probes = 0;
        const backend = new ProvenBackend({
          waitForSettle: () => {
            probes += 1;
            throw new Error(refusalMessage);
          },
        });
        const manager = new ComputerManager({ backend, actionSettleMs: 60 });
        const spy = vi.spyOn(globalThis, "setTimeout");
        await pressThenObserveWindow(manager);
        expect(probes).toBe(1);
        expect(settleWaitedFor(spy, 60)).toBe(true);
        spy.mockClear();
        await pressThenObserveWindow(manager);
        // The refusal is cached for the backend's life: the second action
        // goes straight to the fixed wait instead of paying a dead call.
        expect(probes).toBe(1);
        expect(backend.callsFor("waitForSettle")).toHaveLength(1);
        expect(settleWaitedFor(spy, 60)).toBe(true);
        await manager.dispose();
      },
    );

    it("a transient observer failure falls back for that call but does not poison the probe", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", undefined);
      let fail = true;
      const backend = new ProvenBackend({
        waitForSettle: () => {
          if (fail)
            throw new Error(
              "wait_for_settle: window_id 42 is closed, stale, or unknown to WindowServer",
            );
          return { settled: true, waitedMs: 30 };
        },
      });
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const spy = vi.spyOn(globalThis, "setTimeout");
      await pressThenObserveWindow(manager);
      expect(backend.callsFor("waitForSettle")).toHaveLength(1);
      expect(settleWaitedFor(spy, 60)).toBe(true);
      fail = false;
      spy.mockClear();
      await pressThenObserveWindow(manager);
      // Not remembered as unsupported: the next action retries the observer
      // and this time it answers, so no fixed wait runs.
      expect(backend.callsFor("waitForSettle")).toHaveLength(2);
      expect(settleWaitedFor(spy, 60)).toBe(false);
      await manager.dispose();
    });

    it("a proven effect still skips the wait entirely, observer included", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const backend = new ProvenBackend({ waitForSettle: true });
      backend.proof = { effect: "verified" };
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      const { spy } = await pressThenObserveWindow(manager);
      expect(backend.callsFor("waitForSettle")).toHaveLength(0);
      expect(settleWaitedFor(spy, 60)).toBe(false);
      await manager.dispose();
    });

    it("an observer refusal mid-observation never replays the action", async () => {
      setEnv("SYNARA_CUA_CONDITIONAL_SETTLE", undefined);
      const backend = new ProvenBackend({
        waitForSettle: () => {
          throw new Error("Unknown tool: wait_for_settle");
        },
      });
      const manager = new ComputerManager({ backend, actionSettleMs: 60 });
      await pressThenObserveWindow(manager);
      // The uncertain wait fell back and the observation still landed; the
      // action it observed ran exactly once.
      expect(backend.callsFor("pressKey")).toHaveLength(1);
      expect(backend.callsFor("captureScreenshot")).toHaveLength(1);
      await manager.dispose();
    });
  });

  it("attributes every action event to the thread that drove it", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const actions: Array<{ action: string; threadId?: string }> = [];
    manager.onEvent((event) => {
      if (event.type !== "computer.action") return;
      actions.push({
        action: event.action,
        ...(event.threadId === undefined ? {} : { threadId: event.threadId }),
      });
    });

    await manager.launchApp("thread-1", "kcalc");
    await manager.click("thread-1", { x: 10, y: 10 });
    await manager.doubleClick("thread-1", { x: 10, y: 10 });
    await manager.rightClick("thread-1", { x: 10, y: 10 });
    await manager.moveCursor("thread-1", { x: 10, y: 10 });
    await manager.drag("thread-1", { x: 10, y: 10 }, { x: 20, y: 20 });
    await manager.scroll("thread-1", null, 0, 12);
    await manager.typeText("thread-1", "hi");
    await manager.pressKey("thread-1", "enter");
    await manager.hotkey("thread-1", ["ctrl", "s"]);
    await manager.writeClipboard("thread-1", "clip");
    await manager.readClipboard("thread-1");
    await manager.setValue("thread-1", { label: "Display" }, "12");
    await manager.performAction("thread-1", { label: "Calculate", role: "button" }, "activate");
    await manager.selectText("thread-1", { label: "Display" }, { start: 0, length: 1 });

    expect(actions).toEqual([
      { action: "computer_launch_app", threadId: "thread-1" },
      { action: "computer_click", threadId: "thread-1" },
      { action: "computer_click", threadId: "thread-1" },
      { action: "computer_click", threadId: "thread-1" },
      { action: "computer_move_cursor", threadId: "thread-1" },
      { action: "computer_drag", threadId: "thread-1" },
      { action: "computer_scroll", threadId: "thread-1" },
      { action: "computer_type_text", threadId: "thread-1" },
      { action: "computer_press_key", threadId: "thread-1" },
      { action: "computer_press_key", threadId: "thread-1" },
      { action: "computer_write_clipboard", threadId: "thread-1" },
      { action: "computer_read_clipboard", threadId: "thread-1" },
      { action: "computer_set_value", threadId: "thread-1" },
      { action: "computer_perform_action", threadId: "thread-1" },
      { action: "computer_select_text", threadId: "thread-1" },
    ]);

    await manager.dispose();
  });

  it("carries clipboard text on the shared action result, and refuses it without backend support", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });

    await manager.writeClipboard("thread-1", "shared text");
    await expect(manager.readClipboard("thread-1")).resolves.toMatchObject({
      action: "computer_read_clipboard",
      value: "shared text",
    });

    // Reads are bounded by the contract limit on `value`; writes are not, so a
    // large paste is fine but cannot come back through the result field.
    await manager.writeClipboard("thread-1", "x".repeat(16 * 1024 + 1));
    await expect(manager.readClipboard("thread-1")).rejects.toThrow(/more than the 16384/);

    const withoutClipboard = new ComputerManager({
      backend: new Proxy(new FakeComputerBackend(), {
        get: (target, property, receiver) =>
          property === "readClipboard" || property === "writeClipboard"
            ? undefined
            : Reflect.get(target, property, receiver),
      }),
    });
    await expect(withoutClipboard.readClipboard("thread-1")).rejects.toThrow(
      /does not support clipboard access/,
    );
    await expect(withoutClipboard.writeClipboard("thread-1", "nope")).rejects.toThrow(
      /does not support clipboard access/,
    );

    await manager.dispose();
    await withoutClipboard.dispose();
  });

  it("tells the backend which thread is driving, so the agent cursor can name it", async () => {
    const backend = new FakeComputerBackend();
    const names: Array<string | null> = [];
    const drivable = Object.assign(backend, {
      setDrivingAgent: async (name: string | null) => {
        names.push(name);
      },
    });
    const manager = new ComputerManager({ backend: drivable });

    // Pane input belongs to the human, who is not an agent and takes no lease.
    await manager.click(undefined, { x: 10, y: 10 });
    expect(names).toEqual([]);

    manager.setThreadLabel("thread-1", "Luna");
    await manager.click("thread-1", { x: 10, y: 10 });
    expect(names).toEqual(["Luna"]);

    // A rename while this thread is on screen reaches the badge immediately.
    manager.setThreadLabel("thread-1", "Luna · seat fix");
    expect(names).toEqual(["Luna", "Luna · seat fix"]);

    // A thread the tool layer never named still takes the desktop; the plugin
    // falls back to a generic label rather than showing a thread id.
    await manager.releaseDesktopControl("thread-1");
    await manager.click("thread-2", { x: 10, y: 10 });
    expect(names).toEqual(["Luna", "Luna · seat fix", null, null]);

    // Labelling a thread that is not driving records it without touching the
    // badge the human is currently looking at.
    manager.setThreadLabel("thread-1", "Luna again");
    expect(names).toHaveLength(4);

    await manager.dispose();
  });

  it("asks the UI to open the pane once per thread, and only for agent actions", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const openRequests: string[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.open-pane-requested") openRequests.push(event.threadId);
    });

    // Pane input carries no thread and must never summon the pane.
    await manager.click(undefined, { x: 10, y: 10 });
    expect(openRequests).toEqual([]);

    // The first attributed action surfaces the pane; the rest of the turn is
    // silent so a user who closed the pane is not yanked back per click.
    await manager.click("thread-1", { x: 10, y: 10 });
    await manager.typeText("thread-1", "hi");
    expect(openRequests).toEqual(["thread-1"]);

    // Giving up the desktop ends the turn: the next attributed action
    // surfaces the pane once more, then goes silent again within the turn.
    await manager.releaseDesktopControl("thread-1");
    await manager.click("thread-1", { x: 20, y: 20 });
    expect(openRequests).toEqual(["thread-1", "thread-1"]);
    await manager.typeText("thread-1", "again");
    expect(openRequests).toEqual(["thread-1", "thread-1"]);

    // A second thread surfaces independently of the first.
    await manager.releaseDesktopControl("thread-1");
    await manager.pressKey("thread-2", "enter");
    expect(openRequests).toEqual(["thread-1", "thread-1", "thread-2"]);

    // A removed thread must be explicitly restored before it may act again.
    await manager.handleThreadRemoved("thread-2");
    await expect(manager.pressKey("thread-2", "enter")).rejects.toThrow("revoked");
    await manager.handleThreadRestored("thread-2");
    await manager.pressKey("thread-2", "enter");
    expect(openRequests).toEqual(["thread-1", "thread-1", "thread-2", "thread-2"]);

    await manager.dispose();
  });

  it("re-surfaces the pane for an evicted owner without waiting for its release", async () => {
    const backend = new FakeComputerBackend();
    let nowMs = 0;
    const manager = new ComputerManager({
      backend,
      now: () => nowMs,
      leaseIdleMs: 1_000,
    });
    const openRequests: string[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.open-pane-requested") openRequests.push(event.threadId);
    });

    await manager.click("thread-a", { x: 10, y: 10 });
    expect(openRequests).toEqual(["thread-a"]);

    // thread-a goes silent past idle and thread-b evicts its stale lease.
    nowMs = 2_000;
    await manager.click("thread-b", { x: 20, y: 20 });
    expect(openRequests).toEqual(["thread-a", "thread-b"]);

    // thread-b goes idle too. thread-a drives again and must re-surface:
    // its release would have returned early on the lease-owner check, so a
    // flag that only cleared there could never fire again.
    nowMs = 4_000;
    await manager.click("thread-a", { x: 30, y: 30 });
    expect(openRequests).toEqual(["thread-a", "thread-b", "thread-a"]);

    await manager.dispose();
  });

  it("drives a second ordinary app without asking", async () => {
    // The second-app boundary is gone: only the denylist can refuse a drive.
    // Two ordinary apps dispatch back to back with no prompt surface involved.
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const request = vi.spyOn(computerApprovalGate, "request");
    try {
      await manager.launchApp("thread-1", "kcalc");
      await manager.launchApp("thread-1", "firefox");
      expect(backend.callsFor("launchApp")).toHaveLength(2);
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
      computerApprovalGate.cancelThread("thread-1");
      await manager.dispose();
    }
  });

  it("applies visibility writes to any non-denied app", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    try {
      // Minimizing the terminal's window and hiding pid 1002 (the calculator)
      // are both ordinary drives, so both dispatch.
      await manager.setWindowMinimized("thread-1", "fake-terminal", true);
      await manager.setAppVisibility("thread-1", 1_002, true);
      expect(backend.callsFor("setAppVisibility")).toHaveLength(1);
      // A pid nothing resolves to reaches the backend, whose own refusal is
      // what surfaces.
      await expect(manager.setAppVisibility("thread-1", 9_999, true)).rejects.toThrow(
        /No running application has pid 9999/,
      );
    } finally {
      computerApprovalGate.cancelThread("thread-1");
      await manager.dispose();
    }
  });

  it("invokes a windowless menu target on the app name's live pid", async () => {
    const backend = new FakeComputerBackend({
      apps: [
        { pid: 6_001, name: "Helium", bundleId: "net.imput.helium", running: true, active: false },
        { pid: 1_001, name: "Terminal", bundleId: "org.kde.konsole", running: true, active: true },
      ],
    });
    const manager = new ComputerManager({ backend });
    try {
      const authorization = { userRequestedVisibleUse: true };
      await expect(
        manager.invokeMenu("thread-1", { app: "Helium" }, ["File"]),
      ).rejects.toMatchObject({
        code: "foreground_not_requested",
        effect: "not-dispatched",
      });
      expect(backend.callsFor("invokeMenu")).toHaveLength(0);
      const result = await manager.invokeMenu(
        "thread-1",
        { app: "Helium" },
        ["File", "New Window"],
        authorization,
      );
      expect(backend.callsFor("invokeMenu").at(-1)?.args).toEqual([
        { pid: 6_001 },
        ["File", "New Window"],
      ]);
      // No window took part, so the result names no window.
      expect(result.windowId).toBeUndefined();
      // An unknown spelling refuses with the list_apps pointer rather than
      // guessing a process.
      await expect(
        manager.invokeMenu("thread-1", { app: "Ghost" }, ["File"], authorization),
      ).rejects.toMatchObject({ code: "computer_target_not_found", notFound: true });
      expect(backend.callsFor("invokeMenu")).toHaveLength(1);
      // The pid form rides through to the backend, which refuses a pid that
      // is not running.
      await expect(
        manager.invokeMenu("thread-1", { pid: 9_999 }, ["File"], authorization),
      ).rejects.toThrow(/No running application has pid 9999/);
    } finally {
      computerApprovalGate.cancelThread("thread-1");
      await manager.dispose();
    }
  });

  it("says plainly when an unhide ran on an app with no windows", async () => {
    const backend = new FakeComputerBackend({
      apps: [
        { pid: 6_001, name: "Helium", bundleId: "net.imput.helium", running: true, active: false },
        { pid: 1_001, name: "Terminal", bundleId: "org.kde.konsole", running: true, active: true },
        { pid: 1_002, name: "Calculator", bundleId: "org.kde.kcalc", running: true, active: false },
      ],
    });
    const manager = new ComputerManager({ backend });
    try {
      // The listing the manager remembers holds windows, none for Helium.
      await manager.listWindows();
      const shown = await manager.setAppVisibility(undefined, 6_001, false);
      expect(shown.delivery?.verified).toBe("confirmed");
      expect(shown.note).toEqual(expect.stringContaining("no window"));
      expect(shown.note).toContain("computer_invoke_menu");
      expect(shown.note).toContain("computer_browser_prepare");
      expect(shown.note).toContain("computer_browser_state");
      expect(shown.note).not.toContain("allow_launch");
      // Hiding is not an unhide: no note, even with no window.
      const hidden = await manager.setAppVisibility(undefined, 6_001, true);
      expect(hidden.note).toBeUndefined();
      // An app whose window the listing holds earns no note either.
      const withWindow = await manager.setAppVisibility(undefined, 1_002, false);
      expect(withWindow.note).toBeUndefined();
    } finally {
      await manager.dispose();
    }
  });

  it("keeps background launch separate from explicitly hiding the application", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    try {
      // Leave the backend default nonactivating launch intact.
      await manager.launchApp("thread-1", "kcalc");
      expect(backend.callsFor("launchApp").at(-1)?.args).toEqual(["kcalc", []]);
      // Hiding remains an explicit option.
      await manager.launchApp("thread-1", "kcalc", [], 0, { hidden: true });
      expect(backend.callsFor("launchApp").at(-1)?.args).toEqual(["kcalc", [], { hidden: true }]);
      // Unhidden windows still do not request foreground activation.
      await manager.launchApp("thread-1", "kcalc", [], 0, { hidden: false });
      expect(backend.callsFor("launchApp").at(-1)?.args).toEqual(["kcalc", [], { hidden: false }]);
    } finally {
      computerApprovalGate.cancelThread("thread-1");
      await manager.dispose();
    }
  });

  it("still asks for the pane when the agent drives the human's visible desktop", async () => {
    // The preview is wanted there too: the pane renders stills only on a shared
    // display, and the client gates the actual opening on its auto-open
    // preference — emitting costs a pref-off user nothing.
    const backend = new FakeComputerBackend({
      capabilities: {
        ...new FakeComputerBackend().capabilities(),
        visibleDesktop: true,
      },
    });
    const manager = new ComputerManager({ backend });
    const openRequests: string[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.open-pane-requested") openRequests.push(event.threadId);
    });

    await manager.click("thread-1", { x: 10, y: 10 });
    await manager.typeText("thread-1", "hi");

    expect(openRequests).toEqual(["thread-1"]);
    await manager.dispose();
  });

  it("leaves pane input unattributed instead of borrowing a thread", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const actions: Array<Record<string, unknown>> = [];
    manager.onEvent((event) => {
      if (event.type === "computer.action") actions.push({ ...event });
    });

    await manager.click(undefined, { x: 10, y: 10 });
    await manager.launchApp(undefined, "kcalc");
    // A whitespace-only caller is not a thread either.
    await manager.pressKey("  ", "enter");

    expect(actions.every((action) => !("threadId" in action))).toBe(true);
    expect(actions).toHaveLength(3);

    await manager.dispose();
  });

  it("gives the desktop to the first thread that drives it and refuses the second", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const states: ThreadComputerState[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") states.push(event.state);
    });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    await manager.click("thread-a", { x: 10, y: 10 });
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toMatchObject({
      code: "computer_controlled_by_other_thread",
      retryable: false,
      message: expect.stringMatching(/another conversation; no input was sent\. Do not retry/),
    });

    // Watching is safe while someone else drives, so nothing read-only is gated
    // — including the blocked thread's own state.
    await expect(manager.listWindows()).resolves.toMatchObject({
      computerId: backend.computerId,
    });
    await expect(manager.getState({})).resolves.toMatchObject({
      computerId: backend.computerId,
    });
    await expect(manager.getScreenSize()).resolves.toMatchObject({
      computerId: backend.computerId,
    });
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });
    await expect(manager.getThreadState("thread-a")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });

    // The human at the pane is not a competing agent: their input carries no
    // thread, and it neither waits for the lease nor takes it.
    await expect(manager.click(undefined, { x: 30, y: 30 })).resolves.toMatchObject({
      action: "computer_click",
    });
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toMatchObject({
      code: "computer_controlled_by_other_thread",
    });

    // Both panels learned about the handover without polling.
    expect(
      states.some((state) => state.threadId === "thread-b" && state.controlledByOtherThread),
    ).toBe(true);
    expect(states.findLast((state) => state.threadId === "thread-a")?.controlledByOtherThread).toBe(
      false,
    );

    await manager.dispose();
  });

  it("allows different threads to overlap exact-window semantic text", async () => {
    const release = deferred();
    let active = 0;
    let peak = 0;
    const windowIds = ["editor-a", "editor-b"];
    const windows = windowIds.map(
      (id, index): ComputerWindow => ({
        id,
        title: `Editor ${index + 1}`,
        bounds: { x: index * 400, y: 0, width: 360, height: 300 },
        focused: false,
        minimized: false,
        visible: true,
      }),
    );
    const backend = Object.assign(
      new FakeComputerBackend({
        windows,
        root: semanticTextRoot(windowIds),
      }),
      {
        focusNeutralSemanticText: true,
        typeText: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await release.promise;
          active -= 1;
          return {};
        },
      },
    );
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    const first = manager.withAgentActivity(
      "thread-a",
      () => manager.typeText("thread-a", "alpha", "editor-a"),
      undefined,
      "turn-a",
      "editor-a",
    );
    const second = manager.withAgentActivity(
      "thread-b",
      () => manager.typeText("thread-b", "bravo", "editor-b"),
      undefined,
      "turn-b",
      "editor-b",
    );
    await vi.waitFor(() => expect(peak).toBe(2));
    release.resolve();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(backend.callsFor("clearFocusWindow")).toHaveLength(0);
    expect(backend.callsFor("focusWindow")).toHaveLength(0);
    await manager.dispose();
  });

  it("hands the desktop to the next thread when the owner's turn ends", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    await manager.launchApp("thread-a", "kcalc");
    await expect(manager.typeText("thread-b", "hi")).rejects.toThrow(/another conversation/);

    // What provider runtime ingestion calls on turn.completed / turn.aborted /
    // session.exited.
    await manager.releaseDesktopControl("thread-a");
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });

    await expect(manager.typeText("thread-b", "hi")).resolves.toMatchObject({
      action: "computer_type_text",
    });
    // A's next turn now waits on B, and a release from a thread that no longer
    // owns the desktop cannot take it away from B.
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );
    await manager.releaseDesktopControl("thread-a");
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );
    await expect(manager.getThreadState("thread-a")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });

    // Removing the owning thread frees the desktop the same way.
    await manager.handleThreadRemoved("thread-b");
    await expect(manager.click("thread-a", { x: 10, y: 10 })).resolves.toMatchObject({
      action: "computer_click",
    });

    await manager.dispose();
  });

  it("releases desktop control even when preview cleanup is delayed or fails", async () => {
    const pending = deferred();
    const backend = Object.assign(new FakeComputerBackend(), {
      endTask: vi.fn(async () => {
        await pending.promise;
        throw new Error("Preview cleanup failed");
      }),
    });
    const manager = new ComputerManager({ backend });
    const states: ThreadComputerState[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") states.push(event.state);
    });
    await manager.launchApp("thread-a", "kcalc");
    const cleared = backend.callsFor("clearFocusWindow").length;
    const release = manager.releaseDesktopControl("thread-a", "turn-one");
    await vi.waitFor(() => expect(backend.callsFor("clearFocusWindow")).toHaveLength(cleared + 1));
    await vi.waitFor(async () =>
      expect((await manager.getThreadState("thread-b")).controlledByOtherThread).toBe(false),
    );
    await expect(manager.typeText("thread-b", "hi")).resolves.toMatchObject({
      action: "computer_type_text",
    });
    // The release promise must settle while endTask remains pending, so it
    // cannot wedge lifecycle ingestion or the owning action's finalizer.
    let released = false;
    void release.then(() => {
      released = true;
    });
    try {
      await vi.waitFor(() => expect(released).toBe(true));
    } finally {
      pending.resolve();
    }
    await release;
    expect(backend.endTask).toHaveBeenCalledWith("thread-a", "turn-one");
    // The failure is still evidence: a stale preview is reported on the
    // owner's state rather than silently leaked.
    await vi.waitFor(() =>
      expect(
        states.some(
          (state) =>
            state.threadId === "thread-a" && state.lastError?.includes("Preview cleanup failed"),
        ),
      ).toBe(true),
    );
    await manager.dispose();
  });

  it("records lease transitions without text or cursor labels and discourages blocked retries", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let nowMs = 0;
    const manager = new ComputerManager({
      backend: new FakeComputerBackend(),
      now: () => nowMs,
      leaseIdleMs: 1_000,
    });
    try {
      manager.setThreadLabel("thread-a", "Private window title");
      await manager.withAgentActivity(
        "thread-a",
        () => manager.typeText("thread-a", "private typed value"),
        undefined,
        "turn-a",
      );
      await expect(manager.typeText("thread-b", "blocked text")).rejects.toMatchObject({
        code: "computer_controlled_by_other_thread",
        retryable: false,
        message: expect.stringContaining("Do not retry"),
      });
      nowMs = 2_000;
      await manager.withAgentActivity(
        "thread-b",
        () => manager.click("thread-b", { x: 10, y: 10 }),
        undefined,
        "turn-b",
      );
      await manager.releaseDesktopControl("thread-b", "turn-b");
      const entries = log.mock.calls
        .filter(([message]) => message === "[computer] desktop lease")
        .map(([, entry]) => entry);
      expect(entries).toEqual([
        {
          ts: new Date(0).toISOString(),
          event: "acquired",
          threadId: "thread-a",
          turnId: "turn-a",
        },
        {
          ts: new Date(2_000).toISOString(),
          event: "stale-reclaimed",
          threadId: "thread-a",
          turnId: "turn-a",
          nextThreadId: "thread-b",
          idleMs: 2_000,
        },
        {
          ts: new Date(2_000).toISOString(),
          event: "acquired",
          threadId: "thread-b",
          turnId: "turn-b",
        },
        {
          ts: new Date(2_000).toISOString(),
          event: "released",
          threadId: "thread-b",
          turnId: "turn-b",
        },
      ]);
      expect(JSON.stringify(entries)).not.toMatch(/private|blocked|title/i);
    } finally {
      await manager.dispose();
      log.mockRestore();
    }
  });

  /**
   * The release runtime ingestion sends on session.exited can land while the
   * dead session's last call is still executing — a gateway call cannot be
   * aborted. Handing the desktop over at that moment would put two threads on
   * the same pointer, so the release waits for the call to drain.
   */
  it("defers a release until the owner's in-flight call drains", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    const started = deferred();
    const finish = deferred();
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      await manager.click("thread-a", { x: 10, y: 10 });
      started.resolve();
      await finish.promise;
    });
    await started.promise;

    await manager.releaseDesktopControl("thread-a");
    // Still A's desktop: the release is recorded, not applied.
    await expect(manager.typeText("thread-b", "hi")).rejects.toThrow(/another conversation/);
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });

    finish.resolve();
    await inFlight;
    // The drain completed the release, and told every thread so.
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });
    await expect(manager.typeText("thread-b", "hi")).resolves.toMatchObject({
      action: "computer_type_text",
    });
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );

    await manager.dispose();
  });

  it("keeps a deferred release when the owner renews the lease mid-drain", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    const started = deferred();
    const releaseRecorded = deferred();
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      await manager.click("thread-a", { x: 10, y: 10 });
      started.resolve();
      await releaseRecorded.promise;
      // The dead session's operation keeps acting after the release was
      // recorded. Renewing the lease must not forget that release.
      await manager.click("thread-a", { x: 11, y: 11 });
    });
    await started.promise;
    await manager.releaseDesktopControl("thread-a");
    releaseRecorded.resolve();
    await inFlight;

    expect(backend.callsFor("click")).toHaveLength(2);
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });
    await expect(manager.typeText("thread-b", "hi")).resolves.toMatchObject({
      action: "computer_type_text",
    });

    await manager.dispose();
  });

  it("does not tear down a renewed lease for a stale deferred release", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    const started = deferred();
    const releaseRecorded = deferred();
    const finish = deferred();
    const inFlight = manager.withAgentActivity(
      "thread-a",
      async () => {
        await manager.click("thread-a", { x: 10, y: 10 });
        started.resolve();
        await releaseRecorded.promise;
        // Turn two renews the lease while turn one's release is still only
        // recorded — the deferred release must not tear the renewal down.
        await manager.withAgentActivity(
          "thread-a",
          () => manager.click("thread-a", { x: 11, y: 11 }),
          undefined,
          "turn-2",
        );
        await finish.promise;
      },
      undefined,
      "turn-1",
    );
    await started.promise;
    await manager.releaseDesktopControl("thread-a", "turn-1");
    releaseRecorded.resolve();
    finish.resolve();
    await inFlight;

    // Turn one's deferred release matched the stamped turn and left turn
    // two's lease alone: the desktop still belongs to thread-a.
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });
    await expect(manager.typeText("thread-b", "hi")).rejects.toThrow(/another conversation/);

    // The owning turn can still release normally.
    await manager.releaseDesktopControl("thread-a", "turn-2");
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });

    await manager.dispose();
  });

  it("does not let a queued thread-level release tear down a newer turn", async () => {
    const backend = Object.assign(new FakeComputerBackend(), {
      endTask: vi.fn(async () => {}),
    });
    const manager = new ComputerManager({ backend });
    const started = deferred();
    const finish = deferred();
    try {
      await manager.withAgentActivity(
        "thread-a",
        () => manager.click("thread-a", { x: 10, y: 10 }),
        undefined,
        "turn-old",
      );
      const blocker = manager.withAgentActivity("reader", async () => {
        started.resolve();
        await finish.promise;
      });
      await started.promise;
      const renewed = manager.withAgentActivity(
        "thread-a",
        () => manager.click("thread-a", { x: 20, y: 20 }),
        undefined,
        "turn-new",
      );
      const released = manager.releaseDesktopControl("thread-a");
      finish.resolve();
      await Promise.all([blocker, renewed, released]);
      expect(backend.endTask).toHaveBeenCalledExactlyOnceWith("thread-a", "turn-old");
      await expect(manager.typeText("thread-b", "second")).rejects.toMatchObject({
        code: "computer_controlled_by_other_thread",
      });
      await manager.releaseDesktopControl("thread-a", "turn-new");
      await expect(manager.typeText("thread-b", "second")).resolves.toMatchObject({
        action: "computer_type_text",
      });
    } finally {
      finish.resolve();
      await manager.dispose();
    }
  });

  it("does not stamp a released turn onto a later turnId-less claim", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    await manager.withAgentActivity(
      "thread-a",
      () => manager.click("thread-a", { x: 10, y: 10 }),
      undefined,
      "turn-1",
    );
    await manager.releaseDesktopControl("thread-a", "turn-1");

    // The turn ended and released; a turnId-less caller claims anonymously —
    // inheriting turn-1's stamp would refuse the real turn's own release.
    await manager.withAgentActivity("thread-a", () => manager.click("thread-a", { x: 11, y: 11 }));
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });
    await manager.releaseDesktopControl("thread-a", "turn-2");
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });

    await manager.dispose();
  });

  it("still fully removes a thread whose stop rejects in preview cleanup", async () => {
    const backend = Object.assign(new FakeComputerBackend(), {
      endTask: vi.fn(async () => {
        throw new Error("Preview cleanup failed");
      }),
    });
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-b");
    await manager.launchApp("thread-a", "kcalc");

    // A rejected cleanup must not fail the removal itself — every step still
    // runs: the lease released, the thread's state gone, nobody left blocked.
    await manager.handleThreadRemoved("thread-a");
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });
    await expect(manager.typeText("thread-b", "hi")).resolves.toMatchObject({
      action: "computer_type_text",
    });
    await manager.dispose();
  });

  it("clears an evicted owner's turn stamp along with its stale lease", async () => {
    const backend = new FakeComputerBackend();
    let nowMs = 0;
    const manager = new ComputerManager({
      backend,
      now: () => nowMs,
      leaseIdleMs: 1_000,
    });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    // thread-a holds the desktop under turn-1, then goes silent past idle.
    await manager.withAgentActivity(
      "thread-a",
      () => manager.click("thread-a", { x: 10, y: 10 }),
      undefined,
      "turn-1",
    );
    nowMs = 2_000;
    // thread-b evicts the stale lease — turn-1's authority dies with it.
    await manager.withAgentActivity(
      "thread-b",
      () => manager.click("thread-b", { x: 10, y: 10 }),
      undefined,
      "turn-9",
    );
    // thread-b goes idle too; thread-a re-claims with no turn attribution.
    nowMs = 4_000;
    await manager.withAgentActivity("thread-a", () => manager.click("thread-a", { x: 11, y: 11 }));
    // Had the dead stamp survived eviction, this release would be refused as
    // turn-mismatched — the anonymous lease must release for any named turn.
    await manager.releaseDesktopControl("thread-a", "turn-5");
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: false,
    });
    await manager.dispose();
  });

  it("drops an anonymous deferred release once a turn renews the lease", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    const started = deferred();
    const releaseRecorded = deferred();
    const finish = deferred();
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      await manager.click("thread-a", { x: 10, y: 10 });
      started.resolve();
      await releaseRecorded.promise;
      // A real turn renews while the anonymous release is only recorded.
      await manager.withAgentActivity(
        "thread-a",
        () => manager.click("thread-a", { x: 11, y: 11 }),
        undefined,
        "turn-2",
      );
      await finish.promise;
    });
    await started.promise;
    // A thread-level (turnId-less) release on an anonymous lease: nothing to
    // match later, so it must not outlive the turn-2 renewal.
    await manager.releaseDesktopControl("thread-a");
    releaseRecorded.resolve();
    finish.resolve();
    await inFlight;

    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });
    await expect(manager.typeText("thread-b", "hi")).rejects.toThrow(/another conversation/);
    await manager.dispose();
  });

  it("reacquires the lease for a new turn after the previous operation drains", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    await manager.getThreadState("thread-a");

    const started = deferred();
    const finish = deferred();
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      await manager.click("thread-a", { x: 10, y: 10 });
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    await manager.releaseDesktopControl("thread-a");
    // The next turn waits for the old operation, then takes a fresh lease.
    const nextTurn = manager.click("thread-a", { x: 20, y: 20 });
    expect(backend.callsFor("click")).toHaveLength(1);
    finish.resolve();
    await inFlight;
    await nextTurn;

    await expect(manager.typeText("thread-b", "hi")).rejects.toThrow(/another conversation/);
    await expect(manager.getThreadState("thread-b")).resolves.toMatchObject({
      controlledByOtherThread: true,
    });

    await manager.dispose();
  });

  it("expires an idle lease as a backstop, but never one whose owner is still acting", async () => {
    const backend = new FakeComputerBackend();
    let nowMs = 0;
    const manager = new ComputerManager({
      backend,
      now: () => nowMs,
      leaseIdleMs: 1_000,
    });
    await manager.getThreadState("thread-a");

    await manager.click("thread-a", { x: 10, y: 10 });
    nowMs = 999;
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toThrow(
      /another conversation/,
    );

    // An owner that is mid-call still holds the pointer, however long ago the
    // call started — the crash this backstop exists for leaves nothing running.
    nowMs = 10_000;
    const started = deferred();
    const finish = deferred();
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toThrow(
      /another conversation/,
    );
    finish.resolve();
    await inFlight;

    await expect(manager.click("thread-b", { x: 20, y: 20 })).resolves.toMatchObject({
      action: "computer_click",
    });
    await expect(manager.click("thread-a", { x: 10, y: 10 })).rejects.toThrow(
      /another conversation/,
    );

    await manager.dispose();
  });

  /**
   * The same backstop, on the backend that ships: a visible desktop surfaces no
   * pane, so nothing ever created a runtime record for an agent thread, and the
   * in-flight guard read zero from a thread that was mid-drag. The desktop could
   * then be taken from under it by another conversation.
   */
  it("counts an agent's in-flight call even when no panel ever asked about it", async () => {
    const backend = new FakeComputerBackend({
      capabilities: {
        ...new FakeComputerBackend().capabilities(),
        visibleDesktop: true,
      },
    });
    let nowMs = 0;
    const manager = new ComputerManager({
      backend,
      now: () => nowMs,
      leaseIdleMs: 1_000,
    });

    const started = deferred();
    const finish = deferred();
    // Nothing here asks for thread state: this is a thread whose only contact
    // with the manager is the tool calls it makes.
    const inFlight = manager.withAgentActivity("thread-a", async () => {
      await manager.click("thread-a", { x: 10, y: 10 });
      started.resolve();
      await finish.promise;
    });
    await started.promise;

    nowMs = 10_000;
    await expect(manager.click("thread-b", { x: 20, y: 20 })).rejects.toThrow(
      /another conversation/,
    );

    finish.resolve();
    await inFlight;
    // Once the call really has finished, the idle lease is up for grabs again.
    await expect(manager.click("thread-b", { x: 20, y: 20 })).resolves.toMatchObject({
      action: "computer_click",
    });

    await manager.dispose();
  });

  /**
   * Every publish reads the window list, and every window read can report a
   * change, so one change used to schedule a pass whose own reads scheduled the
   * next — multiplied by thread count, on a desktop where nothing more than a
   * clock title was moving.
   */
  it("coalesces a burst of window changes into a single publish pass", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({
      backend,
      windowsPublishDebounceMs: 5,
    });
    // The churn this coalesces comes from a live backend, which by definition
    // something has already used. Engaging before either thread exists keeps the
    // republish that engagement triggers out of the count below.
    await manager.listWindows();
    await manager.getThreadState("thread-a");
    await manager.getThreadState("thread-b");

    const publishes: string[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") publishes.push(event.state.threadId);
    });
    const readsBefore = backend.callsFor("listWindows").length;

    for (let index = 0; index < 20; index += 1) {
      backend.emitWindowsChanged([
        {
          id: "clock",
          title: `Clock — 12:00:${index}`,
          bounds: { x: 0, y: 0, width: 100, height: 40 },
          focused: false,
          minimized: false,
          visible: true,
        },
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));

    // One pass, one thread state each, one window read each — not twenty.
    expect(publishes).toEqual(["thread-a", "thread-b"]);
    expect(backend.callsFor("listWindows").length - readsBefore).toBe(1);

    await manager.dispose();
  });

  it("lets one thread keep driving across a long think, and keeps perception free", async () => {
    const backend = new FakeComputerBackend();
    let nowMs = 0;
    const manager = new ComputerManager({
      backend,
      now: () => nowMs,
      leaseIdleMs: 1_000,
    });

    await manager.click("thread-a", { x: 10, y: 10 });
    // Nobody else asked for the desktop while the model thought, so the owner
    // simply picks it back up: expiry is a chance for others, not a revocation.
    nowMs = 60_000;
    await expect(manager.click("thread-a", { x: 10, y: 10 })).resolves.toMatchObject({
      action: "computer_click",
    });
    // Perception from another thread neither takes the lease nor renews it.
    await manager.getState({});
    await manager.listWindows();
    await expect(manager.click("thread-a", { x: 10, y: 10 })).resolves.toMatchObject({
      action: "computer_click",
    });

    await manager.dispose();
  });

  it("runs the synthetic frame attach, publish, and detach loop", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const sink = new RecordingSink();
    const eventTypes: string[] = [];
    manager.onEvent((event) => eventTypes.push(event.type));
    const unsubscribe = manager.subscribeFrames(sink);
    await manager.flushStreamTransitions();

    expect(backend.callsFor("attachStream")).toHaveLength(1);
    expect(sink.received).toHaveLength(2);
    expect(decodeComputerFrame(sink.received[0]!).ok).toBe(true);
    backend.emitFrame(false, false, Uint8Array.of(7, 8));
    expect(sink.received).toHaveLength(3);

    unsubscribe();
    await manager.flushStreamTransitions();
    expect(backend.callsFor("detachStream")).toHaveLength(1);
    const count = sink.received.length;
    backend.emitFrame(true, false);
    expect(sink.received).toHaveLength(count);

    // Frames ride the binary transport alone. The JSON event channel used to
    // carry a `computer.frame` header beside every one of them, which its only
    // consumer read and dropped.
    expect(eventTypes).not.toContain("computer.frame");

    await manager.dispose();
  });

  it("drops late frames and state updates after a thread is removed", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const sink = new RecordingSink();
    const unsubscribe = manager.subscribeFrames(sink);
    await manager.flushStreamTransitions();
    await manager.getThreadState("thread-removed");
    await manager.handleThreadRemoved("thread-removed");

    backend.emitFrame(false, false, Uint8Array.of(9));
    await expect(
      manager.withAgentActivity("thread-removed", async () => undefined),
    ).rejects.toThrow("revoked");
    await manager.recordThreadError("thread-removed", "late error");

    const threads = (manager as unknown as { threads: Map<string, unknown> }).threads;
    expect(threads.has("thread-removed")).toBe(false);

    unsubscribe();
    await manager.dispose();
  });

  it("does not reattach a stream after disposal wins during keyframe recovery", async () => {
    const backend = new FakeComputerBackend();
    const detachStarted = deferred();
    const allowDetach = deferred();
    const detachStream = backend.detachStream.bind(backend);
    (backend as unknown as { requestKeyframe?: undefined }).requestKeyframe = undefined;
    backend.detachStream = async () => {
      detachStarted.resolve();
      await allowDetach.promise;
      await detachStream();
    };
    const manager = new ComputerManager({ backend });
    const unsubscribe = manager.subscribeFrames(new RecordingSink());
    await manager.flushStreamTransitions();

    const request = manager.requestKeyframe();
    await detachStarted.promise;
    const disposal = manager.dispose();
    allowDetach.resolve();
    await Promise.all([request, disposal]);

    expect(backend.callsFor("attachStream")).toHaveLength(1);
    expect(backend.callsFor("detachStream")).toHaveLength(1);
    unsubscribe();
  });

  it("carries the backend's capabilities onto every thread snapshot", async () => {
    // The panel decides which controls to offer from this field alone, so a
    // backend that cannot report geometry has to say so in the snapshot rather
    // than let the panel offer window-scoped actions that will be refused.
    const backend = new FakeComputerBackend({
      capabilities: {
        windows: true,
        windowBounds: false,
        stacking: false,
        capture: true,
        input: true,
        clipboard: false,
        focus: false,
        raise: false,
        ghostCursor: false,
        visibleDesktop: false,
      },
    });
    const manager = new ComputerManager({ backend });

    const state = await manager.getThreadState("thread-1");

    expect(state.capabilities).toEqual(backend.capabilities());
    await manager.dispose();
  });

  it("refuses a window-scoped click when the desktop reports no geometry", async () => {
    // Passing window_id is a request for a guarantee — that the point lands in
    // that window. Without bounds nothing can check it, and clicking anyway
    // would drop the guarantee silently instead of telling the agent to drop
    // the scope or target by label.
    const backend = new FakeComputerBackend({
      windows: [
        {
          id: "boundless",
          title: "Calculator",
          appName: "org.kde.kcalc",
          focused: true,
          minimized: false,
          visible: true,
        },
      ],
    });
    const manager = new ComputerManager({ backend });

    await expect(
      manager.click("thread-1", { x: 100, y: 100, windowId: "boundless" }),
    ).rejects.toMatchObject({ code: "computer_target_offscreen" });
    expect(backend.callsFor("click")).toHaveLength(0);
    await manager.dispose();
  });

  it("returns perception payloads with optional text and screenshot", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend });
    const state = await manager.getState({
      includeScreenshot: true,
      includeText: true,
    });

    expect(state.screenshot?.mimeType).toBe("image/png");
    expect(state.screenshot?.bytesBase64.length).toBeGreaterThan(0);
    expect(state.text).toContain("Calculate");
    expect(state.root?.children.length).toBeGreaterThan(0);

    await manager.dispose();
  });

  it("captures the focused window, and the workspace when nothing capturable has focus", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    const focused = await manager.captureFocusedWindow();
    expect(focused.windowId).toBe("fake-terminal");
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-terminal",
    });

    // A minimized focus holder and an unfocused rest leave nothing with focus
    // on screen except the calculator, the topmost visible window.
    backend.emitWindowsChanged([
      {
        id: "fake-terminal",
        title: "Terminal",
        bounds: { x: 40, y: 40, width: 960, height: 720 },
        focused: true,
        minimized: true,
        visible: false,
        stackingIndex: 1,
      },
      {
        id: "fake-calculator",
        title: "Calculator",
        bounds: { x: 1_050, y: 120, width: 420, height: 620 },
        focused: false,
        minimized: false,
        visible: true,
        stackingIndex: 0,
      },
    ]);
    const topmost = await manager.captureFocusedWindow();
    expect(topmost.windowId).toBe("fake-calculator");

    // With no capturable window at all, the whole workspace is the answer.
    backend.emitWindowsChanged([]);
    const workspace = await manager.captureFocusedWindow(1_024);
    expect(workspace.windowId).toBeUndefined();
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "region",
      region: { x: 0, y: 0, width: 1_920, height: 1_080 },
      maxDimension: 1_024,
    });

    await manager.dispose();
  });

  it("captures the action's window on a hint, reports a vanished target, and never throws", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    const hinted = await manager.captureActionScreenshot("fake-calculator");
    expect(hinted !== undefined && "windowId" in hinted ? hinted.windowId : undefined).toBe(
      "fake-calculator",
    );

    // A hint naming a window the action closed is a result in its own right,
    // never a substitute capture of whatever holds focus — on a live desktop
    // the focused window is the human's once the agent's target is gone.
    const closed = await manager.captureActionScreenshot("gone-window");
    expect(closed).toEqual({ targetWindowClosed: true });

    // A transient capture failure on a window that still exists yields no
    // screenshot, not a picture of some other window.
    backend.failNext("captureScreenshot");
    expect(await manager.captureActionScreenshot("fake-calculator")).toBeUndefined();

    // A capture failure returns nothing rather than failing the finished action.
    backend.failNext("captureScreenshot");
    expect(await manager.captureActionScreenshot()).toBeUndefined();

    await manager.dispose();
  });

  it("observes only the agent's focus target after an untargeted action, never the active window", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    // No window holds the agent's focus; the human's browser is active and
    // topmost. Action observation must widen to the workspace rather than
    // zoom into the human's window.
    backend.emitWindowsChanged([
      {
        id: "human-browser",
        title: "Browser",
        bounds: { x: 100, y: 100, width: 1_200, height: 800 },
        focused: false,
        active: true,
        minimized: false,
        visible: true,
        stackingIndex: 0,
      },
    ]);
    const observed = await manager.captureActionScreenshot();
    expect(observed !== undefined && "windowId" in observed ? observed.windowId : undefined).toBe(
      undefined,
    );
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toMatchObject({
      kind: "region",
    });

    // The perception path keeps its wider fallback: an explicit untargeted
    // screenshot request may still show the active window.
    const perception = await manager.captureFocusedWindow();
    expect(perception.windowId).toBe("human-browser");

    await manager.dispose();
  });

  it("photographs the window under an untargeted action's point instead of the workspace", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    // The scroll-hunting run this fixes: an unscoped pointer action cleared
    // the agent's explicit target, and the old fallback answered with a
    // workspace-wide downscale too small to read. The action's own
    // coordinates name the window it touched, so that window is the picture.
    const observed = await manager.captureActionScreenshot(undefined, {
      x: 1_100,
      y: 200,
    });
    expect(observed !== undefined && "windowId" in observed ? observed.windowId : undefined).toBe(
      "fake-calculator",
    );
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-calculator",
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });

    // A point over bare desktop identifies no window; the agent-focus step
    // still answers (the fake terminal holds the agent's focus by default).
    const desktop = await manager.captureActionScreenshot(undefined, {
      x: 1_800,
      y: 1_000,
    });
    expect(desktop !== undefined && "windowId" in desktop ? desktop.windowId : undefined).toBe(
      "fake-terminal",
    );

    await manager.dispose();
  });

  it("resolves overlapping point candidates by stacking order and refuses to guess without one", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const overlapping = (stacked: boolean): ComputerWindow[] => [
      {
        id: "under",
        title: "Under",
        bounds: { x: 100, y: 100, width: 800, height: 600 },
        focused: false,
        minimized: false,
        visible: true,
        ...(stacked ? { stackingIndex: 1 } : {}),
      },
      {
        id: "over",
        title: "Over",
        bounds: { x: 300, y: 200, width: 400, height: 300 },
        focused: false,
        minimized: false,
        visible: true,
        ...(stacked ? { stackingIndex: 0 } : {}),
      },
    ];

    backend.emitWindowsChanged(overlapping(true));
    const observed = await manager.captureActionScreenshot(undefined, {
      x: 400,
      y: 300,
    });
    expect(observed !== undefined && "windowId" in observed ? observed.windowId : undefined).toBe(
      "over",
    );

    // The same overlap with no stacking order: a guess could photograph a
    // window the action never touched, so the workspace fallback answers.
    backend.emitWindowsChanged(overlapping(false));
    const widened = await manager.captureActionScreenshot(undefined, {
      x: 400,
      y: 300,
    });
    expect(widened !== undefined && "windowId" in widened ? widened.windowId : undefined).toBe(
      undefined,
    );
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toMatchObject({
      kind: "region",
    });

    await manager.dispose();
  });

  it("falls back to the focus path when the point window vanishes before its capture", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    // The point resolved to the calculator, but its capture fails — the
    // window closed in the race. The caller never named it, so the answer is
    // the ordinary focus fallback, not targetWindowClosed and not an error.
    backend.failNext("captureScreenshot");
    const observed = await manager.captureActionScreenshot(undefined, {
      x: 1_100,
      y: 200,
    });
    expect(observed !== undefined && "windowId" in observed ? observed.windowId : undefined).toBe(
      "fake-terminal",
    );

    await manager.dispose();
  });

  it("skips the post-action capture entirely on a backend that cannot capture", async () => {
    const backend = new FakeComputerBackend({
      capabilities: {
        ...new FakeComputerBackend().capabilities(),
        capture: false,
      },
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    expect(await manager.captureActionScreenshot("fake-terminal")).toBeUndefined();
    expect(backend.callsFor("captureScreenshot")).toHaveLength(0);

    await manager.dispose();
  });

  /**
   * The first backend call establishes the backend.
   * Panels are seeded for every chat the web app renders, so the seeding path
   * must stay passive, and the first real use is what pays.
   */
  it("seeds panels from the passive probe, and goes live from the first real use", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const states: ThreadComputerState[] = [];
    manager.onEvent((event) => {
      if (event.type === "computer.thread-state") states.push(event.state);
    });

    const seeded = await manager.getThreadState("thread-1");
    expect(seeded.availability).toEqual({ kind: "available", backend: "fake" });
    expect(seeded.windows).toEqual([]);
    expect(seeded.screenSize).toEqual({ width: 1, height: 1 });
    expect(backend.calls.map((call) => call.method)).toEqual(["probeAvailability"]);

    // The panel is asked again and again while the chat is open; none of that
    // reaches the desktop either.
    await manager.getThreadState("thread-1");
    await manager.getThreadState("thread-2");
    expect(backend.calls.map((call) => call.method)).toEqual([
      "probeAvailability",
      "probeAvailability",
      "probeAvailability",
    ]);

    // One agent tool call, and every panel gets the real desktop.
    await manager.withAgentActivity("thread-1", () => manager.listWindows());
    const live = await manager.getThreadState("thread-1");
    expect(live.windows.map((window) => window.title)).toEqual(["Terminal", "Calculator"]);
    expect(live.screenSize).toEqual({ width: 1_920, height: 1_080, scale: 1 });
    expect(backend.callsFor("availability").length).toBeGreaterThan(0);
    // The engagement republish reaches the thread nobody acted in, too.
    expect(states.findLast((state) => state.threadId === "thread-2")?.windows).toHaveLength(2);

    await manager.dispose();
  });

  it("engages the backend when the pane attaches or the human drives it", async () => {
    const paneBackend = new FakeComputerBackend();
    const paneManager = new ComputerManager({ backend: paneBackend });
    const sink = new RecordingSink();
    const detach = paneManager.subscribeFrames(sink);
    await paneManager.flushStreamTransitions();
    expect(paneBackend.callsFor("attachStream")).toHaveLength(1);
    expect((await paneManager.getThreadState("thread-pane")).windows).toHaveLength(2);
    detach();
    await paneManager.dispose();

    // Pane input carries no thread and takes no lease, and is still the human
    // asking this backend to drive their desktop.
    const inputBackend = new FakeComputerBackend();
    const inputManager = new ComputerManager({ backend: inputBackend });
    await inputManager.click(undefined, { x: 10, y: 10 });
    expect((await inputManager.getThreadState("thread-pane")).windows).toHaveLength(2);
    await inputManager.dispose();
  });

  /**
   * Image tokens scale with pixel area, and a mutating action attaches a shot
   * every time, so the observation spends a quarter of the perception budget.
   * The mapping metadata is what keeps that free: the agent converts pixels to
   * desktop coordinates through region and scale either way.
   */
  it("downscales large action observations while keeping the coordinate mapping exact", async () => {
    const tall = COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION + 1_000;
    const backend = new FakeComputerBackend({
      screenSize: { width: 3_000, height: tall + 400, scale: 1 },
      windows: [
        {
          id: "fake-editor",
          title: "Editor",
          bounds: { x: 100, y: 100, width: 1_280, height: tall },
          focused: true,
          minimized: false,
          visible: true,
        },
      ],
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });

    const observed = await manager.captureActionScreenshot("fake-editor");
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-editor",
      maxDimension: COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION,
    });
    if (observed === undefined || !("screenshot" in observed)) {
      throw new Error("the action observation carried no screenshot");
    }
    const { region, scale, width, height } = observed.screenshot;
    // A window taller than the budget scales down to it, and the region still
    // names the window's own rect, so screenshot (x, y) maps back exactly.
    expect(scale).toBeCloseTo(COMPUTER_ACTION_OBSERVATION_MAX_DIMENSION / tall, 10);
    expect(region).toEqual({ x: 100, y: 100, width: 1_280, height: tall });
    // The middle of the image is still the middle of the window: region.x +
    // screenshot_x / scale, the mapping every computer tool describes.
    if (region === undefined || scale === undefined) throw new Error("no coordinate mapping");
    expect(region.x + width / 2 / scale).toBeCloseTo(region.x + region.width / 2, 0);
    expect(region.y + height / 2 / scale).toBeCloseTo(region.y + region.height / 2, 0);

    // Perception keeps the full budget: zooming back in is how the agent reads
    // detail the observation lost.
    await manager.captureFocusedWindow();
    expect(backend.callsFor("captureScreenshot").at(-1)?.args[0]).toEqual({
      kind: "window",
      windowId: "fake-editor",
    });

    await manager.dispose();
  });

  it("returns every capture for the gateway to compare with delivered screenshots", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      const first = await manager.captureActionScreenshot("fake-terminal");
      const second = await manager.captureActionScreenshot("fake-terminal");
      if (!first || !("screenshot" in first)) throw new Error("Expected a captured screenshot");
      expect(second).toEqual({
        ...first,
        screenshot: { ...first.screenshot, capturedAt: expect.any(String) },
      });
      expect(backend.callsFor("captureScreenshot")).toHaveLength(2);
    } finally {
      await manager.dispose();
    }
  });

  /**
   * A manager whose travel measurement is scripted, so the tests exercise the
   * closed loop rather than the correlator (which has its own unit tests). Each
   * queued screenshot makes one capture's bytes differ from the last, because
   * byte-identical captures short-circuit to "did not move" before measuring.
   */
  function calibratedScrollFixture(
    travels: readonly (number | undefined)[],
    backend = new FakeComputerBackend(),
  ) {
    const measured: number[] = [];
    const manager = new ComputerManager({
      backend,
      actionSettleMs: 0,
      measureScrollTravel: () => travels[measured.push(0) - 1],
    });
    backend.queueScreenshots(Array.from({ length: 12 }, (_unused, index) => `capture-${index}`));
    return { backend, manager, measurements: measured };
  }

  it("probes an unmeasured window, then delivers the remainder pre-corrected", async () => {
    // A GTK-hosted browser gears a pixel delta up by ~7x, and nothing in the
    // protocol says so. Sending the whole request first would travel beyond
    // what the correlator can measure, so the first large scroll goes out as a
    // 48px probe (which travels 336 at 7x — measurable), and the remainder —
    // the request minus what the probe already covered — is divided by the
    // gearing the probe just taught. The first scroll lands on target.
    const { backend, manager } = calibratedScrollFixture([336, 64, 400]);

    const first = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });
    expect(first.result.scroll).toEqual({
      requested: { deltaX: 0, deltaY: 400 },
      // Reported to two decimals; the backend gets the unrounded deltas.
      injected: { deltaX: 0, deltaY: 57.14 },
      traveledY: 400,
      gearing: 7,
      routes: ["wheel", "wheel"],
    });
    const legs = backend.callsFor("scroll").map((entry) => entry.args[2]);
    expect(legs[0]).toBe(48);
    expect(legs[1]).toBeCloseTo(64 / 7, 6);
    expect(first.observation !== undefined && "screenshot" in first.observation).toBe(true);

    // A measured window is trusted in one delivery: no probe, one injection.
    const second = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });
    expect(second.result.scroll?.injected.deltaY).toBe(57.14);
    expect(second.result.scroll?.traveledY).toBe(400);
    expect(second.result.scroll?.gearing).toBe(7);
    expect(backend.callsFor("scroll")).toHaveLength(3);
    expect(backend.callsFor("scroll").at(-1)?.args[2]).toBeCloseTo(400 / 7, 6);

    await manager.dispose();
  });

  it("falls back to the full request when the probe cannot be measured", async () => {
    const { backend, manager } = calibratedScrollFixture([undefined, undefined]);

    const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });

    // The unmeasured probe deducts only its own request: 48 went out, so the
    // remaining 352 follows at gearing 1, and the client got the 400 it would
    // have gotten without the probe.
    expect(result.result.scroll?.injected).toEqual({ deltaX: 0, deltaY: 400 });
    expect(result.result.scroll?.traveledY).toBeUndefined();
    expect(result.result.scroll?.gearing).toBe(1);
    expect(backend.callsFor("scroll").map((entry) => entry.args[2])).toEqual([48, 352]);

    await manager.dispose();
  });

  it("still identifies the window for an untargeted scroll after the clear", async () => {
    // Preparing an untargeted action clears the pinned focus, and the focus
    // fallback used to be read only afterwards — so a bare delta scroll could
    // never name its window, observed an unreadable workspace downscale, and
    // calibrated nothing. The cursor the thread last drove to fills the gap.
    const { backend, manager } = calibratedScrollFixture([336, 64]);

    await manager.click("thread-1", { x: 1_100, y: 200 });
    const result = await manager.scrollCalibrated("thread-1", null, 0, 400, {
      observe: true,
    });

    // The focus really was cleared; the window came from the cursor position.
    expect(backend.callsFor("clearFocusWindow").length).toBeGreaterThan(0);
    expect(result.result.scroll?.gearing).toBe(7);
    expect(result.result.scroll?.traveledY).toBe(400);
    expect(result.observation !== undefined && "screenshot" in result.observation).toBe(true);

    await manager.dispose();
  });

  it("converts measured travel out of capture pixels before reporting or learning it", async () => {
    // A window wider than the observation budget is captured downscaled, so the
    // correlator's answer is in capture pixels and means less travel than it
    // says. Reporting it unconverted would teach the store a gearing that is
    // really the zoom factor.
    const backend = new FakeComputerBackend({
      windows: [
        {
          id: "fake-browser",
          title: "Browser",
          bounds: { x: 0, y: 0, width: 1_920, height: 1_080 },
          focused: true,
          minimized: false,
          visible: true,
          stackingIndex: 0,
        },
      ],
    });
    const { manager } = calibratedScrollFixture([800], backend);

    // Probe-sized on purpose, so the request goes out in one measured leg.
    const result = await manager.scrollCalibrated("thread-1", { x: 900, y: 500 }, 0, 40, {
      observe: true,
    });

    // 1536/1920 = 0.8, so 800 capture pixels of travel are 1000 logical ones.
    expect(result.result.scroll?.traveledY).toBe(1_000);
    expect(result.result.scroll?.gearing).toBe(25);

    await manager.dispose();
  });

  it("suppresses a wrong-way measurement instead of reporting or learning it", async () => {
    // The live footer-alias case: the correlator locked onto repetitive
    // content and answered with travel opposing the injection. That number
    // must reach neither the caller nor the store.
    const { backend, manager } = calibratedScrollFixture([-752, undefined]);

    const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 100, {
      observe: true,
    });

    expect(result.result.scroll?.traveledY).toBeUndefined();
    expect(result.result.scroll?.gearing).toBe(1);
    expect(backend.callsFor("scroll").map((entry) => entry.args[2])).toEqual([48, 52]);

    await manager.dispose();
  });

  it("reads byte-identical captures as no movement, and learns nothing from it", async () => {
    const backend = new FakeComputerBackend();
    const measurements: number[] = [];
    const manager = new ComputerManager({
      backend,
      actionSettleMs: 0,
      measureScrollTravel: () => measurements.push(0) && undefined,
    });

    // No queued captures: the fake returns the same fixture every time, which is
    // what the end of a page looks like — pixels that did not change did not
    // move, and no correlation is needed to know it.
    const first = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });
    expect(first.result.scroll?.traveledY).toBe(0);
    expect(first.result.scroll?.gearing).toBe(1);
    expect(measurements).toEqual([]);

    const second = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });
    expect(second.result.scroll?.injected).toEqual({ deltaX: 0, deltaY: 400 });
    expect(second.result.scroll?.traveledY).toBe(0);
    // Delivery decides whether the caller can reuse its previous image.
    expect(second.observation).toHaveProperty("screenshot");
    expect(second.observation).toHaveProperty("windowId", "fake-calculator");
    expect(measurements).toEqual([]);

    await manager.dispose();
  });

  it("keeps the correction but takes no captures when the caller wants no observation", async () => {
    const { backend, manager } = calibratedScrollFixture([336, 64]);

    await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });
    // Three on the probing first scroll: before, after the probe, after the rest.
    expect(backend.callsFor("captureScreenshot")).toHaveLength(3);

    const unobserved = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: false,
    });
    expect(backend.callsFor("captureScreenshot")).toHaveLength(3);
    expect(unobserved.observation).toBeUndefined();
    expect(unobserved.result.scroll?.traveledY).toBeUndefined();
    expect(unobserved.result.scroll?.injected.deltaY).toBe(57.14);
    expect(backend.callsFor("scroll").at(-1)?.args[2]).toBeCloseTo(400 / 7, 6);

    await manager.dispose();
  });

  it("never re-gears the pane's own scroll, whatever the agent learned", async () => {
    const { backend, manager } = calibratedScrollFixture([336, 64]);
    await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });
    const capturesAfterLearning = backend.callsFor("captureScreenshot").length;

    // The human is watching the result and closing the loop themselves; a
    // correction applied under their hand would fight them.
    await manager.scroll(undefined, { x: 1_100, y: 200 }, 0, 400);
    expect(backend.callsFor("scroll").at(-1)?.args).toEqual([{ x: 1_100, y: 200 }, 0, 400]);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesAfterLearning);

    await manager.dispose();
  });

  it("delivers the scroll unmeasured when the capture fails", async () => {
    const { backend, manager } = calibratedScrollFixture([336]);
    backend.failNext("captureScreenshot");

    const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: true,
    });

    expect(result.result).toMatchObject({ action: "computer_scroll" });
    expect(result.result.scroll?.traveledY).toBeUndefined();
    expect(result.observation).toBeUndefined();
    expect(backend.callsFor("scroll")).toHaveLength(1);
    // The before-capture failed, so nothing to compare an after-capture against.
    expect(backend.callsFor("captureScreenshot")).toHaveLength(1);

    await manager.dispose();
  });

  describe("the scroll-leg conditional settle", () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });

    /**
     * The scripted-measurement fixture with a nonzero settle, so whether the
     * leg waited is visible on the timer. Screenshots are queued one per
     * capture so byte identity cannot short-circuit the measurement before it
     * runs.
     */
    function settleScrollFixture(
      travels: readonly (number | undefined)[],
      backend = new FakeComputerBackend(),
      screenshotCount = 16,
    ) {
      const queue = [...travels];
      const manager = new ComputerManager({
        backend,
        actionSettleMs: 60,
        measureScrollTravel: () => queue.shift(),
      });
      backend.queueScreenshots(
        Array.from({ length: screenshotCount }, (_unused, index) => `capture-${index}`),
      );
      return { backend, manager };
    }

    const settleWaited = (spy: {
      readonly mock: { readonly calls: readonly (readonly unknown[])[] };
    }) => spy.mock.calls.filter((call) => call[1] === 60).length;

    /**
     * One scroll that teaches the window's gearing the settled way — the flag
     * is off, so the probe and the remainder both wait — after which the route
     * carries a real prediction and further legs can prove arrival early.
     */
    const teachGearing = async (manager: ComputerManager) => {
      await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, { observe: true });
    };

    it("waives the leg settle when measured travel already proves arrival", async () => {
      vi.stubEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const { backend, manager } = settleScrollFixture([336, 64, 400]);
      await teachGearing(manager);
      const capturesBefore = backend.callsFor("captureScreenshot").length;
      const spy = vi.spyOn(globalThis, "setTimeout");

      const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
        observe: true,
      });

      // The measured window is trusted in one delivery: injected 400/7, and the
      // early capture measured the predicted 400 — the pixels are the settle
      // evidence, so the 60 ms wait never ran.
      expect(settleWaited(spy)).toBe(0);
      expect(result.result.scroll?.traveledY).toBe(400);
      expect(result.result.scroll?.gearing).toBe(7);
      expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesBefore + 2);
      expect(result.observation !== undefined && "screenshot" in result.observation).toBe(true);

      await manager.dispose();
    });

    it("keeps the settle when the correlation refuses the early capture", async () => {
      vi.stubEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const { backend, manager } = settleScrollFixture([336, 64, undefined, undefined]);
      await teachGearing(manager);
      const capturesBefore = backend.callsFor("captureScreenshot").length;
      const spy = vi.spyOn(globalThis, "setTimeout");

      const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
        observe: true,
      });

      // A refused measurement is not arrival: the leg pays the settle and
      // re-measures on a settled frame, which also refuses — delivered and
      // unmeasured, exactly the outcome the fixed wait exists for.
      expect(settleWaited(spy)).toBe(1);
      expect(result.result.scroll?.traveledY).toBeUndefined();
      expect(result.result.scroll?.gearing).toBe(7);
      expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesBefore + 3);

      await manager.dispose();
    });

    it("keeps the settle when early travel misses the prediction, and never learns it", async () => {
      vi.stubEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const { backend, manager } = settleScrollFixture([336, 64, 250, 400]);
      await teachGearing(manager);
      const capturesBefore = backend.callsFor("captureScreenshot").length;
      const spy = vi.spyOn(globalThis, "setTimeout");

      const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
        observe: true,
      });

      // 250 against a predicted 400 is a mid-animation frame, not arrival: the
      // leg settles and measures the settled 400. Had the early sample been
      // learned it would have dragged the smoothed gearing toward ~5.7; the
      // reported 7 proves it was dropped.
      expect(settleWaited(spy)).toBe(1);
      expect(result.result.scroll?.traveledY).toBe(400);
      expect(result.result.scroll?.gearing).toBe(7);
      expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesBefore + 3);

      await manager.dispose();
    });

    it("keeps the probe leg's settle — an unmeasured route has no prediction to prove", async () => {
      vi.stubEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      const { backend, manager } = settleScrollFixture([336, 64]);
      const spy = vi.spyOn(globalThis, "setTimeout");

      const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
        observe: true,
      });

      // The probe's own measurement is what establishes the gearing, so its
      // settle is exactly the wait that must not be waived. The remainder it
      // just taught — predicted travel 64 — is the leg that skips.
      expect(settleWaited(spy)).toBe(1);
      expect(result.result.scroll?.traveledY).toBe(400);
      expect(result.result.scroll?.gearing).toBe(7);
      expect(result.result.scroll?.routes).toEqual(["wheel", "wheel"]);
      expect(backend.callsFor("captureScreenshot")).toHaveLength(3);

      await manager.dispose();
    });

    it("keeps every settle and takes no early capture under the kill switch", async () => {
      vi.stubEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "0");
      const { backend, manager } = settleScrollFixture([336, 64, 400]);
      await teachGearing(manager);
      const capturesBefore = backend.callsFor("captureScreenshot").length;
      const spy = vi.spyOn(globalThis, "setTimeout");

      const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
        observe: true,
      });

      // Bit-identical to the pre-flag path: settle, then one capture to
      // measure and observe with — never the speculative early capture.
      expect(settleWaited(spy)).toBe(1);
      expect(result.result.scroll?.traveledY).toBe(400);
      expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesBefore + 2);

      await manager.dispose();
    });

    it("keeps the settle on an unchanged scroll and still reports traveledY 0", async () => {
      vi.stubEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      // Exactly three queued screenshots cover the teaching scroll's captures;
      // everything after returns the one fixture image, which is what the end
      // of a page looks like — byte-identical, so measurement answers 0.
      const { backend, manager } = settleScrollFixture([336, 64], new FakeComputerBackend(), 3);
      await teachGearing(manager);
      const capturesBefore = backend.callsFor("captureScreenshot").length;
      const spy = vi.spyOn(globalThis, "setTimeout");

      const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
        observe: true,
      });

      // Zero measured travel is the edge-of-page signal, not arrival: the leg
      // settles, re-measures the same zero, and reports it — the signal the
      // tool layer's fourth-unchanged refusal feeds on must survive the flag.
      expect(settleWaited(spy)).toBe(1);
      expect(result.result.scroll?.traveledY).toBe(0);
      expect(backend.callsFor("captureScreenshot")).toHaveLength(capturesBefore + 3);

      await manager.dispose();
    });

    it("does not let a waived settle upgrade a dispatched-unknown verdict", async () => {
      vi.stubEnv("SYNARA_CUA_CONDITIONAL_SETTLE", "1");
      class UnknownScrollBackend extends FakeComputerBackend {
        override async scroll(...args: Parameters<FakeComputerBackend["scroll"]>) {
          await super.scroll(...args);
          return {
            deliveryPath: "fake-scroll",
            verified: "unconfirmed" as const,
            effect: "dispatched-unknown" as const,
          };
        }
      }
      const { manager } = settleScrollFixture([336, 64, 400], new UnknownScrollBackend());
      await teachGearing(manager);
      const spy = vi.spyOn(globalThis, "setTimeout");

      const result = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
        observe: true,
      });

      // The measured arrival waives the wait, but the backend's own verdict
      // stands: the observation proving travel is not the driver reporting
      // the delivery verified.
      expect(settleWaited(spy)).toBe(0);
      expect(result.result.scroll?.traveledY).toBe(400);
      expect(result.result.delivery).toEqual({
        path: "fake-scroll",
        verified: "unconfirmed",
        effect: "dispatched-unknown",
      });

      await manager.dispose();
    });
  });
});

it("holds refused input until a scoped observation establishes readiness", async () => {
  class PausedBackend extends FakeComputerBackend {
    ready = false;
    attempts = 0;
    checks = 0;
    override async typeText(text: string) {
      this.attempts += 1;
      if (!this.ready)
        throw new ComputerBackendError("Return to the target window.", {
          inputPause: {
            windowId: "fake-calculator",
            message: "Return to the target window.",
          },
        });
      return super.typeText(text);
    }
    async checkInputReady() {
      this.checks += 1;
      if (!this.ready) throw new Error("still unavailable");
    }
  }
  const backend = new PausedBackend();
  const manager = new ComputerManager({ backend });
  await expect(manager.typeText("thread-a", "hello")).rejects.toHaveProperty("inputPause");
  await expect(manager.typeText("thread-a", "hello")).rejects.toHaveProperty("inputPause");
  expect(backend.attempts).toBe(1);
  expect((await manager.getThreadState("thread-a")).inputPause?.windowId).toBe("fake-calculator");
  await manager.releaseDesktopControl("thread-a");
  expect((await manager.getState({ windowId: "fake-calculator" })).inputPause).toBeDefined();
  expect(backend.checks).toBe(1);
  expect((await manager.getThreadState("thread-a")).inputPause).toBeDefined();
  backend.ready = true;
  await manager.getState({ windowId: "different-window" });
  expect(backend.checks).toBe(1);
  await manager.getState({ windowId: "fake-calculator" });
  expect((await manager.getThreadState("thread-a")).inputPause).toBeUndefined();
  await manager.typeText("thread-a", "hello");
  expect(backend.attempts).toBe(2);
  await manager.dispose();
});

it("clears an app pause only for the observing task and a ready same-pid sibling", async () => {
  const windows = coveredCalculatorWindows().map((window, index) => ({
    ...window,
    pid: index === 0 ? 20 : 10,
  }));
  windows.push({ ...windows[1]!, id: "sibling", onCurrentSpace: true } as (typeof windows)[number]);
  class PausedBackend extends FakeComputerBackend {
    attempts = 0;
    checks = 0;
    override async typeText(text: string) {
      if (++this.attempts === 1)
        throw new ComputerBackendError("Observe the app again", {
          inputPause: { windowId: "fake-calculator", pid: 10, message: "Observe the app again" },
        });
      return super.typeText(text);
    }
    async checkInputReady() {
      this.checks += 1;
    }
  }
  const backend = new PausedBackend({ windows });
  const manager = new ComputerManager({ backend });
  try {
    await expect(manager.typeText("owner", "hello")).rejects.toHaveProperty("inputPause");
    await manager.releaseDesktopControl("owner");
    await withComputerTask({ threadId: "other", turnId: "turn" }, () =>
      manager.getState({ windowId: "sibling" }),
    );
    expect(backend.checks).toBe(0);
    await withComputerTask({ threadId: "owner", turnId: "turn" }, () =>
      manager.getState({ windowId: "fake-browser" }),
    );
    expect(backend.checks).toBe(0);
    expect((await manager.getThreadState("owner")).inputPause).toBeDefined();
    await withComputerTask({ threadId: "owner", turnId: "turn" }, () =>
      manager.getState({ windowId: "sibling" }),
    );
    expect(backend.checks).toBe(1);
    expect((await manager.getThreadState("owner")).inputPause).toBeUndefined();
  } finally {
    await manager.dispose();
  }
});

it("reports a launched app with an unusable window without replaying launch", async () => {
  class LaunchBackend extends FakeComputerBackend {
    launches = 0;
    override async launchApp(app: string) {
      this.launches += 1;
      return { computerId: "desktop", app, pid: 10, window: null };
    }
    async checkInputReady() {
      throw new Error("ax_window_unresolved");
    }
  }
  const backend = new LaunchBackend({
    windows: coveredCalculatorWindows().map((window) => ({
      ...window,
      pid: window.id === "fake-calculator" ? 10 : 20,
    })),
  });
  const manager = new ComputerManager({ backend });
  try {
    expect(await manager.launchApp("owner", "com.apple.Calculator", [], 2_000)).toMatchObject({
      pid: 10,
      window: null,
      windowStatus: "no_usable_window",
      windowReason: "input_unavailable",
    });
    expect(backend.launches).toBe(1);
  } finally {
    await manager.dispose();
  }
});

it("publishes activity without additional desktop reads", async () => {
  const backend = new FakeComputerBackend();
  const manager = new ComputerManager({ backend });
  await manager.listWindows();
  await manager.getThreadState("watched");
  const before = backend.calls.length;
  await manager.withAgentActivity("watched", async () => undefined);
  expect(backend.calls.slice(before)).toEqual([]);
  await manager.dispose();
});

it("evicts idle thread records while preserving increasing versions", async () => {
  const backend = new FakeComputerBackend();
  const manager = new ComputerManager({ backend });
  const first = await manager.getThreadState("old");
  for (let i = 0; i < 260; i += 1) await manager.getThreadState(`idle-${i}`);
  let published = 0;
  manager.onEvent((event) => {
    if (event.type === "computer.thread-state") published += 1;
  });
  await manager.withAgentActivity("old", async () => undefined);
  expect(published).toBe(0);
  expect((await manager.getThreadState("old")).version).toBeGreaterThan(first.version);
  await manager.dispose();
});

it("assigns a newer version to each refreshed thread snapshot", async () => {
  const backend = new FakeComputerBackend();
  const manager = new ComputerManager({ backend });
  const initial = await manager.getThreadState("refreshed");
  backend.setAvailability({ kind: "backend-unavailable", message: "Paused" });
  const refreshed = await manager.getThreadState("refreshed");
  expect(refreshed.availability).toEqual({
    kind: "backend-unavailable",
    message: "Paused",
  });
  expect(refreshed.version).toBeGreaterThan(initial.version);
  await manager.dispose();
});

it("versions a delayed refresh after cached activity publications", async () => {
  const held = deferred();
  const entered = deferred();
  class DelayedBackend extends FakeComputerBackend {
    delay = false;
    override async probeAvailability() {
      if (this.delay) {
        entered.resolve();
        await held.promise;
      }
      return super.probeAvailability();
    }
  }
  const backend = new DelayedBackend();
  const manager = new ComputerManager({ backend });
  await manager.getThreadState("refreshed");
  const events: ThreadComputerState[] = [];
  manager.onEvent((event) => {
    if (event.type === "computer.thread-state") events.push(event.state);
  });
  backend.delay = true;
  backend.setAvailability({ kind: "backend-unavailable", message: "Paused" });
  const refreshing = manager.getThreadState("refreshed");
  await entered.promise;
  await manager.withAgentActivity("refreshed", async () => undefined);
  const cached = events.at(-1)!;
  expect(cached.availability.kind).toBe("available");
  held.resolve();
  const refreshed = await refreshing;
  expect(refreshed.version).toBeGreaterThan(cached.version);
  expect(refreshed.availability.kind).toBe("backend-unavailable");
  expect(events.at(-1)).toEqual(refreshed);
  await manager.dispose();
});

it("pauses calibrated scrolling before any second input or launch and preserves pause during idle eviction", async () => {
  const backend = new FakeComputerBackend();
  const manager = new ComputerManager({ backend });
  const pause = {
    windowId: "fake-calculator",
    message: "Return this window to the current Space.",
  };
  const scroll = backend.scroll.bind(backend);
  let attempts = 0;
  backend.scroll = async (...args: Parameters<typeof scroll>) => {
    attempts += 1;
    if (attempts === 1) throw new ComputerBackendError(pause.message, { inputPause: pause });
    return scroll(...args);
  };
  await expect(
    manager.scrollCalibrated("paused", { windowId: "fake-calculator" }, 0, 40, {
      observe: false,
    }),
  ).rejects.toHaveProperty("inputPause");
  await manager.releaseDesktopControl("paused");
  for (let i = 0; i < 260; i += 1) await manager.getThreadState(`other-${i}`);
  expect((await manager.getThreadState("paused")).inputPause).toEqual(pause);
  await expect(
    manager.scrollCalibrated("paused", null, 0, 40, { observe: false }),
  ).rejects.toHaveProperty("inputPause");
  await expect(manager.launchApp("paused", "Calculator")).rejects.toHaveProperty("inputPause");
  expect(attempts).toBe(1);
  expect(backend.callsFor("launchApp")).toHaveLength(0);
  await manager.dispose();
});

it("refuses detached input after its original operation ends while allowing a fresh admitted call", async () => {
  const backend = new FakeComputerBackend();
  const manager = new ComputerManager({ backend });
  const release = deferred();
  let detached!: Promise<unknown>;
  await manager.withAgentActivity(
    "owner",
    async () => {
      detached = release.promise.then(() => manager.typeText("owner", "stale input"));
    },
    undefined,
    "old-turn",
  );
  const refused = expect(detached).rejects.toThrow("operation has ended");
  release.resolve();
  await refused;
  expect(backend.callsFor("typeText")).toHaveLength(0);
  await manager.withAgentActivity(
    "owner",
    () => manager.typeText("owner", "fresh input"),
    undefined,
    "new-turn",
  );
  expect(backend.callsFor("typeText")).toHaveLength(1);
  await manager.dispose();
});

it("never re-admits a detached tool continuation after revocation and re-enable", async () => {
  const backend = new FakeComputerBackend();
  const manager = new ComputerManager({ backend });
  const release = deferred();
  let detached!: Promise<unknown>;
  await manager.withAgentActivity("owner", async () => {
    detached = release.promise.then(() =>
      manager.withAgentActivity("owner", () => manager.typeText("owner", "stale input")),
    );
  });
  await manager.setControlEnabled("owner", false);
  await manager.setControlEnabled("owner", true);
  const refused = expect(detached).rejects.toThrow("operation has ended");
  release.resolve();
  await refused;
  expect(backend.callsFor("typeText")).toHaveLength(0);
  await manager.dispose();
});

it("settles a pending approval prompt when control is switched off mid-turn", async () => {
  const backend = new FakeComputerBackend();
  const manager = new ComputerManager({ backend });
  try {
    const prompt = computerApprovalGate.request({
      threadId: "owner",
      turnId: "turn-1",
      signal: new AbortController().signal,
      publish: async () => undefined,
    });
    const settled = expect(prompt).resolves.toBe(false);
    await manager.setControlEnabled("owner", false);
    // Without the synchronous cancel, this hangs until the gate's timeout.
    await settled;
    computerApprovalGate.cancelThread("owner");
  } finally {
    await manager.dispose();
  }
});

it("keeps a pause when the thread is re-armed while its readiness probe is in flight", async () => {
  const entered = deferred();
  const gate = deferred();
  class PausedBackend extends FakeComputerBackend {
    ready = false;
    override async typeText(text: string) {
      if (!this.ready)
        throw new ComputerBackendError("Return to the target window.", {
          inputPause: {
            windowId: "fake-calculator",
            message: "Return to the target window.",
          },
        });
      return super.typeText(text);
    }
    async checkInputReady() {
      entered.resolve();
      await gate.promise;
      if (!this.ready) throw new Error("still unavailable");
    }
  }
  const backend = new PausedBackend();
  const manager = new ComputerManager({ backend });
  try {
    await expect(manager.typeText("thread-a", "hello")).rejects.toHaveProperty("inputPause");
    const probing = manager.getState({ windowId: "fake-calculator" });
    await entered.promise;
    // Re-armed to a new generation while the probe is in flight: the window
    // may be ready, but this pause was recorded under the older generation.
    await manager.setControlEnabled("thread-a", false);
    await manager.setControlEnabled("thread-a", true);
    backend.ready = true;
    gate.resolve();
    await probing;
    expect((await manager.getThreadState("thread-a")).inputPause).toBeDefined();
    await expect(manager.typeText("thread-a", "hello")).rejects.toHaveProperty("inputPause");
  } finally {
    await manager.dispose();
  }
});

it("measures a macOS scroll inside the two-leg, three-capture budget", async () => {
  class MacosFake extends FakeComputerBackend {
    override readonly agentDialect = "macos" as const;
  }
  const backend = new MacosFake();
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  try {
    const { result, observation } = await manager.scrollCalibrated(
      "thread-1",
      { x: 1_100, y: 200 },
      0,
      400,
      { observe: true },
    );
    // macOS joins the common loop: probe + corrected remainder = two injects,
    // before + one after per leg = three captures, the last doubling as the
    // caller's observation. The fake's canned captures never change, so the
    // correlator honestly reports zero travel.
    expect(backend.callsFor("scroll")).toHaveLength(2);
    expect(backend.callsFor("captureScreenshot")).toHaveLength(3);
    expect(observation).toBeDefined();
    expect(result.scroll?.traveledY).toBe(0);
    expect(result.scroll?.requested).toEqual({ deltaX: 0, deltaY: 400 });
    expect(result.scroll?.routes).toEqual(["wheel", "wheel"]);
    const unobserved = await manager.scrollCalibrated("thread-1", { x: 1_100, y: 200 }, 0, 400, {
      observe: false,
    });
    expect(unobserved.observation).toBeUndefined();
    expect(backend.callsFor("captureScreenshot")).toHaveLength(3);
  } finally {
    await manager.dispose();
  }
});

function foregroundRestoreActions(manager: ComputerManager): Array<Record<string, unknown>> {
  const actions: Array<Record<string, unknown>> = [];
  manager.onEvent((event) => {
    if (event.type === "computer.action") actions.push({ ...event });
  });
  return actions;
}

function foregroundRaisedIds(backend: FakeComputerBackend): readonly unknown[] {
  return backend.callsFor("raiseWindow").map((call) => call.args[0]);
}

/**
 * The task-text authorization every raise now needs. These suites exercise the
 * raise/restore mechanics themselves; the never-raise gate has its own tests.
 */
const VISIBLE_USE_AUTHORIZED = { userRequestedVisibleUse: true } as const;

describe("ComputerManager foreground containment", () => {
  it.each(["activate", "activate-and-restore", "foreground-input", "menu"])(
    "refuses %s before starting the backend or acquiring the desktop lease",
    async (route) => {
      const backend = new FakeComputerBackend();
      const manager = new ComputerManager({ backend, actionSettleMs: 0 });
      const input = vi.fn(async () => "typed");
      const actions = foregroundRestoreActions(manager);
      try {
        const call =
          route === "activate"
            ? manager.activateWindow("refused-thread", "fake-calculator")
            : route === "activate-and-restore"
              ? manager.foregroundWithRestore("refused-thread", "fake-calculator")
              : route === "menu"
                ? manager.invokeMenu("refused-thread", { windowId: "fake-calculator" }, ["File"])
                : manager.withForegroundRestore("refused-thread", input);
        await expect(call).rejects.toMatchObject({
          code: "foreground_not_requested",
          effect: "not-dispatched",
        });
        // A lease claim itself talks to the native driver. Checking only
        // raiseWindow misses clearFocusWindow, cursor setup and process startup.
        expect(backend.calls).toEqual([]);
        expect(input).not.toHaveBeenCalled();
        expect(actions).toEqual([]);
        // Refusing one thread must not reserve the desktop until its turn ends.
        await expect(manager.click("other-thread", { x: 100, y: 100 })).resolves.toMatchObject({
          action: "computer_click",
        });
      } finally {
        await manager.dispose();
      }
    },
  );

  it("refuses an activate with no task-text authorization, and raises nothing", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const actions = foregroundRestoreActions(manager);
    try {
      const refused = await manager
        .foregroundWithRestore("thread-1", "fake-calculator")
        .catch((error) => error);
      expect(refused).toMatchObject({
        code: "foreground_not_requested",
        effect: "not-dispatched",
      });
      // Nothing raised, nothing aimed, no action event: the refusal is before
      // any dispatch.
      expect(foregroundRaisedIds(backend)).toEqual([]);
      expect(backend.callsFor("focusWindow")).toEqual([]);
      expect(actions).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses an explicit false authorization the same way", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      await expect(
        manager.foregroundWithRestore("thread-1", "fake-calculator", undefined, {
          userRequestedVisibleUse: false,
        }),
      ).rejects.toMatchObject({ code: "foreground_not_requested" });
      expect(foregroundRaisedIds(backend)).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses a foreground call and a plain activate without authorization", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      await expect(
        manager.withForegroundRestore("thread-1", async () => "typed"),
      ).rejects.toMatchObject({ code: "foreground_not_requested" });
      await expect(manager.activateWindow("thread-1", "fake-calculator")).rejects.toMatchObject({
        code: "foreground_not_requested",
      });
      expect(foregroundRaisedIds(backend)).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses the raise while the user was just interacting through the pane, then allows it after quiet", async () => {
    const backend = new FakeComputerBackend();
    let clock = 1_000_000;
    const manager = new ComputerManager({
      backend,
      actionSettleMs: 0,
      now: () => clock,
    });
    try {
      // The human drives the desktop through the pane: no owning thread.
      await manager.click(undefined, { x: 100, y: 100 });
      const refused = await manager
        .foregroundWithRestore("thread-1", "fake-calculator", undefined, VISIBLE_USE_AUTHORIZED)
        .catch((error) => error);
      expect(refused).toMatchObject({
        code: "foreground_user_interaction",
        effect: "not-dispatched",
      });
      expect(foregroundRaisedIds(backend)).toEqual([]);
      // Quiet for the guard window: the same authorized raise now runs.
      clock += 2_001;
      const result = await manager.foregroundWithRestore(
        "thread-1",
        "fake-calculator",
        undefined,
        VISIBLE_USE_AUTHORIZED,
      );
      expect(result.windowId).toBe("fake-calculator");
      expect(foregroundRaisedIds(backend)).toEqual(["fake-calculator", "fake-terminal"]);
    } finally {
      await manager.dispose();
    }
  });

  it("does not let a pane raise be blocked by the pane's own interaction stamp", async () => {
    // Pane input belongs to the human: the guard protects them from the agent,
    // never from themselves.
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      await manager.click(undefined, { x: 100, y: 100 });
      await expect(manager.activateWindow(undefined, "fake-calculator")).resolves.toMatchObject({
        windowId: "fake-calculator",
      });
      expect(foregroundRaisedIds(backend)).toEqual(["fake-calculator"]);
    } finally {
      await manager.dispose();
    }
  });
});

describe("ComputerManager foregroundWithRestore", () => {
  it("restores the previously frontmost window after raising the target", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const actions = foregroundRestoreActions(manager);
    try {
      // The default fake listing is topmost-first: fake-terminal is frontmost.
      const result = await manager.foregroundWithRestore(
        "thread-1",
        "fake-calculator",
        undefined,
        VISIBLE_USE_AUTHORIZED,
      );
      expect(result.windowId).toBe("fake-calculator");
      expect(result.note).toBeUndefined();
      expect(foregroundRaisedIds(backend)).toEqual(["fake-calculator", "fake-terminal"]);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        action: "computer_activate_window",
        windowId: "fake-calculator",
        restoredWindowId: "fake-terminal",
        restoreStatus: "restored",
      });
      expect(actions[0]).not.toHaveProperty("message");
    } finally {
      await manager.dispose();
    }
  });

  it("counts one foreground excursion on the call timing record", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const timing = new ComputerCallTiming(() => 0);
    const lines: string[] = [];
    const info = console.info;
    console.info = (message: unknown) => {
      lines.push(String(message));
    };
    try {
      await withComputerCallContext(new ComputerCallContext({ timing }), () =>
        manager.foregroundWithRestore(
          "thread-1",
          "fake-calculator",
          undefined,
          VISIBLE_USE_AUTHORIZED,
        ),
      );
      timing.finish();
      expect(lines.join("\n")).toContain("foreground_excursion=1");
    } finally {
      console.info = info;
      await manager.dispose();
    }
  });

  it("reports a missed restore as success with a note naming the unrestored window", async () => {
    const backend = new FakeComputerBackend();
    const raise = backend.raiseWindow.bind(backend);
    const attempts: string[] = [];
    backend.raiseWindow = async (windowId: string) => {
      attempts.push(windowId);
      if (windowId === "fake-terminal") throw new ComputerBackendError("The window closed.");
      return raise(windowId);
    };
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const actions = foregroundRestoreActions(manager);
    try {
      const result = await manager.foregroundWithRestore(
        "thread-1",
        "fake-calculator",
        undefined,
        VISIBLE_USE_AUTHORIZED,
      );
      // The activation itself succeeded; only the restore missed — never silent.
      expect(result.windowId).toBe("fake-calculator");
      expect(result.note).toEqual(expect.stringContaining("fake-terminal"));
      // The throwing restore attempt is not in the backend's own call log, so
      // the attempts are tracked here: the restore was tried, then missed.
      expect(attempts).toEqual(["fake-calculator", "fake-terminal"]);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        restoreStatus: "restore-missed",
        restoredWindowId: "fake-terminal",
        message: expect.stringContaining("fake-terminal"),
      });
    } finally {
      await manager.dispose();
    }
  });

  it("runs the approved input between raise and restore without a second approval", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const request = vi.spyOn(computerApprovalGate, "request").mockResolvedValue(true);
    const order: string[] = [];
    const raise = backend.raiseWindow.bind(backend);
    backend.raiseWindow = async (windowId: string) => {
      order.push(`raise:${windowId}`);
      return raise(windowId);
    };
    try {
      await manager.foregroundWithRestore(
        "thread-1",
        "fake-calculator",
        async () => {
          order.push("input");
        },
        VISIBLE_USE_AUTHORIZED,
      );
      expect(order).toEqual(["raise:fake-calculator", "input", "raise:fake-terminal"]);
      // The activate approval covers the whole excursion, restore included.
      expect(request).not.toHaveBeenCalled();
    } finally {
      request.mockRestore();
      computerApprovalGate.cancelThread("thread-1");
      await manager.dispose();
    }
  });

  it("still restores when the approved input fails, then reports the input failure", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const actions = foregroundRestoreActions(manager);
    try {
      await expect(
        manager.foregroundWithRestore(
          "thread-1",
          "fake-calculator",
          async () => {
            throw new Error("input blew up");
          },
          VISIBLE_USE_AUTHORIZED,
        ),
      ).rejects.toThrow("input blew up");
      // The desktop is put back even though the input failed — and a failed
      // action emits no computer.action event, as on every other path.
      expect(foregroundRaisedIds(backend)).toEqual(["fake-calculator", "fake-terminal"]);
      expect(actions).toHaveLength(0);
    } finally {
      await manager.dispose();
    }
  });

  it("skips the restore when the target is already frontmost", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const actions = foregroundRestoreActions(manager);
    try {
      const result = await manager.foregroundWithRestore(
        "thread-1",
        "fake-terminal",
        undefined,
        VISIBLE_USE_AUTHORIZED,
      );
      expect(result.windowId).toBe("fake-terminal");
      expect(result.note).toBeUndefined();
      expect(foregroundRaisedIds(backend)).toEqual(["fake-terminal"]);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({ restoreStatus: "already-frontmost" });
      expect(actions[0]).not.toHaveProperty("restoredWindowId");
    } finally {
      await manager.dispose();
    }
  });

  it("notes when no frontmost window was observable, and restores nothing", async () => {
    const hidden: readonly ComputerWindow[] = [
      {
        id: "hidden-terminal",
        title: "Terminal",
        appName: "org.kde.konsole",
        bounds: { x: 40, y: 40, width: 960, height: 720 },
        focused: false,
        minimized: true,
        visible: false,
      },
      {
        id: "hidden-calculator",
        title: "Calculator",
        appName: "org.kde.kcalc",
        bounds: { x: 1_050, y: 120, width: 420, height: 620 },
        focused: false,
        minimized: true,
        visible: false,
      },
    ];
    const backend = new FakeComputerBackend({ windows: hidden });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const actions = foregroundRestoreActions(manager);
    try {
      const result = await manager.foregroundWithRestore(
        "thread-1",
        "hidden-calculator",
        undefined,
        VISIBLE_USE_AUTHORIZED,
      );
      expect(result.windowId).toBe("hidden-calculator");
      expect(result.note).toEqual(expect.stringContaining("nothing was restored"));
      expect(foregroundRaisedIds(backend)).toEqual(["hidden-calculator"]);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        restoreStatus: "frontmost-unobservable",
      });
      expect(actions[0]).not.toHaveProperty("restoredWindowId");
    } finally {
      await manager.dispose();
    }
  });
});

describe("ComputerManager withForegroundRestore", () => {
  const terminalFirst: readonly ComputerWindow[] = [
    {
      id: "fake-terminal",
      title: "Terminal",
      appName: "org.kde.konsole",
      bounds: { x: 40, y: 40, width: 960, height: 720 },
      focused: true,
      minimized: false,
      visible: true,
    },
    {
      id: "fake-calculator",
      title: "Calculator",
      appName: "org.kde.kcalc",
      bounds: { x: 1050, y: 120, width: 420, height: 620 },
      focused: false,
      minimized: false,
      visible: true,
    },
  ];
  const calculatorFirst: readonly ComputerWindow[] = [terminalFirst[1]!, terminalFirst[0]!];

  function scriptedListing(
    backend: FakeComputerBackend,
    listing: { current: readonly ComputerWindow[] },
  ): void {
    backend.listWindows = async () => listing.current;
  }

  it("puts the user's window back after a foreground call moves focus", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const listing = { current: terminalFirst };
    scriptedListing(backend, listing);
    try {
      const result = await manager.withForegroundRestore(
        "thread-1",
        async () => {
          // The foreground call raises its target past the user's window.
          listing.current = calculatorFirst;
          return "typed";
        },
        VISIBLE_USE_AUTHORIZED,
      );
      expect(result).toBe("typed");
      expect(foregroundRaisedIds(backend)).toEqual(["fake-terminal"]);
      expect(backend.callsFor("focusWindow").map((call) => call.args[0])).toEqual([
        "fake-terminal",
      ]);
    } finally {
      await manager.dispose();
    }
  });

  it("skips the raise when the foreground call never moved focus", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const listing = { current: terminalFirst };
    scriptedListing(backend, listing);
    try {
      await manager.withForegroundRestore("thread-1", async () => "typed", VISIBLE_USE_AUTHORIZED);
      expect(foregroundRaisedIds(backend)).toEqual([]);
      expect(backend.callsFor("focusWindow")).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("still restores when the wrapped call fails, then reports the failure", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const listing = { current: terminalFirst };
    scriptedListing(backend, listing);
    try {
      await expect(
        manager.withForegroundRestore(
          "thread-1",
          async () => {
            listing.current = calculatorFirst;
            throw new Error("input blew up");
          },
          VISIBLE_USE_AUTHORIZED,
        ),
      ).rejects.toThrow("input blew up");
      expect(foregroundRaisedIds(backend)).toEqual(["fake-terminal"]);
    } finally {
      await manager.dispose();
    }
  });

  it("restores nothing when no frontmost window was observable", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const listing = { current: [] as readonly ComputerWindow[] };
    scriptedListing(backend, listing);
    try {
      await manager.withForegroundRestore("thread-1", async () => "typed", VISIBLE_USE_AUTHORIZED);
      expect(foregroundRaisedIds(backend)).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("warns when the post-call read fails and the restore cannot run blind", async () => {
    const backend = new FakeComputerBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let actionDone = false;
    backend.listWindows = async () => {
      if (!actionDone) return terminalFirst;
      throw new Error("listing wedged");
    };
    try {
      await manager.withForegroundRestore(
        "thread-1",
        async () => {
          actionDone = true;
          return "typed";
        },
        VISIBLE_USE_AUTHORIZED,
      );
      // Whether the excursion stole the frontmost is unknown — that is the
      // warn, not silence.
      expect(warn).toHaveBeenCalledWith("[computer] foreground call left focus unverified", {
        previousWindowId: "fake-terminal",
      });
      expect(foregroundRaisedIds(backend)).toEqual([]);
    } finally {
      warn.mockRestore();
      await manager.dispose();
    }
  });
});

describe("ComputerManager masked activation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The canary's two flags, both required before any shield may arm. */
  function armMaskedActivation(apps = "org.kde.kcalc"): void {
    vi.stubEnv("SYNARA_CUA_MASKED_ACTIVATION", "1");
    vi.stubEnv("SYNARA_CUA_MASKED_APPS", apps);
  }

  /** A macOS-dialect fake with the shield surface present — the CUA shape. */
  function shieldedMacBackend(
    options: ConstructorParameters<typeof FakeComputerBackend>[0] = {},
  ): FakeComputerBackend {
    return new FakeComputerBackend({ agentDialect: "macos", shield: true, ...options });
  }

  /** The engage→raise→restore→release order, as one recorded method list. */
  function shieldExcursionOrder(backend: FakeComputerBackend): readonly string[] {
    return backend.calls
      .filter((call) => ["engageShield", "raiseWindow", "releaseShield"].includes(call.method))
      .map((call) =>
        call.method === "raiseWindow" ? `${call.method}:${String(call.args[0])}` : call.method,
      );
  }

  it("shields the opted-in window's raise and releases the mask after the restore", async () => {
    armMaskedActivation();
    const backend = shieldedMacBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const actions = foregroundRestoreActions(manager);
    try {
      const result = await manager.foregroundWithRestore(
        "thread-1",
        "fake-calculator",
        undefined,
        VISIBLE_USE_AUTHORIZED,
      );
      expect(result.windowId).toBe("fake-calculator");
      // The mask goes up before the target moves and comes down only after
      // the previous window is back — the excursion is never visible.
      expect(shieldExcursionOrder(backend)).toEqual([
        "engageShield",
        "raiseWindow:fake-calculator",
        "raiseWindow:fake-terminal",
        "releaseShield",
      ]);
      const engage = backend.callsFor("engageShield")[0]!;
      expect(engage.args[0]).toMatchObject({
        windowId: "fake-calculator",
        frame: { x: 1_050, y: 120, width: 420, height: 620 },
        label: "Synara is activating Calculator",
      });
      const shieldId = (engage.args[0] as { shieldId: string }).shieldId;
      expect(shieldId).toMatch(/^shield-[0-9a-f]{8}$/);
      // The manager minted the id, so release names the same one.
      expect(backend.callsFor("releaseShield").map((call) => call.args[0])).toEqual([shieldId]);
      expect(backend.activeShields()).toEqual([]);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        action: "computer_activate_window",
        masked: true,
        restoreStatus: "restored",
      });
    } finally {
      await manager.dispose();
    }
  });

  it("masks nothing while the canary flag is unset, even with a shield surface", async () => {
    const backend = shieldedMacBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    const actions = foregroundRestoreActions(manager);
    try {
      await manager.foregroundWithRestore(
        "thread-1",
        "fake-calculator",
        undefined,
        VISIBLE_USE_AUTHORIZED,
      );
      expect(backend.callsFor("engageShield")).toEqual([]);
      expect(actions[0]).not.toHaveProperty("masked");
    } finally {
      await manager.dispose();
    }
  });

  it("masks nothing when the opt-in list names a different app", async () => {
    armMaskedActivation("com.example.other");
    const backend = shieldedMacBackend();
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      await manager.foregroundWithRestore(
        "thread-1",
        "fake-calculator",
        undefined,
        VISIBLE_USE_AUTHORIZED,
      );
      expect(backend.callsFor("engageShield")).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("masks nothing on a non-macOS dialect even when armed and opted in", async () => {
    armMaskedActivation();
    // The default fake reports no dialect, which the manager reads as linux.
    const backend = new FakeComputerBackend({ shield: true });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      await manager.foregroundWithRestore(
        "thread-1",
        "fake-calculator",
        undefined,
        VISIBLE_USE_AUTHORIZED,
      );
      expect(backend.callsFor("engageShield")).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("resolves the opt-in through the owning app's bundle id, not the window title", async () => {
    armMaskedActivation("org.kde.kcalc");
    const windows: readonly ComputerWindow[] = [
      {
        id: "fake-terminal",
        title: "Terminal",
        appName: "Terminal",
        pid: 1_001,
        bounds: { x: 40, y: 40, width: 960, height: 720 },
        focused: true,
        minimized: false,
        visible: true,
      },
      {
        id: "fake-calculator",
        title: "Calculator",
        // A display name, not the bundle id the opt-in list carries.
        appName: "Calculator",
        pid: 1_002,
        bounds: { x: 1_050, y: 120, width: 420, height: 620 },
        focused: false,
        minimized: false,
        visible: true,
      },
    ];
    const backend = shieldedMacBackend({
      windows,
      apps: [
        {
          pid: 1_001,
          name: "Terminal",
          bundleId: "org.kde.konsole",
          running: true,
          active: true,
          windowCount: 1,
        },
        {
          pid: 1_002,
          name: "Calculator",
          bundleId: "org.kde.kcalc",
          running: true,
          active: false,
          windowCount: 1,
        },
      ],
    });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      await manager.foregroundWithRestore(
        "thread-1",
        "fake-calculator",
        undefined,
        VISIBLE_USE_AUTHORIZED,
      );
      expect(backend.callsFor("engageShield")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses the activation when the opt-in is armed but no shield surface exists", async () => {
    armMaskedActivation();
    // A macOS backend whose host build lacks the shield command: the armed
    // opt-in must fail closed rather than degrade to a visible raise.
    const backend = new FakeComputerBackend({ agentDialect: "macos" });
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      await expect(
        manager.foregroundWithRestore(
          "thread-1",
          "fake-calculator",
          undefined,
          VISIBLE_USE_AUTHORIZED,
        ),
      ).rejects.toThrow("activation shield is unavailable");
      expect(foregroundRaisedIds(backend)).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("refuses the activation when the shield cannot engage, and releases the minted id", async () => {
    armMaskedActivation();
    const backend = shieldedMacBackend();
    backend.failNext("engageShield", new ComputerBackendError("mask_unavailable"));
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      // A typed backend refusal surfaces as-is; only an untyped failure is
      // wrapped in the "could not be shown" message.
      await expect(
        manager.foregroundWithRestore(
          "thread-1",
          "fake-calculator",
          undefined,
          VISIBLE_USE_AUTHORIZED,
        ),
      ).rejects.toThrow("mask_unavailable");
      // A lost engage reply can still leave a shield up: the minted id is
      // released before the refusal is reported, and no raise ever ran.
      const engages = backend.callsFor("engageShield");
      const releases = backend.callsFor("releaseShield");
      expect(engages).toHaveLength(1);
      expect(releases.map((call) => call.args[0])).toEqual([
        (engages[0]!.args[0] as { shieldId: string }).shieldId,
      ]);
      expect(foregroundRaisedIds(backend)).toEqual([]);
      expect(backend.activeShields()).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("drops the shield when the masked excursion itself fails", async () => {
    armMaskedActivation();
    const backend = shieldedMacBackend();
    backend.raiseWindow = async () => {
      throw new ComputerBackendError("The window closed.");
    };
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      await expect(
        manager.foregroundWithRestore(
          "thread-1",
          "fake-calculator",
          undefined,
          VISIBLE_USE_AUTHORIZED,
        ),
      ).rejects.toThrow("window closed");
      // The raise failed under an up mask: the finally path still released
      // it — a shield outlives nothing, not even a dead excursion.
      expect(backend.callsFor("releaseShield")).toHaveLength(1);
      expect(backend.activeShields()).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });
});

it("an action resolving after thread removal does not resurrect the thread's state", async () => {
  const pending = deferred();
  const backend = Object.assign(new FakeComputerBackend(), {
    launchApp: vi.fn(async () => {
      await pending.promise;
      return { computerId: "desktop", app: "kcalc", window: null };
    }),
  });
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  const events: ComputerEvent[] = [];
  manager.onEvent((event) => events.push(event));

  const launching = manager.launchApp("removed-thread", "kcalc").catch(() => undefined);
  await vi.waitFor(() => expect(backend.launchApp).toHaveBeenCalled());
  const removing = manager.handleThreadRemoved("removed-thread");
  pending.resolve();
  await Promise.allSettled([launching, removing]);

  // The launch's emitAction fired after removal: the tombstone must keep it
  // from opening a pane or recreating the record the removal deleted.
  expect(events.some((event) => event.type === "computer.open-pane-requested")).toBe(false);
  const statesBefore = events.filter((event) => event.type === "computer.thread-state").length;
  const state = await manager.getThreadState("removed-thread");
  expect(state.agentActive).toBe(false);
  expect(events.filter((event) => event.type === "computer.thread-state")).toHaveLength(
    statesBefore,
  );
  await manager.dispose();
});

it("publishes a reported thread error exactly once, then lets refresh own the field", async () => {
  const backend = new FakeComputerBackend();
  const manager = new ComputerManager({ backend });
  const states: ThreadComputerState[] = [];
  manager.onEvent((event) => {
    if (event.type === "computer.thread-state" && event.state.threadId === "err-thread")
      states.push(event.state);
  });
  await manager.getThreadState("err-thread");
  await manager.recordThreadError("err-thread", "backend hiccup");
  // The report lands in exactly one published snapshot...
  expect(states.filter((state) => state.lastError === "backend hiccup")).toHaveLength(1);
  // ...and the next publish reports the physical read, not a stale echo.
  await manager.getThreadState("err-thread");
  expect(states.at(-1)?.lastError).toBeNull();
  expect(states.filter((state) => state.lastError === "backend hiccup")).toHaveLength(1);
  await manager.dispose();
});

it("a pause arriving after control was revoked leaves no stale pause state", async () => {
  const pending = deferred();
  const backend = Object.assign(new FakeComputerBackend(), {
    typeText: vi.fn(async (_text: string) => {
      await pending.promise;
      throw new ComputerBackendError("Return to the target window.", {
        inputPause: { windowId: "fake-calculator", message: "Return to the target window." },
      });
    }),
  });
  const manager = new ComputerManager({ backend });
  const typing = manager.typeText("paused-thread", "hi").catch((error: unknown) => error);
  await vi.waitFor(() => expect(backend.typeText).toHaveBeenCalled());
  // The disable latches synchronously; the stop it queues drains once the
  // in-flight call settles, so the pause lands after the latch.
  const disabling = manager.setControlEnabled("paused-thread", false);
  pending.resolve();
  await disabling;
  await typing;
  // The pause landed after the revocation — recording it would tell the
  // panel a disabled thread is waiting on a window it cannot act on.
  expect((await manager.getThreadState("paused-thread")).inputPause).toBeUndefined();
  await manager.dispose();
});

it("thread removal completes on a wedged stop — the teardown wait is bounded", async () => {
  const backend = Object.assign(new FakeComputerBackend(), {
    stopInput: vi.fn(() => new Promise<void>(() => {})),
  });
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  await manager.launchApp("wedged", "kcalc");
  vi.useFakeTimers();
  try {
    const removing = manager.handleThreadRemoved("wedged");
    // The host never answers stopInput: only the teardown bound lets the
    // removal finish — the tombstone and deletions are already held.
    await vi.advanceTimersByTimeAsync(COMPUTER_CONTROL_ENABLE_TIMEOUT_MS + 1_000);
    await removing;
    expect(backend.stopInput).toHaveBeenCalled();
    const disposing = manager.dispose();
    await vi.advanceTimersByTimeAsync(COMPUTER_CONTROL_ENABLE_TIMEOUT_MS * 2 + 2_000);
    await disposing;
  } finally {
    vi.useRealTimers();
  }
});

/** A backend method that parks until released, reporting when it was entered. */
function gate() {
  const released = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  return {
    release: () => released.resolve(),
    released: released.promise,
    entered: () => reached.resolve(),
    reached: reached.promise,
  };
}

/** Long enough for any queued continuation to have run. */
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 10));

/** A backend that serves pane input alongside an agent's observation. */
function concurrentObservation<B extends FakeComputerBackend>(backend: B): B {
  return Object.assign(backend, { concurrentObservationInput: true });
}

describe("pane input during an agent tool call", () => {
  it.each([
    ["Linux dialect", () => concurrentObservation(new FakeComputerBackend())],
    ["macOS dialect", () => concurrentObservation(backgroundTargetBackend())],
  ] as const)(
    "answers the pane while the agent reads state, not after (%s)",
    async (_name, makeBackend) => {
      const backend = makeBackend();
      const reading = gate();
      const getState = backend.getState.bind(backend);
      backend.getState = async (options) => {
        reading.entered();
        await reading.released;
        return getState(options);
      };
      const manager = new ComputerManager({ backend, actionSettleMs: 0 });
      try {
        const windows = await backend.listWindows();
        const target = windows[0]!.bounds!;
        const point = { x: target.x + 10, y: target.y + 10 };
        const agent = withComputerTask({ threadId: "thread-1" }, () =>
          manager.withAgentActivity("thread-1", () => manager.getState({ includeTree: true })),
        );
        await reading.reached;
        const clicked = await Promise.race([
          manager
            .withUserPointTarget(point, (userTarget) => manager.click(undefined, userTarget))
            .then(() => "clicked"),
          turn().then(() => "still waiting"),
        ]);
        // The tree walk is still running; the human's click did not wait for it.
        expect(clicked).toBe("clicked");
        expect(backend.callsFor("click")).toHaveLength(1);
        reading.release();
        await agent;
      } finally {
        reading.release();
        await manager.dispose();
      }
    },
  );

  it("never lands pane input inside the agent's input", async () => {
    const backend = concurrentObservation(new FakeComputerBackend());
    const pressing = gate();
    const events: string[] = [];
    const pressKey = backend.pressKey.bind(backend);
    backend.pressKey = async (key, ...rest) => {
      events.push(`press ${key}`);
      if (key === "a") {
        pressing.entered();
        await pressing.released;
      }
      const result = await pressKey(key, ...rest);
      events.push(`released ${key}`);
      return result;
    };
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      const agent = withComputerTask({ threadId: "thread-1" }, () =>
        manager.withAgentActivity("thread-1", () => manager.pressKey("thread-1", "a")),
      );
      await pressing.reached;
      const pane = manager.pressKey(undefined, "b");
      await turn();
      expect(events).toEqual(["press a"]);
      pressing.release();
      await Promise.all([agent, pane]);
      expect(events).toEqual(["press a", "released a", "press b", "released b"]);
    } finally {
      pressing.release();
      await manager.dispose();
    }
  });

  it("resumes the agent's input only after the pane's input in flight", async () => {
    const backend = concurrentObservation(new FakeComputerBackend());
    const reading = gate();
    const paneTyping = gate();
    const events: string[] = [];
    const getState = backend.getState.bind(backend);
    backend.getState = async (options) => {
      reading.entered();
      await reading.released;
      events.push("agent observed");
      return getState(options);
    };
    const typeText = backend.typeText.bind(backend);
    backend.typeText = async (text, ...rest) => {
      events.push(`type ${text}`);
      if (text === "human") {
        paneTyping.entered();
        await paneTyping.released;
      }
      const result = await typeText(text, ...rest);
      events.push(`typed ${text}`);
      return result;
    };
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      const agent = withComputerTask({ threadId: "thread-1" }, () =>
        manager.withAgentActivity("thread-1", async () => {
          await manager.getState({ includeTree: true });
          await manager.typeText("thread-1", "agent");
        }),
      );
      await reading.reached;
      const pane = manager.typeText(undefined, "human");
      await expect(
        Promise.race([
          paneTyping.reached.then(() => "pane typing"),
          turn().then(() => "pane queued behind the observation"),
        ]),
      ).resolves.toBe("pane typing");
      reading.release();
      await turn();
      // The agent finished looking, but its next input waits for the human's.
      expect(events).toEqual(["type human", "agent observed"]);
      paneTyping.release();
      await Promise.all([agent, pane]);
      expect(events).toEqual([
        "type human",
        "agent observed",
        "typed human",
        "type agent",
        "typed agent",
      ]);
    } finally {
      reading.release();
      paneTyping.release();
      await manager.dispose();
    }
  });

  it("keeps a foreground excursion's observation exclusive", async () => {
    const backend = concurrentObservation(backgroundTargetBackend());
    const reading = gate();
    const events: string[] = [];
    const getState = backend.getState.bind(backend);
    backend.getState = async (options) => {
      reading.entered();
      await reading.released;
      events.push("agent observed");
      return getState(options);
    };
    const pressKey = backend.pressKey.bind(backend);
    backend.pressKey = async (...args) => {
      events.push("pane key");
      return pressKey(...args);
    };
    const manager = new ComputerManager({ backend, actionSettleMs: 0 });
    try {
      const agent = withComputerTask({ threadId: "thread-1" }, () =>
        manager.withAgentActivity("thread-1", () =>
          withDesktopDeliveryMode("foreground", () => manager.getState({ includeTree: true })),
        ),
      );
      await reading.reached;
      const pane = manager.pressKey(undefined, "a");
      await turn();
      expect(events).toEqual([]);
      reading.release();
      await Promise.all([agent, pane]);
      expect(events).toEqual(["agent observed", "pane key"]);
    } finally {
      reading.release();
      await manager.dispose();
    }
  });
  it.each([
    ["pointer", "click"],
    ["key", "pressKey"],
  ] as const)(
    "keeps %s pane input behind the agent's whole call on a backend that has not opted in (the Cua host)",
    async (_name, method) => {
      // The Cua backend leaves `concurrentObservationInput` unset: its host
      // serves one request at a time, so pane input waits as it always did.
      const backend = backgroundTargetBackend();
      expect("concurrentObservationInput" in backend).toBe(false);
      const reading = gate();
      const events: string[] = [];
      const getState = backend.getState.bind(backend);
      backend.getState = async (options) => {
        reading.entered();
        await reading.released;
        events.push("agent observed");
        return getState(options);
      };
      const manager = new ComputerManager({ backend, actionSettleMs: 0 });
      try {
        const windows = await backend.listWindows();
        const target = windows[0]!.bounds!;
        const point = { x: target.x + 10, y: target.y + 10 };
        const agent = withComputerTask({ threadId: "thread-1" }, () =>
          manager.withAgentActivity("thread-1", async () => {
            await manager.getState({ includeTree: true });
            await manager.observeFor(1);
            events.push("agent call done");
          }),
        );
        await reading.reached;
        const pane = (
          method === "click"
            ? manager.withUserPointTarget(point, (userTarget) =>
                manager.click(undefined, userTarget),
              )
            : manager.pressKey(undefined, "a")
        ).then(() => {
          events.push("pane input");
        });
        await turn();
        expect(events).toEqual([]);
        expect(backend.callsFor(method)).toHaveLength(0);
        reading.release();
        await Promise.all([agent, pane]);
        expect(events).toEqual(["agent observed", "agent call done", "pane input"]);
      } finally {
        reading.release();
        await manager.dispose();
      }
    },
  );
});
