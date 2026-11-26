import { beforeEach, expect, it, vi } from "vitest";
import { captureProcessTree, type CapturedProcessTree } from "./processTreeController";
import {
  teardownChildProcessTree,
  teardownProviderProcessTree,
  type ProcessExitHandle,
} from "./supervisedProcessTeardown";
import { createWindowsTeardownProcessSnapshotObserver } from "./windowsProcessSnapshot";
import { createProtocolProcessTeardown } from "./protocolProcessTeardown";

vi.mock("./processTreeController", () => ({
  captureProcessTree: vi.fn(),
  inspectProcessTree: vi.fn(),
  isProcessRunning: vi.fn(),
}));
vi.mock("./supervisedProcessTeardown", () => ({
  teardownChildProcessTree: vi.fn(),
  teardownProviderProcessTree: vi.fn(),
}));
vi.mock("./windowsProcessSnapshot", () => ({
  createWindowsTeardownProcessSnapshotObserver: vi.fn(),
}));

const tree: CapturedProcessTree = {
  descendants: [{ pid: 43, command: "owned debuggee", startedAt: "original identity" }],
  captureComplete: true,
};
const child: ProcessExitHandle = {
  pid: 42,
  exitCode: null,
  signalCode: null,
  once: vi.fn(),
  removeListener: vi.fn(),
};
const result = { escalated: false, signalErrors: [] };
const observer = {
  capture: vi.fn(),
  captureWithin: vi.fn(),
  retryDelayMs: vi.fn(),
  dispose: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(captureProcessTree).mockResolvedValue(tree);
  vi.mocked(createWindowsTeardownProcessSnapshotObserver).mockReturnValue(observer);
  observer.captureWithin.mockResolvedValue(new Map());
  vi.mocked(teardownChildProcessTree).mockImplementation(async (_child, teardown) => {
    if (!teardown) throw new Error("Missing platform teardown.");
    return teardown({ rootPid: 42, rootExited: Promise.resolve() });
  });
  vi.mocked(teardownProviderProcessTree).mockResolvedValue(result);
});

it("captures before disconnect, coalesces callers and remembers proven cleanup", async () => {
  const order: string[] = [];
  vi.mocked(captureProcessTree).mockImplementation(async () => {
    order.push("capture");
    return tree;
  });
  const disconnect = vi.fn(async () => {
    order.push("disconnect");
  });
  vi.mocked(teardownProviderProcessTree).mockImplementation(async (_input, dependencies) => {
    expect(await dependencies?.captureProcessTree?.(42)).toBe(tree);
    order.push("proof");
    return result;
  });
  const stop = createProtocolProcessTeardown(child, disconnect, "linux");
  const first = stop();
  expect(stop()).toBe(first);
  await first;
  await stop();
  expect(order).toEqual(["capture", "disconnect", "proof"]);
  expect(teardownChildProcessTree).toHaveBeenCalledTimes(1);
});

it("retries failed proof against the same pre-disconnect descendant identities", async () => {
  const unproven = new Error("Descendant exit unproven.");
  vi.mocked(teardownProviderProcessTree).mockRejectedValueOnce(unproven);
  const disconnect = vi.fn(async () => undefined);
  const stop = createProtocolProcessTeardown(child, disconnect, "linux");
  await expect(stop()).rejects.toBe(unproven);
  // A new root snapshot after disconnect would lose reparented descendants.
  vi.mocked(captureProcessTree).mockResolvedValue({ descendants: [], captureComplete: true });
  await stop();
  expect(captureProcessTree).toHaveBeenCalledTimes(1);
  expect(disconnect).toHaveBeenCalledTimes(1);
  const dependencies = vi.mocked(teardownProviderProcessTree).mock.calls[1]?.[1];
  expect(await dependencies?.captureProcessTree?.(42)).toBe(tree);
});

it("still forces teardown after a broken protocol and does not hide failed proof", async () => {
  const protocol = new Error("DAP socket closed.");
  const proof = new Error("Descendant exit unproven.");
  vi.mocked(teardownProviderProcessTree).mockRejectedValueOnce(proof);
  const stop = createProtocolProcessTeardown(
    child,
    async () => {
      throw protocol;
    },
    "linux",
  );
  await expect(stop()).rejects.toMatchObject({ errors: [protocol, proof] });
  expect(teardownChildProcessTree).toHaveBeenCalledTimes(1);
});

it("does not replace a failed initial capture with an empty post-exit snapshot", async () => {
  const incomplete = { descendants: [], captureComplete: false };
  vi.mocked(captureProcessTree).mockResolvedValue(incomplete);
  vi.mocked(teardownProviderProcessTree).mockImplementation(async (_input, dependencies) => {
    expect(await dependencies?.captureProcessTree?.(42)).toBe(incomplete);
    throw new Error("Cannot prove descendants exited.");
  });
  const stop = createProtocolProcessTeardown(child, async () => undefined, "linux");
  await expect(stop()).rejects.toThrow("Cannot prove");
  vi.mocked(captureProcessTree).mockResolvedValue({ descendants: [], captureComplete: true });
  await expect(stop()).rejects.toThrow("Cannot prove");
  expect(captureProcessTree).toHaveBeenCalledTimes(1);
});

it("budgets cold Windows capture separately and disposes the observer on failure", async () => {
  vi.mocked(captureProcessTree).mockImplementation(async (_pid, options) => {
    await options?.captureWindowsChildren?.();
    return tree;
  });
  vi.mocked(teardownProviderProcessTree).mockRejectedValueOnce(new Error("Unproven exit."));
  const stop = createProtocolProcessTeardown(child, async () => undefined, "win32");
  await expect(stop()).rejects.toThrow("Unproven exit");
  expect(createWindowsTeardownProcessSnapshotObserver).toHaveBeenCalledWith({
    probeTimeoutMs: 8_000,
  });
  expect(observer.captureWithin).toHaveBeenCalledWith(8_000);
  expect(observer.dispose).toHaveBeenCalledTimes(1);
  await stop();
  expect(captureProcessTree).toHaveBeenCalledTimes(1);
  expect(observer.dispose).toHaveBeenCalledTimes(2);
});

it("does not claim an empty post-exit tree proves cleanup after an adapter crash", async () => {
  vi.mocked(teardownProviderProcessTree).mockRejectedValue(new Error("Unproven cleanup."));
  const stop = createProtocolProcessTeardown(
    { ...child, exitCode: 1 },
    async () => undefined,
    "linux",
  );
  await expect(stop()).rejects.toThrow("Protocol process cleanup failed.");
  expect(captureProcessTree).not.toHaveBeenCalled();
  const dependencies = vi.mocked(teardownProviderProcessTree).mock.calls[0]?.[1];
  expect(await dependencies?.captureProcessTree?.(42)).toEqual({
    descendants: [],
    captureComplete: false,
  });
});
