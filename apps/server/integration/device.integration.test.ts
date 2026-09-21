/** DEVICE_E2E=1 live-simulator E2E (macOS+Xcode, never in CI). Speaks Effect-RPC JSON over WS directly: only requirement is echoing serverInstanceId from /ws/negotiate on the /ws upgrade. */
import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
  decodeDeviceFrame,
} from "@synara/shared/deviceFrame";
import {
  DEVICE_WS_METHODS,
  WS_COMPATIBILITY_QUERY,
  WS_FEATURE_PATH,
  WS_NEGOTIATE_HTTP_PATH,
  WS_NEGOTIATE_QUERY,
  WS_PROTOCOL_EPOCH,
  WS_PROTOCOL_MAX_REVISION,
  WS_PROTOCOL_MIN_REVISION,
  type DeviceDescriptor,
  type DeviceListResult,
  type DeviceScreenshotResult,
  type ThreadDeviceState,
  type WsBootstrapNegotiateResult,
} from "@synara/contracts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";

import { DeviceManager } from "../src/device/DeviceManager.ts";
import { IosSimulatorBackend } from "../src/device/IosSimulatorBackend.ts";
import { makeAgentGatewayDeviceTools } from "../src/agentGateway/deviceTools.ts";
import type { McpToolCallResult } from "../src/agentGateway/protocol.ts";
import type { ToolContext } from "../src/agentGateway/toolRuntime.ts";

const ENABLED = process.env.DEVICE_E2E === "1";
const ORIGIN = process.env.DEVICE_E2E_ORIGIN ?? "http://127.0.0.1:3899";
const CLIENT_BUILD = "device-e2e";
const THREAD_ID = `device-e2e-${Date.now()}`;

const describeE2e = ENABLED ? describe : describe.skip;

function labelsOf(node: unknown, out: string[] = []): string[] {
  const record = node as { label?: unknown; children?: unknown } | null;
  if (record && typeof record.label === "string") out.push(record.label);
  if (record && Array.isArray(record.children)) {
    for (const child of record.children) labelsOf(child, out);
  }
  return out;
}

/** dismiss button of a system permission alert — fresh boots raise these over the app under test */
function alertDismissButton(node: unknown): { readonly x: number; readonly y: number } | null {
  const record = node as {
    label?: unknown;
    frame?: Record<string, number>;
    children?: unknown;
  } | null;
  if (!record) return null;
  const label = typeof record.label === "string" ? record.label : "";
  if (/^(Don.t Allow|Allow Once|OK|Cancel|Not Now)$/u.test(label.trim())) {
    const frame = record.frame;
    return {
      x: (frame?.x ?? 0) + (frame?.width ?? 0) / 2,
      y: (frame?.y ?? 0) + (frame?.height ?? 0) / 2,
    };
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      const found = alertDismissButton(child);
      if (found) return found;
    }
  }
  return null;
}

/** tap target = centre of the first labelled row, so the tap lands on something real regardless of screen */
function firstTappableRow(node: unknown): { readonly x: number; readonly y: number } | null {
  const record = node as {
    label?: unknown;
    frame?: Record<string, number>;
    children?: unknown;
  } | null;
  if (!record) return null;
  const frame = record.frame;
  const x = frame?.x ?? 0;
  const y = frame?.y ?? 0;
  const width = frame?.width ?? 0;
  const height = frame?.height ?? 0;
  if (
    typeof record.label === "string" &&
    record.label.trim().length > 0 &&
    height > 30 &&
    height < 90 &&
    width > 200 &&
    y > 200
  ) {
    return { x: x + width / 2, y: y + height / 2 };
  }
  if (Array.isArray(record.children)) {
    for (const child of record.children) {
      const found = firstTappableRow(child);
      if (found) return found;
    }
  }
  return null;
}

const SETTINGS_BUNDLE_ID = "com.apple.Preferences";

