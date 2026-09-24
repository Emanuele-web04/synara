import { describe, expect, it } from "vitest";

import { ComputerManager } from "./ComputerManager.ts";

import type { ComputerBackendEvent } from "./ComputerBackend.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { CheckingComputerBackend, SwitchableComputerBackend } from "./switchableComputerBackend.ts";

describe("SwitchableComputerBackend", () => {
  it("reads every member, including optional ones, from the current occupant", async () => {
    const slot = new SwitchableComputerBackend(new CheckingComputerBackend("Detecting."));
    // The placeholder has no clipboard; presence checks must see that.
    expect(slot.backend.readClipboard).toBeUndefined();
    expect("readClipboard" in slot.backend).toBe(false);
    expect(await slot.backend.probeAvailability()).toEqual({
      kind: "checking",
      message: "Detecting.",
    });

    const fake = new FakeComputerBackend();
    await slot.swap(fake);
    expect(slot.backend.readClipboard).toBeTypeOf("function");
    expect(slot.backend).toBeInstanceOf(FakeComputerBackend);
    await slot.backend.writeClipboard!("hello");
    expect(await fake.readClipboard()).toBe("hello");
  });

  it("carries event listeners and an attached preview stream across a swap", async () => {
    const first = new FakeComputerBackend();
    const second = new FakeComputerBackend();
    const slot = new SwitchableComputerBackend(first);
    const events: ComputerBackendEvent["type"][] = [];
    slot.backend.onEvent!((event) => events.push(event.type));
    const frames: number[] = [];
    await slot.backend.attachStream((frame) => frames.push(frame.sequence));

    await slot.swap(second, { desktopChanged: true });
    expect(first.callsFor("detachStream")).toHaveLength(1);
    expect(second.callsFor("attachStream")).toHaveLength(1);
    expect(events).toEqual([
      "desktop-interrupted",
      "windows-changed",
      "capabilities-changed",
      "health-changed",
    ]);

    // The replaced occupant no longer reaches the manager.
    events.length = 0;
    first.emitDesktopInterrupted();
    second.emitDesktopInterrupted();
    expect(events).toEqual(["desktop-interrupted"]);
  });

  it("reports a gone desktop to the service and still forwards the event", () => {
    const occupant = new FakeComputerBackend();
    const gone: string[] = [];
    const slot = new SwitchableComputerBackend(occupant, {
      onDesktopGone: (_backend, message) => gone.push(message),
    });
    const events: string[] = [];
    slot.backend.onEvent!((event) => events.push(event.type));
    occupant.emitDesktopGone("Instance exited.");
    expect(gone).toEqual(["Instance exited."]);
    expect(events).toEqual(["desktop-gone"]);
  });
});

describe("replacing the desktop under the manager", () => {
  it("runs the swap between operations and ends the one that was in flight", async () => {
    const first = new FakeComputerBackend();
    const second = new FakeComputerBackend();
    const slot = new SwitchableComputerBackend(first);
    const manager = new ComputerManager({ backend: slot.backend, actionSettleMs: 0 });
    const targeted = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    try {
      // An action that has targeted the old desktop and is about to send
      // its input when the desktop is replaced.
      const action = manager.withAgentActivity("thread-1", async () => {
        await manager.moveCursor("thread-1", { x: 5, y: 5 });
        targeted.resolve();
        await resume.promise;
        return await manager.click("thread-1", { x: 10, y: 10 });
      });
      await targeted.promise;
      let swapped = false;
      const replacing = manager
        .replaceDesktop(() => slot.swap(second, { desktopChanged: true }))
        .then(() => {
          swapped = true;
        });
      await Promise.resolve();
      // The swap waits for the operation; it does not land inside it.
      expect(swapped).toBe(false);
      expect(slot.current).toBe(first);
      resume.resolve();

      await expect(action).rejects.toMatchObject({ retryable: true });
      await replacing;
      expect(slot.current).toBe(second);
      // Nothing of the old action reached either desktop after the swap began.
      expect(first.callsFor("click")).toHaveLength(0);
      expect(second.callsFor("click")).toHaveLength(0);

      // The next operation runs on the new desktop.
      await manager.withAgentActivity("thread-1", () =>
        manager.click("thread-1", { x: 10, y: 10 }),
      );
      expect(second.callsFor("click")).toHaveLength(1);
    } finally {
      await manager.dispose();
    }
  });

  it("swaps at once when nothing runs", async () => {
    const first = new FakeComputerBackend();
    const second = new FakeComputerBackend();
    const slot = new SwitchableComputerBackend(first);
    const manager = new ComputerManager({ backend: slot.backend, actionSettleMs: 0 });
    try {
      await manager.replaceDesktop(() => slot.swap(second));
      expect(slot.current).toBe(second);
    } finally {
      await manager.dispose();
    }
  });
});
