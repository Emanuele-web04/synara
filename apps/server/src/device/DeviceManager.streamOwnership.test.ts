/**
 * The stability fixes from #1905 that live in the manager: a viewerless
 * attach must not take over another thread's stream, a helper that dies under
 * a live stream is replaced, and Synara keeps track of the simulators it
 * booted through failed listings and concurrent boots.
 */
import { describe, expect, it } from "vitest";

import { DeviceBackendError } from "./DeviceBackend.ts";
import { DeviceManager } from "./DeviceManager.ts";
import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";

const THREAD_A = "thread-a";
const THREAD_B = "thread-b";
const DEVICE_A = "FAKE-0001";
const DEVICE_B = "FAKE-0002";

const viewer = () => ({ send: () => undefined, bufferedAmount: () => 0, isOpen: () => true });

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeManager(backend = new FakeDeviceBackend()) {
  const manager = new DeviceManager({ backend, attachDeadlineMs: 0, attachRetryMs: 1 });
  return { backend, manager };
}

describe("a viewerless attach", () => {
  it("leaves another thread's watched stream alone until its own device gets a viewer", async () => {
    const { backend, manager } = makeManager();
    backend.bootExternally(DEVICE_A);
    backend.bootExternally(DEVICE_B);
    await manager.attach(THREAD_A, DEVICE_A);
    manager.subscribeFrames(DEVICE_A, viewer());
    await until(() => backend.hasStream(DEVICE_A), "device A streaming");

    // An agent on another thread drives device B with no pane open.
    await manager.attach(THREAD_B, DEVICE_B);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(backend.hasStream(DEVICE_A)).toBe(true);
    expect(backend.hasStream(DEVICE_B)).toBe(false);
    expect((await manager.getThreadState(THREAD_B)).attachPhase).toBeNull();

    // Opening a pane on device B is a viewer asking for it: now it switches.
    manager.subscribeFrames(DEVICE_B, viewer());
    await until(() => backend.hasStream(DEVICE_B), "device B streaming");
  });
});

describe("a helper that dies mid-stream", () => {
  it("brings the stream back for the viewers still watching", async () => {
    const { backend, manager } = makeManager();
    backend.bootExternally(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    manager.subscribeFrames(DEVICE_A, viewer());
    await until(() => backend.hasStream(DEVICE_A), "first stream");
    const attachesBefore = backend.callsOfKind("attachStream").length;

    backend.interruptStream(DEVICE_A);

    await until(
      () =>
        backend.hasStream(DEVICE_A) && backend.callsOfKind("attachStream").length > attachesBefore,
      "the replacement stream",
    );
  });

  it("tells the watching thread when the stream cannot come back", async () => {
    const { backend, manager } = makeManager();
    backend.bootExternally(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    manager.subscribeFrames(DEVICE_A, viewer());
    await until(() => backend.hasStream(DEVICE_A), "first stream");

    backend.failEveryStream("device helper build failed");
    backend.interruptStream(DEVICE_A, "device helper exited (code=null, signal=SIGSEGV)");

    let lastError: string | null = null;
    await until(() => {
      void manager.getThreadState(THREAD_A).then((state) => {
        lastError = state.lastError;
      });
      return lastError !== null;
    }, "an error on the thread");
    expect(lastError).toMatch(
      /helper stopped \(device helper exited.*SIGSEGV\).*could not be restarted/,
    );
  });

  it("does nothing when nobody needs the stream any more", async () => {
    const { backend, manager } = makeManager();
    backend.bootExternally(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    const unsubscribe = manager.subscribeFrames(DEVICE_A, viewer());
    await until(() => backend.hasStream(DEVICE_A), "first stream");
    await manager.detach(THREAD_A);
    unsubscribe();
    const attachesBefore = backend.callsOfKind("attachStream").length;

    backend.interruptStream(DEVICE_A);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(backend.callsOfKind("attachStream")).toHaveLength(attachesBefore);
  });
});

describe("boot ownership", () => {
  it("survives a listing that fails", async () => {
    const { backend, manager } = makeManager();
    await manager.boot(DEVICE_A);
    const listDevices = backend.listDevices.bind(backend);
    backend.listDevices = async () => {
      throw new DeviceBackendError("simctl list failed");
    };

    await manager.synaraBootedDevices();
    backend.listDevices = listDevices;

    // Still Synara's: quitting shuts it down.
    await manager.dispose();
    expect(backend.callsOfKind("shutdown").map((call) => call.udid)).toContain(DEVICE_A);
  });

  it("keeps both of two boots that run at the same time", async () => {
    const { backend, manager } = makeManager();
    const boot = backend.boot.bind(backend);
    const bootA = Promise.withResolvers<void>();
    backend.boot = async (udid) => {
      // Device A stays mid-boot (still listed as shut down) while B boots and
      // reconciles against a listing that does not show A running yet.
      if (udid === DEVICE_A) await bootA.promise;
      return await boot(udid);
    };

    const bootingA = manager.boot(DEVICE_A);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await manager.boot(DEVICE_B);
    bootA.resolve();
    await bootingA;

    const owned = (await manager.synaraBootedDevices()).map((device) => device.udid);
    expect(owned.toSorted()).toEqual([DEVICE_A, DEVICE_B]);
  });
});

describe("helper recovery with a hidden attached pane", () => {
  it("does not undo the last viewer's stop while its chat stays attached", async () => {
    const { backend, manager } = makeManager();
    backend.bootExternally(DEVICE_A);
    await manager.attach(THREAD_A, DEVICE_A);
    const unsubscribe = manager.subscribeFrames(DEVICE_A, viewer());
    await until(() => backend.hasStream(DEVICE_A), "first stream");
    const before = backend.callsOfKind("attachStream").length;
    backend.interruptStream(DEVICE_A);
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backend.callsOfKind("attachStream")).toHaveLength(before);
    expect(backend.hasStream(DEVICE_A)).toBe(false);
    await manager.dispose();
  });
});