/** simctl-level reboot; nothing tells the server, so the helper keeps an attachment bound to the dead boot */
function simctl(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("xcrun", ["simctl", ...args], { timeout: 180_000 }, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function externalReboot(udid: string): Promise<void> {
  await simctl(["shutdown", udid]);
  await simctl(["boot", udid]);
  // `bootstatus -b` returns once CoreSimulator reports boot complete
  await simctl(["bootstatus", udid, "-b"]);
}

/** kill so a later `launch` starts the app at its root screen */
function terminateApp(udid: string, bundleId: string): Promise<void> {
  return simctl(["terminate", udid, bundleId]);
}

/** simctl screenshot, not device.screenshot — server calls route through the attach path that rebinds stale attachments, which this test must not trigger */
async function screenshotViaSimctl(udid: string): Promise<Buffer> {
  const path = join(tmpdir(), `synara-device-e2e-${randomUUID()}.png`);
  try {
    await simctl(["io", udid, "screenshot", path]);
    return await readFile(path);
  } finally {
    await rm(path, { force: true }).catch(() => undefined);
  }
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface RpcSocket {
  readonly call: <A>(method: string, payload: unknown) => Promise<A>;
  readonly close: () => void;
}

async function negotiate(): Promise<WsBootstrapNegotiateResult> {
  const url = new URL(WS_NEGOTIATE_HTTP_PATH, ORIGIN);
  url.searchParams.set(WS_NEGOTIATE_QUERY.protocolEpoch, String(WS_PROTOCOL_EPOCH));
  url.searchParams.set(WS_NEGOTIATE_QUERY.minRevision, String(WS_PROTOCOL_MIN_REVISION));
  url.searchParams.set(WS_NEGOTIATE_QUERY.maxRevision, String(WS_PROTOCOL_MAX_REVISION));
  url.searchParams.set(WS_NEGOTIATE_QUERY.clientBuild, CLIENT_BUILD);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Negotiate failed: ${response.status}`);
  return (await response.json()) as WsBootstrapNegotiateResult;
}

/** Effect RPC answers a Request with Chunk frame(s) then Exit; non-streaming device methods emit at most one chunk */
async function connectRpc(negotiation: WsBootstrapNegotiateResult): Promise<RpcSocket> {
  const url = new URL(WS_FEATURE_PATH, ORIGIN);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(WS_COMPATIBILITY_QUERY.protocolEpoch, String(WS_PROTOCOL_EPOCH));
  url.searchParams.set(
    WS_COMPATIBILITY_QUERY.protocolRevision,
    String(negotiation.negotiatedRevision),
  );
  url.searchParams.set(WS_COMPATIBILITY_QUERY.clientBuild, CLIENT_BUILD);
  url.searchParams.set(WS_COMPATIBILITY_QUERY.serverInstanceId, negotiation.serverInstanceId);

  const socket = new WebSocket(url.toString(), { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`Upgrade rejected: ${response.statusCode}`));
    });
  });

  interface Pending {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    chunk: unknown;
  }
  const pending = new Map<string, Pending>();
  let nextId = 1;

  socket.on("message", (data: RawData) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    const entry = pending.get(String(frame.requestId));
    if (!entry) return;
    if (frame._tag === "Chunk") {
      const values = frame.values as unknown[] | undefined;
      if (Array.isArray(values) && values.length > 0) entry.chunk = values[0];
      return;
    }
    if (frame._tag !== "Exit") return;
    pending.delete(String(frame.requestId));
    const exit = frame.exit as { _tag?: string; value?: unknown; cause?: unknown } | undefined;
    if (exit?._tag === "Success") {
      // non-streaming RPCs carry the result inline on Exit; streaming ones arrive as Chunk frames first
      entry.resolve(exit.value === undefined ? entry.chunk : exit.value);
      return;
    }
    entry.reject(new Error(`RPC failed: ${JSON.stringify(exit?.cause ?? exit)}`));
  });

  const call = <A>(method: string, payload: unknown): Promise<A> => {
    const id = String(nextId++);
    return new Promise<A>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out calling ${method}`));
      }, 120_000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value as A);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        chunk: undefined,
      });
      socket.send(JSON.stringify({ _tag: "Request", id, tag: method, payload, headers: [] }));
    });
  };

  return { call, close: () => socket.close() };
}

