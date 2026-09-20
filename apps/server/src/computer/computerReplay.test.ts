import { describe, expect, it } from "vitest";

import type { ComputerWindow } from "@synara/contracts";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import {
  sha256Hex,
  type ComputerRecordedResolution,
  type ComputerRecordingDocument,
  type ComputerRecordingEnvironment,
  type ComputerRecordingStep,
} from "./computerRecording.ts";
import { classifyComputerReplay } from "./computerReplay.ts";

const THREAD = "thread-replay";

function windows(): ComputerWindow[] {
  return [
    {
      id: "win-terminal",
      title: "Terminal",
      appName: "org.test.terminal",
      pid: 1_001,
      bounds: { x: 40, y: 40, width: 960, height: 720 },
      focused: true,
      minimized: false,
      visible: true,
    },
    {
      id: "win-calculator",
      title: "Calculator",
      appName: "org.test.calc",
      pid: 1_002,
      bounds: { x: 1_050, y: 120, width: 420, height: 620 },
      focused: false,
      minimized: false,
      visible: true,
    },
  ];
}

function recordedEnvironment(overrides: Partial<ComputerRecordingEnvironment> = {}) {
  const environment: ComputerRecordingEnvironment = {
    platform: "linux",
    osRelease: "6.1.0",
    backend: "fake",
    dialect: "linux",
    computerId: "desktop",
    displayHash: sha256Hex("1920x1080@1"),
    apps: [],
    ...overrides,
  };
  return environment;
}

function step(overrides: Partial<ComputerRecordingStep> = {}): ComputerRecordingStep {
  return {
    kind: "step",
    seq: 1,
    ts: "2026-01-01T00:00:00.000Z",
    tool: "computer_click",
    actionClass: "pointer",
    threadId: THREAD,
    approval: { required: true, decision: "granted" },
    resolutions: [],
    args: {},
    dispatches: [],
    effect: "dispatched-unknown",
    latencyMs: 3,
    ...overrides,
  };
}

function document(
  steps: readonly ComputerRecordingStep[],
  environment: ComputerRecordingEnvironment = recordedEnvironment(),
): ComputerRecordingDocument {
  return {
    header: {
      kind: "header",
      formatVersion: 1,
      recordingId: "crec-test",
      threadId: THREAD,
      startedAt: "2026-01-01T00:00:00.000Z",
      fidelity: "full",
      environment,
    },
    steps: steps.map((entry, index) => ({ ...entry, seq: index + 1 })),
    end: { kind: "end", ts: "2026-01-01T00:01:00.000Z", reason: "stopped", steps: steps.length },
  };
}

function coordinateResolution(windowId: string, app: string): ComputerRecordedResolution {
  const window = windows().find((candidate) => candidate.id === windowId);
  return {
    via: "coordinate",
    windowId,
    app,
    point: { x: 100, y: 100 },
    ...(window?.bounds !== undefined ? { windowBounds: window.bounds } : {}),
  };
}

/** Backend calls that dispatched input — the fresh-state reads replay does up front are not among them. */
function dispatchCalls(backend: FakeComputerBackend) {
  const reads = new Set([
    "listWindows",
    "listApps",
    "getState",
    "availability",
    "probeAvailability",
    "health",
    "capabilities",
    "getScreenSize",
    "screenshot",
    "captureRegion",
    "readClipboard",
    "checkInputReady",
  ]);
  return backend.calls.filter((call) => !reads.has(call.method));
}

async function replayWith(backend: FakeComputerBackend) {
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  return {
    backend,
    manager,
    run: (
      doc: ComputerRecordingDocument,
      options: Partial<Parameters<typeof classifyComputerReplay>[3]> = {},
    ) =>
      classifyComputerReplay(manager, doc, recordedEnvironment(), {
        threadId: THREAD,
        // These suites exercise replay mechanics; the never-raise gate has its
        // own test below and the live tool computes this from task text.
        foregroundAuthorization: { userRequestedVisibleUse: true },
        ...options,
      }),
  };
}

