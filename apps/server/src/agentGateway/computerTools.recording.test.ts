import { Effect } from "effect";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderKind } from "@synara/contracts";

import { ComputerManager } from "../computer/ComputerManager.ts";
import { FakeComputerBackend } from "../computer/FakeComputerBackend.ts";
import { parseRecordingText } from "../computer/computerRecording.ts";
import {
  COMPUTER_APPROVAL_REQUIRED_TOOLS,
  makeAgentGatewayComputerTools,
  type AgentGatewayComputerToolsOptions,
} from "./computerTools.ts";
import type { McpToolCallResult } from "./protocol.ts";
import type { ToolContext } from "./toolRuntime.ts";

const THREAD = "thread-recording";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function resultJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text?.type === "text" ? JSON.parse(text.text) : undefined;
}

function makeContext(provider: ProviderKind = "claudeAgent", threadId = THREAD): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "gateway-session:computer",
      threadId,
      provider,
      turnId: "turn-computer",
    },
    callerThreadId: threadId,
    callerThreadLabel: null,
    callerSessionKey: "gateway-session:computer",
    callerProvider: provider,
    callerCapabilities: new Set(["computer:control"]),
    callerTurnId: "turn-computer",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

async function setup(
  options: {
    backend?: FakeComputerBackend;
    authorizeAction?: AgentGatewayComputerToolsOptions["authorizeAction"];
  } = {},
) {
  const backend = options.backend ?? new FakeComputerBackend();
  const recordingDir = await mkdtemp(join(tmpdir(), "computer-recording-tools-"));
  tempDirs.push(recordingDir);
  const manager = new ComputerManager({ backend, recordingDir, actionSettleMs: 0 });
  const tools = makeAgentGatewayComputerTools({
    manager,
    ...(options.authorizeAction ? { authorizeAction: options.authorizeAction } : {}),
  });
  const byName = new Map(tools.map((tool) => [tool.definition.name, tool]));
  const call = async (
    name: string,
    args: Record<string, unknown>,
    provider?: ProviderKind,
    threadId?: string,
  ): Promise<McpToolCallResult> => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return await Effect.runPromise(tool.handler(args, makeContext(provider, threadId)));
  };
  return { backend, manager, call, recordingDir };
}

/** The one session file's parsed contents — the assertions' raw material. */
async function parsedSession(manager: ComputerManager) {
  const recordings = await manager.listComputerRecordings();
  expect(recordings).toHaveLength(1);
  return parseRecordingText(await manager.exportComputerRecording(recordings[0]!.recordingId));
}