interface CollectedFrames {
  readonly total: number;
  readonly codecConfig: number;
  readonly keyframes: number;
}

/** count frames while `drive` forces screen damage — capture is damage-driven, the taps make it deterministic */
async function collectFrames(
  udid: string,
  drive: () => Promise<void>,
  windowMs: number,
): Promise<CollectedFrames> {
  const url = new URL(DEVICE_FRAME_WS_PATH, ORIGIN);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(DEVICE_FRAME_WS_UDID_PARAM, udid);

  const socket = new WebSocket(url.toString(), { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`Frame socket upgrade rejected: ${response.statusCode}`));
    });
  });

  // codec-config + first IDR are emitted at attach, before this socket exists; the pane's resync request restarts capture for this connection
  socket.send(JSON.stringify({ type: DEVICE_FRAME_RESYNC_MESSAGE }));

  let total = 0;
  let codecConfig = 0;
  let keyframes = 0;
  socket.on("message", (data: RawData) => {
    if (!Buffer.isBuffer(data)) return;
    const decoded = decodeDeviceFrame(new Uint8Array(data));
    if (!decoded.ok) return;
    total += 1;
    if (decoded.frame.header.codecConfig) codecConfig += 1;
    if (decoded.frame.header.keyframe) keyframes += 1;
  });

  await drive();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  socket.close();
  return { total, codecConfig, keyframes };
}

function makeToolContext(): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "device-e2e",
      threadId: THREAD_ID,
      provider: "claudeAgent",
      turnId: "device-e2e-turn",
    },
    callerThreadId: THREAD_ID,
    callerSessionKey: "device-e2e",
    callerProvider: "claudeAgent",
    callerCapabilities: new Set(["device:control"]),
    callerTurnId: "device-e2e-turn",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

function readToolJson(result: McpToolCallResult): unknown {
  const text = result.content.find((entry) => entry.type === "text");
  return text && text.type === "text" ? JSON.parse(text.text) : null;
}