describe("classifyComputerReplay", () => {
  it("a dry run classifies every step and dispatches nothing", async () => {
    const { backend, manager, run } = await replayWith(
      new FakeComputerBackend({ windows: windows() }),
    );
    const doc = document([
      step({
        tool: "computer_click",
        resolutions: [coordinateResolution("win-terminal", "org.test.terminal")],
      }),
      step({ tool: "computer_get_state", actionClass: "observation" }),
      step({ tool: "computer_run", actionClass: "batch" }),
    ]);
    const report = await run(doc);
    expect(report.executed).toBe(false);
    expect(report.steps[0]?.verdict).toBe("ready");
    expect(report.steps[1]?.verdict).toBe("skipped");
    expect(report.steps[2]?.verdict).toBe("skipped");
    expect(report.steps[2]?.reason).toContain("container");
    expect(backend.callsFor("click")).toHaveLength(0);
    expect(report.summary).toMatchObject({ total: 3, ready: 1, dispatched: 0, skipped: 2 });
    await manager.dispose();
  });

  it("execute re-dispatches a ready pointer step through the live path", async () => {
    const { backend, manager, run } = await replayWith(
      new FakeComputerBackend({ windows: windows() }),
    );
    const doc = document([
      step({
        tool: "computer_click",
        resolutions: [coordinateResolution("win-terminal", "org.test.terminal")],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.executed).toBe(true);
    const clicks = backend.callsFor("click");
    expect(clicks).toHaveLength(1);
    // The re-issued call carries the fresh desktop point and the fresh window.
    expect(clicks[0]?.args[0]).toEqual({ x: 100, y: 100 });
    expect(report.steps[0]?.dispatch).toMatchObject({ ok: true });
    expect(report.summary.dispatched).toBe(1);
    await manager.dispose();
  });

  it("execute re-issues a windowless menu step onto the live process", async () => {
    const backend = new FakeComputerBackend({
      apps: [
        { pid: 6_001, name: "Helium", bundleId: "net.imput.helium", running: true, active: false },
        { pid: 1_001, name: "Terminal", bundleId: "org.test.terminal", running: true, active: true },
      ],
    });
    const { manager, run } = await replayWith(backend);
    const doc = document([
      step({
        tool: "computer_invoke_menu",
        actionClass: "lifecycle",
        args: { app: "Helium", path: ["File", "New Window"] },
        declaredTarget: { app: "Helium" },
        resolutions: [{ via: "process", pid: 6_001, app: "Helium" }],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.steps[0]?.verdict).toBe("ready");
    expect(report.steps[0]?.target).toMatchObject({ via: "process", status: "resolved" });
    // The windowless route stays windowless: the dispatch carries the live
    // pid and no window id at all.
    expect(backend.callsFor("invokeMenu").at(-1)?.args).toEqual([
      { pid: 6_001 },
      ["File", "New Window"],
    ]);
    expect(report.steps[0]?.dispatch).toMatchObject({ ok: true });
    await manager.dispose();
  });

  it("blocks a windowless menu step whose process is gone", async () => {
    const backend = new FakeComputerBackend({
      apps: [
        { pid: 1_001, name: "Terminal", bundleId: "org.test.terminal", running: true, active: true },
      ],
    });
    const { manager, run } = await replayWith(backend);
    const doc = document([
      step({
        tool: "computer_invoke_menu",
        actionClass: "lifecycle",
        args: { app: "Helium", path: ["File"] },
        declaredTarget: { app: "Helium" },
        resolutions: [{ via: "process", pid: 6_001, app: "Helium" }],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.steps[0]?.verdict).toBe("blocked");
    expect(report.steps[0]?.reason).toBe("process-gone");
    expect(backend.callsFor("invokeMenu")).toHaveLength(0);
    await manager.dispose();
  });

  it("execute remaps a point through the window's fresh bounds, never the pixels", async () => {
    const backend = new FakeComputerBackend({ windows: windows() });
    const { manager, run } = await replayWith(backend);
    const doc = document([
      step({
        tool: "computer_click",
        // Recorded at 100,100 inside a 960x720 window at (40,40) — relative
        // position (0.0625, 0.0833). The recorded window id is gone; exactly
        // one same-app window exists at a different place, so the remap lands
        // the same relative point inside the fresh bounds.
        declaredTarget: { x: 500, y: 500, windowId: "win-old" },
        resolutions: [
          {
            via: "coordinate",
            windowId: "win-old",
            app: "org.test.terminal",
            point: { x: 100, y: 100 },
            windowBounds: { x: 40, y: 40, width: 960, height: 720 },
          },
        ],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.steps[0]?.target?.status).toBe("remapped");
    expect(report.steps[0]?.target?.windowId).toBe("win-terminal");
    const clicks = backend.callsFor("click");
    expect(clicks).toHaveLength(1);
    const point = clicks[0]?.args[0] as { x: number; y: number };
    expect(point.x).toBeCloseTo(40 + 0.0625 * 960, 1);
    expect(point.y).toBeCloseTo(40 + 0.08333333333333333 * 720, 0);
    await manager.dispose();
  });

  it("blocks a step whose window is gone and cannot be remapped", async () => {
    const { backend, manager, run } = await replayWith(
      new FakeComputerBackend({ windows: windows() }),
    );
    const doc = document([
      step({
        tool: "computer_click",
        resolutions: [
          {
            via: "coordinate",
            windowId: "win-gone",
            // No live window owns this app — the one remap replay allows
            // has no candidate, so the step is refused rather than aimed.
            app: "org.test.absent",
            point: { x: 10, y: 10 },
          },
        ],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.steps[0]?.verdict).toBe("blocked");
    expect(report.steps[0]?.reason).toBe("window-gone");
    expect(backend.callsFor("click")).toHaveLength(0);
    await manager.dispose();
  });

  it("blocks a step whose window remap is ambiguous", async () => {
    const backend = new FakeComputerBackend({
      windows: [
        ...windows(),
        {
          id: "win-terminal-2",
          title: "Terminal — second",
          appName: "org.test.terminal",
          pid: 1_003,
          bounds: { x: 200, y: 200, width: 400, height: 300 },
          focused: false,
          minimized: false,
          visible: true,
        },
      ],
    });
    const { manager, run } = await replayWith(backend);
    const doc = document([
      step({
        tool: "computer_activate_window",
        actionClass: "window",
        resolutions: [
          {
            via: "window",
            windowId: "win-old",
            // Two live windows carry this app name: choosing one silently is
            // exactly the failure replay exists to prevent.
            app: "org.test.terminal",
          },
        ],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.steps[0]?.verdict).toBe("blocked");
    expect(report.steps[0]?.reason).toBe("window-gone");
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
    await manager.dispose();
  });

  it("blocks a text step whose payload stayed hashed at redacted fidelity", async () => {
    const { backend, manager, run } = await replayWith(
      new FakeComputerBackend({ windows: windows() }),
    );
    const doc = document([
      step({
        tool: "computer_type_text",
        actionClass: "text",
        args: { text: { chars: 5, sha256: "sha256:abc" } },
        payload: { chars: 5, sha256: "sha256:abc" },
        resolutions: [{ via: "keyboard", windowId: "win-terminal", app: "org.test.terminal" }],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.steps[0]?.verdict).toBe("blocked");
    expect(report.steps[0]?.reason).toContain("payload-not-captured");
    expect(backend.callsFor("typeText")).toHaveLength(0);
    await manager.dispose();
  });

  it("never retypes into a protected field, even at full fidelity", async () => {
    const { backend, manager, run } = await replayWith(
      new FakeComputerBackend({ windows: windows() }),
    );
    const doc = document([
      step({
        tool: "computer_type_text",
        actionClass: "text",
        // The text itself was captured — and the resolution says the control
        // was a secure field, so the capture stays unusable forever.
        args: { text: "correct horse battery staple" },
        payload: { chars: 28, sha256: "sha256:abc", protected: true },
        resolutions: [
          {
            via: "semantic",
            windowId: "win-terminal",
            app: "org.test.terminal",
            role: "AXSecureTextField",
            secure: true,
          },
        ],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.steps[0]?.verdict).toBe("blocked");
    expect(report.steps[0]?.reason).toContain("protected-field");
    expect(backend.callsFor("typeText")).toHaveLength(0);
    await manager.dispose();
  });

  it("re-issues a verbatim text payload at full fidelity", async () => {
    const { backend, manager, run } = await replayWith(
      new FakeComputerBackend({ windows: windows() }),
    );
    const doc = document([
      step({
        tool: "computer_press_key",
        actionClass: "keyboard",
        args: { key: "Return" },
        resolutions: [{ via: "keyboard", windowId: "win-terminal", app: "org.test.terminal" }],
      }),
      step({
        tool: "computer_type_text",
        actionClass: "text",
        args: { text: "retype me" },
        payload: { chars: 9, sha256: "sha256:abc", captured: true },
        resolutions: [{ via: "keyboard", windowId: "win-terminal", app: "org.test.terminal" }],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(backend.callsFor("pressKey")).toHaveLength(1);
    const types = backend.callsFor("typeText");
    expect(types).toHaveLength(1);
    expect(types[0]?.args[0]).toBe("retype me");
    expect(report.summary.dispatched).toBe(2);
    await manager.dispose();
  });

  it("re-issues a second app's step without asking", async () => {
    const backend = new FakeComputerBackend({ windows: windows() });
    const { manager, run } = await replayWith(backend);
    const doc = document([
      step({
        tool: "computer_activate_window",
        actionClass: "window",
        resolutions: [{ via: "window", windowId: "win-terminal", app: "org.test.terminal" }],
      }),
      step({
        tool: "computer_activate_window",
        actionClass: "window",
        seq: 2,
        resolutions: [{ via: "window", windowId: "win-calculator", app: "org.test.calc" }],
      }),
    ]);
    const report = await run(doc, { execute: true });
    // No consent boundary remains: both steps dispatch.
    expect(report.steps[0]?.dispatch?.ok).toBe(true);
    expect(report.steps[1]?.dispatch?.ok).toBe(true);
    expect(backend.callsFor("raiseWindow")).toHaveLength(2);
    await manager.dispose();
  });

  it("does not re-issue a recorded activate without the never-raise authorization", async () => {
    const backend = new FakeComputerBackend({ windows: windows() });
    const { manager, run } = await replayWith(backend);
    const doc = document([
      step({
        tool: "computer_activate_window",
        actionClass: "window",
        resolutions: [{ via: "window", windowId: "win-terminal", app: "org.test.terminal" }],
      }),
    ]);
    const report = await run(doc, {
      execute: true,
      foregroundAuthorization: { userRequestedVisibleUse: false },
    });
    // The step is attempted, refused by the gate, and reported honestly.
    expect(report.steps[0]?.dispatch?.ok).toBe(false);
    expect(report.steps[0]?.dispatch?.code).toBe("foreground_not_requested");
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
    await manager.dispose();
  });

  it("does not re-issue a recorded visible launch without the never-raise authorization", async () => {
    const backend = new FakeComputerBackend({ windows: windows() });
    const { manager, run } = await replayWith(backend);
    const doc = document([
      step({
        tool: "computer_launch_app",
        actionClass: "lifecycle",
        args: { app: "TextEdit", hidden: false },
        resolutions: [{ via: "app", app: "TextEdit" }],
      }),
    ]);
    const report = await run(doc, {
      execute: true,
      foregroundAuthorization: { userRequestedVisibleUse: false },
    });
    expect(report.steps[0]?.dispatch?.ok).toBe(false);
    expect(backend.callsFor("launchApp")).toHaveLength(0);
    await manager.dispose();
  });

  it("reports environment drift — major on platform/backend change, minor on display", async () => {
    const { manager, run } = await replayWith(new FakeComputerBackend({ windows: windows() }));
    const doc = document(
      [step({ tool: "computer_get_state", actionClass: "observation" })],
      recordedEnvironment({ platform: "darwin", dialect: "macos" }),
    );
    const report = await run(doc);
    expect(report.environment.drift).toBe("major");
    const platform = report.environment.fields.find((field) => field.field === "platform");
    expect(platform).toMatchObject({ verdict: "changed", recorded: "darwin", current: "linux" });
    const minor = await run(
      document(
        [step({ tool: "computer_get_state", actionClass: "observation" })],
        recordedEnvironment({ displayHash: "sha256:other" }),
      ),
    );
    expect(minor.environment.drift).toBe("minor");
    const same = await run(document([step({ tool: "computer_get_state" })]));
    expect(same.environment.drift).toBe("none");
    await manager.dispose();
  });

  it("honors the seq range when both bounds are given", async () => {
    const { backend, manager, run } = await replayWith(
      new FakeComputerBackend({ windows: windows() }),
    );
    const doc = document([
      step({
        tool: "computer_click",
        resolutions: [coordinateResolution("win-terminal", "org.test.terminal")],
      }),
      step({
        tool: "computer_click",
        resolutions: [coordinateResolution("win-terminal", "org.test.terminal")],
      }),
      step({
        tool: "computer_click",
        resolutions: [coordinateResolution("win-terminal", "org.test.terminal")],
      }),
    ]);
    const report = await run(doc, { execute: true, fromSeq: 2, toSeq: 2 });
    expect(report.summary.total).toBe(1);
    expect(report.steps[0]?.seq).toBe(2);
    expect(backend.callsFor("click")).toHaveLength(1);
    await manager.dispose();
  });

  it("a mutating step is never dispatched by a dry run, even with a verbatim payload", async () => {
    const { backend, manager, run } = await replayWith(
      new FakeComputerBackend({ windows: windows() }),
    );
    const doc = document([
      step({
        tool: "computer_type_text",
        actionClass: "text",
        args: { text: "verbatim payload" },
        payload: { chars: 16, sha256: "sha256:abc", captured: true },
        resolutions: [{ via: "keyboard", windowId: "win-terminal", app: "org.test.terminal" }],
      }),
      step({
        tool: "computer_kill_app",
        actionClass: "lifecycle",
        resolutions: [{ via: "window", windowId: "win-calculator", app: "org.test.calc" }],
      }),
    ]);
    const report = await run(doc);
    expect(report.executed).toBe(false);
    expect(report.summary.dispatched).toBe(0);
    expect(dispatchCalls(backend)).toHaveLength(0);
    await manager.dispose();
  });

  it("re-issues a wait step's timing and nothing else", async () => {
    const { backend, manager, run } = await replayWith(
      new FakeComputerBackend({ windows: windows() }),
    );
    const doc = document([
      step({ tool: "computer_wait", actionClass: "observation", args: { duration_ms: 5 } }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.steps[0]?.dispatch).toMatchObject({ ok: true });
    // The sleep is the dispatch: no backend call was made.
    expect(dispatchCalls(backend)).toHaveLength(0);
    await manager.dispose();
  });

  it("reports a dispatch failure honestly instead of hiding it", async () => {
    const backend = new FakeComputerBackend({ windows: windows() });
    const { manager, run } = await replayWith(backend);
    backend.failNext("click", new Error("backend refused"));
    const doc = document([
      step({
        tool: "computer_click",
        resolutions: [coordinateResolution("win-terminal", "org.test.terminal")],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.steps[0]?.dispatch).toMatchObject({ ok: false });
    expect(report.steps[0]?.dispatch?.error).toContain("backend refused");
    expect(report.summary.failed).toBe(1);
    await manager.dispose();
  });

  it("a revoked thread fails its steps rather than dispatching silently", async () => {
    const backend = new FakeComputerBackend({ windows: windows() });
    const { manager, run } = await replayWith(backend);
    await manager.setControlEnabled(THREAD, false);
    const doc = document([
      step({
        tool: "computer_click",
        resolutions: [coordinateResolution("win-terminal", "org.test.terminal")],
      }),
    ]);
    const report = await run(doc, { execute: true });
    expect(report.steps[0]?.dispatch?.ok).toBe(false);
    expect(backend.callsFor("click")).toHaveLength(0);
    await manager.dispose();
  });
});