describe("computer recording tools", () => {
  it("start/stop/list/read/export/delete cover one session's lifecycle", async () => {
    const { call, recordingDir, manager } = await setup();
    const started = resultJson(
      await call("computer_recording_start", { fidelity: "redacted" }),
    ) as { recordingId: string; closed: boolean };
    expect(started.recordingId).toMatch(/^crec-/);
    expect(started.closed).toBe(false);

    const list = resultJson(await call("computer_recording_list", {})) as {
      recordings: { recordingId: string; closed: boolean }[];
    };
    expect(list.recordings.map((entry) => entry.recordingId)).toContain(started.recordingId);

    const stopped = resultJson(await call("computer_recording_stop", {})) as {
      stopped: boolean;
      reason: string;
    };
    expect(stopped.stopped).toBe(true);
    expect(stopped.reason).toBe("stopped");

    const read = resultJson(
      await call("computer_recording_read", { recording_id: started.recordingId }),
    ) as { header: { threadId: string }; steps: unknown[]; history: string[] };
    expect(read.header.threadId).toBe(THREAD);
    expect(read.history.length).toBeGreaterThan(0);
    expect(read.history[0]).toContain("recording");

    const exported = resultJson(
      await call("computer_recording_export", { recording_id: started.recordingId }),
    ) as { contents: string; format: string };
    expect(exported.format).toBe("ndjson");
    expect(exported.contents).toContain('"kind":"header"');

    const deleted = resultJson(
      await call("computer_recording_delete", { recording_id: started.recordingId }),
    ) as { deleted: boolean };
    expect(deleted.deleted).toBe(true);
    expect(await readdir(recordingDir)).toHaveLength(0);
    await manager.dispose();
  });

  it("records a tool call's resolutions, dispatches, and approval into the session", async () => {
    const { call, manager } = await setup({ authorizeAction: async () => true });
    await call("computer_recording_start", {});
    // A gated call under a granted approval records the whole path: the
    // decision, the resolution the target went through, and the dispatch.
    const click = await call("computer_click", {
      window_id: "fake-calculator",
      label: "Calculate",
      include_screenshot: false,
    });
    expect(click.isError).not.toBe(true);
    await call("computer_recording_stop", {});
    const parsed = await parsedSession(manager);
    const clickStep = parsed.steps.find((entry) => entry.tool === "computer_click");
    expect(clickStep).toBeDefined();
    expect(clickStep?.approval).toEqual({ required: true, decision: "granted" });
    expect(clickStep?.declaredTarget).toMatchObject({
      windowId: "fake-calculator",
      label: "Calculate",
    });
    expect(clickStep?.resolutions.length).toBeGreaterThan(0);
    expect(clickStep?.resolutions[0]?.windowId).toBe("fake-calculator");
    expect(clickStep?.dispatches.length).toBeGreaterThan(0);
    expect(clickStep?.dispatches[0]?.action).toBe("computer_click");
    expect(clickStep?.effect).not.toBe("refused");
    await manager.dispose();
  });

  it("hashes typed text at redacted fidelity and keeps it verbatim at full", async () => {
    const { call, manager } = await setup({ authorizeAction: async () => true });
    await call("computer_recording_start", {});
    await call("computer_type_text", {
      window_id: "fake-terminal",
      text: "a typed secret payload",
      include_screenshot: false,
    });
    await call("computer_recording_stop", {});
    const parsed = await parsedSession(manager);
    const step = parsed.steps.find((entry) => entry.tool === "computer_type_text");
    expect(step).toBeDefined();
    const raw = JSON.stringify(step);
    expect(raw).not.toContain("a typed secret payload");
    expect(step?.payload).toMatchObject({ chars: 22 });
    expect(step?.payload).not.toHaveProperty("captured");
    await manager.dispose();
  });

  it("keeps typed text verbatim under full fidelity so replay can retype it", async () => {
    const { call, manager } = await setup({ authorizeAction: async () => true });
    await call("computer_recording_start", { fidelity: "full" });
    await call("computer_type_text", {
      window_id: "fake-terminal",
      text: "verbatim text kept",
      include_screenshot: false,
    });
    await call("computer_recording_stop", {});
    const parsed = await parsedSession(manager);
    const step = parsed.steps.find((entry) => entry.tool === "computer_type_text");
    expect(step?.args.text).toBe("verbatim text kept");
    expect(step?.payload).toMatchObject({ captured: true });
    await manager.dispose();
  });

  it("writes one step line per computer_run step plus the container", async () => {
    const { call, manager } = await setup({ authorizeAction: async () => true });
    await call("computer_recording_start", {});
    const run = await call("computer_run", {
      steps: [
        { type: "click", window_id: "fake-calculator", label: "Calculate" },
        { type: "press_key", window_id: "fake-terminal", key: "Return" },
        { type: "wait", duration_ms: 1 },
      ],
    });
    expect(run.isError).not.toBe(true);
    await call("computer_recording_stop", {});
    const parsed = await parsedSession(manager);
    const tools = parsed.steps.map((entry) => entry.tool);
    expect(tools).toContain("computer_click");
    expect(tools).toContain("computer_press_key");
    expect(tools).toContain("computer_wait");
    expect(tools).toContain("computer_run");
    // The container's args summarize the step list; each inner step carries
    // its own resolutions and dispatch records.
    const container = parsed.steps.find((entry) => entry.tool === "computer_run");
    expect(container?.actionClass).toBe("batch");
    expect(container?.args.steps).toEqual({ count: 3, types: ["click", "press_key", "wait"] });
    const press = parsed.steps.find((entry) => entry.tool === "computer_press_key");
    expect(press?.resolutions.length).toBeGreaterThan(0);
    const wait = parsed.steps.find((entry) => entry.tool === "computer_wait");
    expect(wait?.effect).toBe("not-dispatched");
    await manager.dispose();
  });

  it("a thread whose control is off writes no records, not even the refusal", async () => {
    const { call, manager } = await setup();
    await call("computer_recording_start", {});
    await manager.setControlEnabled(THREAD, false);
    const refused = await call("computer_click", {
      window_id: "fake-calculator",
      label: "Calculate",
      include_screenshot: false,
    });
    expect(refused.isError).toBe(true);
    const parsed = await parsedSession(manager);
    // The session closed with the control and nothing after it was appended —
    // the only step is the opening call itself; refused calls after
    // revocation are state, not events.
    expect(parsed.steps.map((entry) => entry.tool)).toEqual(["computer_recording_start"]);
    expect(parsed.end?.reason).toBe("control-revoked");
    await manager.dispose();
  });

  it("computer_replay classifies a closed session without dispatching on the dry run", async () => {
    const { call, backend, manager } = await setup({ authorizeAction: async () => true });
    const started = resultJson(await call("computer_recording_start", { fidelity: "full" })) as {
      recordingId: string;
    };
    await call("computer_click", {
      window_id: "fake-calculator",
      label: "Calculate",
      include_screenshot: false,
    });
    await call("computer_recording_stop", {});
    const clicksBefore = backend.callsFor("click").length;
    const report = resultJson(
      await call("computer_replay", { recording_id: started.recordingId }),
    ) as {
      executed: boolean;
      steps: { tool: string; verdict: string }[];
      summary: { ready: number; dispatched: number };
    };
    expect(report.executed).toBe(false);
    const clickReport = report.steps.find((step) => step.tool === "computer_click");
    expect(clickReport?.verdict).toBe("ready");
    // The opening call is a step too — recording-family, always skipped.
    expect(report.steps.find((step) => step.tool === "computer_recording_start")?.verdict).toBe(
      "skipped",
    );
    expect(report.summary.dispatched).toBe(0);
    expect(backend.callsFor("click")).toHaveLength(clicksBefore);
    await manager.dispose();
  });

  it("computer_replay execute re-issues the ready step through the live path", async () => {
    const { call, backend, manager } = await setup({ authorizeAction: async () => true });
    const started = resultJson(await call("computer_recording_start", { fidelity: "full" })) as {
      recordingId: string;
    };
    await call("computer_click", {
      window_id: "fake-calculator",
      label: "Calculate",
      include_screenshot: false,
    });
    await call("computer_recording_stop", {});
    const report = resultJson(
      await call("computer_replay", { recording_id: started.recordingId, execute: true }),
    ) as {
      executed: boolean;
      steps: { tool: string; verdict: string; dispatch?: { ok: boolean } }[];
      summary: { dispatched: number };
    };
    expect(report.executed).toBe(true);
    expect(report.summary.dispatched).toBe(1);
    const clickReport = report.steps.find((step) => step.tool === "computer_click");
    expect(clickReport?.dispatch?.ok).toBe(true);
    expect(backend.callsFor("click").length).toBe(2);
    await manager.dispose();
  });

  it("start/delete/replay sit in the approval-required set; the reads do not", () => {
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_recording_start")).toBe(true);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_recording_delete")).toBe(true);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_replay")).toBe(true);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_recording_list")).toBe(false);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_recording_read")).toBe(false);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_recording_export")).toBe(false);
    expect(COMPUTER_APPROVAL_REQUIRED_TOOLS.has("computer_recording_stop")).toBe(false);
  });

  it("starting a second session on the same thread refuses instead of interleaving", async () => {
    const { call, manager } = await setup();
    const first = await call("computer_recording_start", {});
    expect(first.isError).not.toBe(true);
    const second = await call("computer_recording_start", {});
    expect(second.isError).toBe(true);
    await manager.dispose();
  });
});