describeE2e("device pane end-to-end", () => {
  let rpc: RpcSocket;
  let target: DeviceDescriptor | undefined;
  let bootedByTest = false;

  beforeAll(async () => {
    rpc = await connectRpc(await negotiate());
  }, 60_000);

  afterAll(async () => {
    if (target && bootedByTest) {
      await rpc.call(DEVICE_WS_METHODS.shutdown, { udid: target.udid }).catch(() => undefined);
    }
    rpc?.close();
  }, 120_000);

  it("lists devices and reports backend availability", async () => {
    const result = await rpc.call<DeviceListResult>(DEVICE_WS_METHODS.list, {
      includeShutdown: true,
    });
    // helper isn't compiled before first attach — "setup-required" is expected with only build-device-helper outstanding
    if (result.availability.kind === "setup-required") {
      const outstanding = result.availability.steps
        .filter((step) => !step.done)
        .map((step) => step.id);
      expect(outstanding).toEqual(["build-device-helper"]);
    } else {
      expect(result.availability.kind).toBe("available");
    }
    expect(result.devices.length).toBeGreaterThan(0);
    target = result.devices.find((device) => device.name.startsWith("iPhone"));
    expect(target).toBeDefined();
  }, 60_000);

  it("boots the target simulator", async () => {
    if (!target) throw new Error("no target device");
    const result = await rpc.call<{ kind: string; device?: DeviceDescriptor }>(
      DEVICE_WS_METHODS.boot,
      { udid: target.udid },
    );
    expect(result.kind).toBe("booted");
    bootedByTest = true;
    const listed = await rpc.call<DeviceListResult>(DEVICE_WS_METHODS.list, {});
    const booted = listed.devices.find((device) => device.udid === target?.udid);
    expect(booted?.state).toBe("booted");
    expect(booted?.bootSource).toBe("synara");
  }, 180_000);

  it("attaches the thread and streams H.264 frames driven by taps", async () => {
    if (!target) throw new Error("no target device");
    const attached = await rpc.call<ThreadDeviceState>(DEVICE_WS_METHODS.attach, {
      threadId: THREAD_ID,
      udid: target.udid,
    });
    expect(attached.attachedDeviceUdid).toBe(target.udid);

    const frames = await collectFrames(
      target.udid,
      async () => {
        for (let index = 0; index < 6; index += 1) {
          await rpc.call(DEVICE_WS_METHODS.tap, {
            udid: target!.udid,
            x: 200 + index * 5,
            y: 400 + index * 5,
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      },
      3_000,
    );

    expect(frames.codecConfig).toBeGreaterThanOrEqual(1);
    expect(frames.keyframes).toBeGreaterThanOrEqual(1);
    expect(frames.total).toBeGreaterThan(frames.codecConfig);
  }, 180_000);

  it("captures a screenshot that is a real PNG", async () => {
    if (!target) throw new Error("no target device");
    const shot = await rpc.call<DeviceScreenshotResult>(DEVICE_WS_METHODS.screenshot, {
      udid: target.udid,
    });
    expect(shot.mimeType).toBe("image/png");
    const bytes = Buffer.from(shot.bytesBase64, "base64");
    expect(bytes.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(bytes.byteLength).toBe(shot.sizeBytes);
    expect(shot.width).toBeGreaterThan(0);
    expect(shot.height).toBeGreaterThan(0);
  }, 120_000);

  it("detaches the thread", async () => {
    const detached = await rpc.call<ThreadDeviceState>(DEVICE_WS_METHODS.detach, {
      threadId: THREAD_ID,
    });
    expect(detached.attachedDeviceUdid).toBeNull();
  }, 60_000);

  it("re-attaches and streams again after the simulator is rebooted", async () => {
    if (!target) throw new Error("no target device");

    // the helper outlives the simulator holding a dead-boot descriptor — before the fix every post-reboot call failed "display has no framebuffer surface yet"
    await rpc.call(DEVICE_WS_METHODS.shutdown, { udid: target.udid });
    const afterShutdown = await rpc.call<DeviceListResult>(DEVICE_WS_METHODS.list, {
      includeShutdown: true,
    });
    expect(afterShutdown.devices.find((device) => device.udid === target?.udid)?.state).toBe(
      "shutdown",
    );

    const rebooted = await rpc.call<{ kind: string }>(DEVICE_WS_METHODS.boot, {
      udid: target.udid,
    });
    expect(rebooted.kind).toBe("booted");

    const reattached = await rpc.call<ThreadDeviceState>(DEVICE_WS_METHODS.attach, {
      threadId: THREAD_ID,
      udid: target.udid,
    });
    expect(reattached.attachedDeviceUdid).toBe(target.udid);
    expect(reattached.lastError).toBeNull();

    // input and video must both work against the new boot, not just attach
    const frames = await collectFrames(
      target.udid,
      async () => {
        for (let index = 0; index < 6; index += 1) {
          await rpc.call(DEVICE_WS_METHODS.tap, {
            udid: target!.udid,
            x: 200 + index * 5,
            y: 400 + index * 5,
          });
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
      },
      3_000,
    );
    expect(frames.keyframes).toBeGreaterThanOrEqual(1);
    expect(frames.total).toBeGreaterThan(frames.codecConfig);

    await rpc.call(DEVICE_WS_METHODS.detach, { threadId: THREAD_ID });
  }, 300_000);

  it("keeps input working after the simulator is rebooted outside Synara", async () => {
    if (!target) throw new Error("no target device");
    const udid = target.udid;

    // regression: helper held a dead-boot HID client and injected events vanished with Success acks — only the a11y tree proves a tap landed
    const describeUi = () =>
      rpc
        .call<{ root: unknown }>(DEVICE_WS_METHODS.describeUi, { udid })
        .then((result) => result.root);

    /** poll rather than sleep: a fresh boot leaves SpringBoard settling and raises permission alerts */
    const settleOnATappableScreen = async (): Promise<{
      readonly labels: readonly string[];
      readonly tapAt: { readonly x: number; readonly y: number };
    }> => {
      await rpc.call(DEVICE_WS_METHODS.launchApp, { udid, bundleId: SETTINGS_BUNDLE_ID });
      let labels: string[] = [];
      let tapAt: { readonly x: number; readonly y: number } | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const root = await describeUi();
        labels = labelsOf(root);
        const dismiss = alertDismissButton(root);
        if (dismiss) {
          await rpc.call(DEVICE_WS_METHODS.tap, { udid, x: dismiss.x, y: dismiss.y });
          continue;
        }
        tapAt = firstTappableRow(root);
        if (labels.length > 6 && tapAt !== null) break;
      }
      expect(labels.length, "expected a populated accessibility tree").toBeGreaterThan(6);
      expect(tapAt, "expected a tappable row in the accessibility tree").not.toBeNull();
      return { labels, tapAt: tapAt! };
    };

    const attached = await rpc.call<ThreadDeviceState>(DEVICE_WS_METHODS.attach, {
      threadId: THREAD_ID,
      udid,
    });
    expect(attached.attachedDeviceUdid).toBe(udid);

    try {
      const before = await settleOnATappableScreen();
      await rpc.call(DEVICE_WS_METHODS.tap, { udid, x: before.tapAt.x, y: before.tapAt.y });
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(labelsOf(await describeUi()), "the tap must change the screen").not.toEqual(
        before.labels,
      );

      // nothing tells the server this happened; the helper keeps its attachment
      await externalReboot(udid);

      // everything from here to the tap runs through simctl, never the server
      // any server call rebinds the dead descriptor and hides the bug — the tap must be the first helper call; simctl screenshots observe the screen
      await simctl(["launch", udid, SETTINGS_BUNDLE_ID]);
      await new Promise((resolve) => setTimeout(resolve, 10_000));

      const beforeShot = await screenshotViaSimctl(udid);
      // same row as before the reboot: Settings relaunched at root, point from that screen's own tree
      await rpc.call(DEVICE_WS_METHODS.tap, { udid, x: before.tapAt.x, y: before.tapAt.y });
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const afterShot = await screenshotViaSimctl(udid);

      expect(
        afterShot.equals(beforeShot),
        "the tap must change the screen after an external reboot, not just be acked",
      ).toBe(false);

      // the helper must be healthy afterwards, not merely lucky once
      expect(labelsOf(await describeUi()).length).toBeGreaterThan(6);
    } finally {
      // `simctl launch` on a live process is a no-op — leave Settings dead or a later launch inherits whatever screen it was on
      await terminateApp(udid, SETTINGS_BUNDLE_ID).catch(() => undefined);
      await rpc.call(DEVICE_WS_METHODS.detach, { threadId: THREAD_ID }).catch(() => undefined);
    }
  }, 600_000);

  it("drives the device through the MCP tools with no pane and no stream", async () => {
    // agent path: MCP handlers only — a tap used to be acked while the HID bridge failed silently
    const backend = new IosSimulatorBackend({ platform: process.platform });
    const manager = new DeviceManager({ backend });
    const openPaneRequests: Array<{ readonly reason: string }> = [];
    manager.onEvent((event) => {
      if (event.type === "device.open-pane-requested") openPaneRequests.push(event);
    });
    const tools = new Map(
      makeAgentGatewayDeviceTools({ manager }).map((tool) => [tool.definition.name, tool]),
    );
    const context = {
      principal: {
        kind: "provider-session",
        sessionKey: "device-e2e",
        threadId: THREAD_ID,
        provider: "codex",
        turnId: "device-e2e-turn",
      },
      callerThreadId: THREAD_ID,
      callerSessionKey: "device-e2e",
      callerProvider: "codex",
      callerCapabilities: new Set(["device:control"]),
      callerTurnId: "device-e2e-turn",
      assertCallerTurnActive: () => Effect.void,
      jsonRpcRequestId: 1,
    } as unknown as ToolContext;

    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`missing tool ${name}`);
      const result = await Effect.runPromise(tool.handler(args, context));
      expect(result.isError, `${name} must not error`).not.toBe(true);
      return readToolJson(result) as Record<string, unknown>;
    };

    try {
      const listed = (await call("device_list", { includeShutdown: true })) as {
        devices: ReadonlyArray<DeviceDescriptor>;
      };
      const device =
        listed.devices.find((entry) => entry.state === "booted") ??
        listed.devices.find((entry) => entry.name.startsWith("iPhone"));
      expect(device, "expected a simulator to drive").toBeDefined();
      // an earlier case shuts the device down — re-check live state and wait for boot before launching
      const booted = (await call("device_boot", { udid: device!.udid })) as { kind?: string };
      expect(booted.kind, "expected the device to boot").toBe("booted");

      // device_boot returns at Booted but SpringBoard keeps initializing — wait for a home-screen tree, then launch
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const root = (
          (await call("device_describe_ui", { udid: device!.udid })) as {
            root: unknown;
          }
        ).root;
        if (labelsOf(root).length > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }

      // relaunch rather than launch: an earlier case may have left Settings running and launch on a live process is a no-op
      await call("device_launch", { udid: device!.udid, bundleId: SETTINGS_BUNDLE_ID });
      // driving through MCP must ask the pane to open; already surfaced as "agent-tool", so this launch is a no-op
      expect(openPaneRequests).toHaveLength(1);
      expect(openPaneRequests[0]!.reason).toBe("agent-tool");
      // Settings paints async and a preceding reboot leaves SpringBoard settling — poll for a populated tree
      let before: string[] = [];
      let target: { readonly x: number; readonly y: number } | null = null;
      for (let attempt = 0; attempt < 15; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const root = (
          (await call("device_describe_ui", { udid: device!.udid })) as {
            root: unknown;
          }
        ).root;
        before = labelsOf(root);
        // fresh boots raise permission alerts over whatever runs — dismiss one and resample rather than comparing alert shots
        const dismiss = alertDismissButton(root);
        if (dismiss) {
          await call("device_tap", { udid: device!.udid, x: dismiss.x, y: dismiss.y });
          continue;
        }
        target = firstTappableRow(root);
        if (before.length > 6 && target !== null) break;
      }
      expect(before.length, "expected a populated accessibility tree").toBeGreaterThan(6);
      expect(target, "expected a tappable row in the accessibility tree").not.toBeNull();

      // tap a row the tree reports, not a fixed point that may land on padding
      await call("device_tap", { udid: device!.udid, x: target!.x, y: target!.y });
      await new Promise((resolve) => setTimeout(resolve, 3_000));

      const after = labelsOf(
        ((await call("device_describe_ui", { udid: device!.udid })) as { root: unknown }).root,
      );
      expect(after, "device_tap must actually change the screen").not.toEqual(before);
    } finally {
      await manager.dispose().catch(() => undefined);
    }
  }, 300_000);

  it("serves device_list and device_screenshot through the agent gateway tools", async () => {
    const backend = new IosSimulatorBackend({ platform: process.platform });
    const manager = new DeviceManager({ backend });
    try {
      const tools = new Map(
        makeAgentGatewayDeviceTools({ manager }).map((tool) => [tool.definition.name, tool]),
      );
      const context = makeToolContext();

      const listTool = tools.get("device_list");
      if (!listTool) throw new Error("device_list tool missing");
      const listed = readToolJson(
        await Effect.runPromise(listTool.handler({ includeShutdown: true }, context)),
      ) as { devices?: ReadonlyArray<DeviceDescriptor> };
      expect(Array.isArray(listed.devices)).toBe(true);
      const booted = listed.devices?.find((device) => device.state === "booted");
      expect(booted, "expected the simulator booted earlier to be visible").toBeDefined();

      const screenshotTool = tools.get("device_screenshot");
      if (!screenshotTool) throw new Error("device_screenshot tool missing");
      const result = await Effect.runPromise(
        screenshotTool.handler({ udid: booted!.udid }, context),
      );
      const image = result.content.find((entry) => entry.type === "image");
      expect(image, "device_screenshot must return an image payload").toBeDefined();
      if (image?.type === "image") {
        expect(image.mimeType).toBe("image/png");
        expect(Buffer.from(image.data, "base64").subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      }
    } finally {
      await manager.dispose().catch(() => undefined);
    }
  }, 180_000);
});
