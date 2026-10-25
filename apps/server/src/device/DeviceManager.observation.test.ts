import { describe, expect, it } from "vitest";

import { DeviceManager } from "./DeviceManager.ts";
import { FakeDeviceBackend } from "./FakeDeviceBackend.ts";

const DEVICE = "FAKE-0001";

/**
 * A manager on a virtual clock: every scheduled wait advances time by exactly
 * its duration and fires on the next macrotask, so settle deadlines are exact
 * and the suite does not sleep.
 */
async function makeManager() {
  const backend = new FakeDeviceBackend();
  let clock = 0;
  const manager = new DeviceManager({
    backend,
    now: () => clock,
    setTimeout: (handler, ms) => {
      clock += ms;
      return setTimeout(handler, 0);
    },
    clearTimeout: (handle) => clearTimeout(handle),
  });
  await backend.boot(DEVICE);
  return { backend, manager, elapsed: () => clock };
}

describe("DeviceManager settling", () => {
  it("returns once the tree holds still for the quiet window", async () => {
    const { manager } = await makeManager();

    const outcome = await manager.waitForSettle(DEVICE, { quietMs: 300, timeoutMs: 2_500 });

    expect(outcome.settled).toBe(true);
    // Start delay, then reads every 100 ms until 300 ms have passed unchanged.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(300);
    expect(outcome.waitedMs).toBeLessThan(1_000);
    expect(outcome.root?.label).toBe("Fake App");
  });

  it("keeps waiting while the tree changes, then settles after it stops", async () => {
    const { backend, manager } = await makeManager();
    backend.animateFor(6);

    const outcome = await manager.waitForSettle(DEVICE, { quietMs: 300, timeoutMs: 5_000 });

    expect(outcome.settled).toBe(true);
    // Six changing reads at 100 ms apart push the quiet window past 600 ms.
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(700);
    expect(JSON.stringify(outcome.root)).not.toContain("Loading");
  });

  it("reports an endless animation as unsettled at the deadline instead of hanging", async () => {
    const { backend, manager } = await makeManager();
    backend.animateFor(1_000);

    const outcome = await manager.waitForSettle(DEVICE, { quietMs: 300, timeoutMs: 1_000 });

    expect(outcome.settled).toBe(false);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(1_000);
    expect(outcome.root).not.toBeNull();
  });

  it("says whether an action changed the screen", async () => {
    const { backend, manager } = await makeManager();

    const unchanged = await manager.observe(DEVICE, () => manager.tap(DEVICE, 1, 1));
    expect(unchanged.changed).toBe(false);

    const changed = await manager.observe(DEVICE, async () => {
      await backend.setFocusedValue(DEVICE, "typed");
      backend.animateFor(2);
    });
    // A field's new value is a lasting change; the transient spinner is not,
    // and the settle waits it out before comparing.
    expect(changed.settled).toBe(true);
    expect(changed.changed).toBe(true);
    expect(JSON.stringify(changed.root)).not.toContain("Loading");
  });
});

describe("DeviceManager waiting for elements", () => {
  it("returns as soon as the element is on screen", async () => {
    const { manager } = await makeManager();

    const outcome = await manager.waitFor(
      DEVICE,
      { identifier: "continue-button" },
      {
        timeoutMs: 5_000,
      },
    );

    expect(outcome.status).toBe("ready");
    expect(outcome.match?.node.label).toBe("Continue");
    expect(outcome.waitedMs).toBe(0);
  });

  it("waits for an element to go away", async () => {
    const { backend, manager } = await makeManager();
    backend.animateFor(3);

    const outcome = await manager.waitFor(
      DEVICE,
      { label: "Loading" },
      {
        gone: true,
        timeoutMs: 5_000,
      },
    );

    expect(outcome.status).toBe("ready");
    expect(outcome.waitedMs).toBeGreaterThan(0);
  });

  it("times out on an element that never appears", async () => {
    const { manager } = await makeManager();

    const outcome = await manager.waitFor(DEVICE, { label: "Never" }, { timeoutMs: 1_000 });

    expect(outcome.status).toBe("timeout");
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(1_000);
  });
});

describe("DeviceManager identifier targeting", () => {
  it("taps by accessibility identifier", async () => {
    const { backend, manager } = await makeManager();

    const match = await manager.tapElement(DEVICE, { identifier: "continue-button" });

    expect(match.node.label).toBe("Continue");
    expect(backend.calls.at(-1)).toEqual({ kind: "tap", udid: DEVICE, x: 196, y: 725 });
  });

  it("names the identifiers on screen when one does not exist", async () => {
    const { manager } = await makeManager();

    await expect(manager.tapElement(DEVICE, { identifier: "missing" })).rejects.toThrow(
      /No element with identifier #missing appeared/,
    );
  });

  it("passes a long press through to the backend", async () => {
    const { backend, manager } = await makeManager();

    await manager.tapElement(DEVICE, { label: "Continue" }, { holdMs: 800 });

    expect(backend.calls.at(-1)).toMatchObject({ kind: "tap", holdMs: 800 });
  });
});

describe("DeviceManager text entry", () => {
  it("types ASCII as keystrokes on a US keyboard layout", async () => {
    const { backend, manager } = await makeManager();

    const outcome = await manager.enterText(DEVICE, "hello");

    expect(outcome).toEqual({ method: "keys", submitted: false });
    expect(backend.callsOfKind("typeText")).toEqual([
      { kind: "typeText", udid: DEVICE, text: "hello" },
    ]);
  });

  it("sets the value instead of typing on a non-US layout, appending to what is there", async () => {
    const { backend, manager } = await makeManager();
    backend.usKeyboardLayout = false;
    await backend.setFocusedValue(DEVICE, "Wi");

    const outcome = await manager.enterText(DEVICE, "-Fi");

    // "-" through an Italian hardware layout types an apostrophe; the value
    // path puts the exact text in instead.
    expect(outcome.method).toBe("value");
    expect(backend.callsOfKind("setFocusedValue").at(-1)?.value).toBe("Wi-Fi");
    expect(backend.callsOfKind("typeText")).toEqual([]);
  });

  it("sets non-ASCII text as a value even on a US layout", async () => {
    const { backend, manager } = await makeManager();

    const outcome = await manager.enterText(DEVICE, "Città 🚀", { clear: true });

    expect(outcome.method).toBe("value");
    expect(backend.callsOfKind("setFocusedValue").at(-1)?.value).toBe("Città 🚀");
  });

  it("treats a placeholder reported as the value as an empty field", async () => {
    const { backend, manager } = await makeManager();
    backend.usKeyboardLayout = false;

    await manager.enterText(DEVICE, "a@b.co");

    // The empty fake field reports its placeholder "you@example.com" as value.
    expect(backend.callsOfKind("setFocusedValue").at(-1)?.value).toBe("a@b.co");
  });

  it("refuses keystrokes for text that has no keys", async () => {
    const { manager } = await makeManager();

    await expect(manager.enterText(DEVICE, "Città", { method: "keys" })).rejects.toThrow(
      /printable ASCII only/,
    );
  });

  it("clears with select-all and delete, and submits with Return", async () => {
    const { backend, manager } = await makeManager();

    const outcome = await manager.enterText(DEVICE, "query\n", { clear: true });

    expect(outcome).toEqual({ method: "keys", submitted: true });
    const keys = backend
      .callsOfKind("keyEvent")
      .filter((call) => call.event.direction === "down")
      .map((call) => [call.event.keyCode, call.event.modifiers]);
    expect(keys).toEqual([
      [0x04, ["command"]],
      [0x2a, []],
      [0x28, []],
    ]);
    expect(backend.callsOfKind("typeText").at(-1)?.text).toBe("query");
  });
});

describe("DeviceManager observing a launch", () => {
  it("does not settle on the blank screen between apps", async () => {
    const backend = new FakeDeviceBackend();
    let clock = 0;
    const manager = new DeviceManager({
      backend,
      now: () => clock,
      setTimeout: (handler, ms) => {
        clock += ms;
        return setTimeout(handler, 0);
      },
      clearTimeout: (handle) => clearTimeout(handle),
    });
    await backend.boot(DEVICE);
    const describe = backend.describeUi.bind(backend);
    let blankReads = 5;
    backend.describeUi = async (udid) => {
      const tree = await describe(udid);
      if (blankReads === 0) return tree;
      blankReads -= 1;
      return { ...tree, root: { ...tree.root, label: " ", children: [] } };
    };

    const observation = await manager.observe(
      DEVICE,
      async () => {
        blankReads = 5;
      },
      { awaitApp: "any" },
    );

    expect(observation.root?.label).toBe("Fake App");
  });
});

describe("DeviceManager observing a late transition", () => {
  it("waits for an effect that starts after a pause instead of settling on the old screen", async () => {
    const { backend, manager } = await makeManager();
    const describe = backend.describeUi.bind(backend);
    let readsUntilChange = -1;
    backend.describeUi = async (udid) => {
      const tree = await describe(udid);
      if (readsUntilChange < 0) return tree;
      if (readsUntilChange > 0) {
        readsUntilChange -= 1;
        return tree;
      }
      return { ...tree, root: { ...tree.root, label: "Home Screen", children: [] } };
    };

    // The home press lands, but the screen only starts moving five reads
    // (about half a second) later: longer than one quiet window.
    const observation = await manager.observe(DEVICE, async () => {
      readsUntilChange = 5;
    });

    expect(observation.changed).toBe(true);
    expect(observation.root?.label).toBe("Home Screen");
  });

  it("reports no change once the grace passes with nothing moving", async () => {
    const { manager } = await makeManager();

    const observation = await manager.observe(DEVICE, async () => {});

    expect(observation.changed).toBe(false);
    expect(observation.waitedMs).toBeGreaterThanOrEqual(300);
  });
});

describe("DeviceManager fixed chrome", () => {
  it("taps a navigation-bar button that scrolling cannot move", async () => {
    const { backend, manager } = await makeManager();
    const describe = backend.describeUi.bind(backend);
    backend.describeUi = async (udid) => {
      const tree = await describe(udid);
      const back = {
        role: "Button",
        subrole: null,
        label: "Settings",
        value: null,
        identifier: "BackButton",
        frame: { x: 16, y: 62, width: 44, height: 44 },
        activationPoint: null,
        children: [],
      };
      return {
        ...tree,
        root: {
          ...tree.root,
          children: [
            { ...tree.root, role: "NavigationBar", label: null, children: [back] },
            ...tree.root.children,
          ],
        },
      };
    };

    const match = await manager.tapElement(DEVICE, { identifier: "BackButton" });

    expect(match.point).toEqual({ x: 38, y: 84 });
    // One probing swipe shows it does not scroll; then it is tapped in place.
    expect(backend.callsOfKind("swipe")).toHaveLength(1);
    expect(backend.calls.at(-1)).toEqual({ kind: "tap", udid: DEVICE, x: 38, y: 84 });
  });
});

describe("unsafe observations", () => {
  it("does not certify an unchanged pre-restart screen", async () => {
    const { manager } = await makeManager();
    const outcome = await manager.observe(DEVICE, async () => {}, {
      awaitApp: "any",
      timeoutMs: 1000,
    });
    expect(outcome.settled).toBe(false);
  });
  it("refuses value appends to secure fields instead of changing keyboard method", async () => {
    const { backend, manager } = await makeManager();
    backend.usKeyboardLayout = false;
    const describe = backend.describeUi.bind(backend);
    backend.describeUi = async (udid) => {
      const tree = await describe(udid);
      return {
        ...tree,
        root: {
          ...tree.root,
          children: [
            {
              role: "TextField",
              subrole: "SecureTextField",
              label: "Password",
              value: "••",
              focused: true,
              frame: { x: 0, y: 100, width: 200, height: 40 },
              activationPoint: null,
              children: [],
            },
          ],
        },
      };
    };
    await expect(manager.enterText(DEVICE, "a-b", { method: "value" })).rejects.toThrow(
      /clear: true/,
    );
    expect(backend.callsOfKind("typeText")).toEqual([]);
  });
  it("does not tap a covered field merely because a swipe did not move it", async () => {
    const { backend, manager } = await makeManager();
    const describe = backend.describeUi.bind(backend);
    backend.describeUi = async (udid) => {
      const tree = await describe(udid);
      return {
        ...tree,
        root: {
          ...tree.root,
          children: [
            {
              role: "Button",
              subrole: null,
              label: "Covered",
              value: null,
              frame: { x: 0, y: 840, width: 200, height: 30 },
              activationPoint: null,
              children: [],
            },
          ],
        },
      };
    };
    await expect(manager.tapElement(DEVICE, { label: "Covered" })).rejects.toThrow(/out of reach/);
    expect(backend.callsOfKind("tap")).toEqual([]);
  });
});

describe("cancelled observations", () => {
  it("ends an explicit wait without polling or further input after cancellation", async () => {
    const { manager } = await makeManager();
    const controller = new AbortController();
    const waiting = manager.waitFor(
      DEVICE,
      { label: "Never" },
      { timeoutMs: 30_000, signal: controller.signal },
    );
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
  });
  it("reports a deep link without a changed screen as unsettled", async () => {
    const { manager } = await makeManager();
    const result = await manager.observe(DEVICE, async () => {}, {
      awaitChange: true,
      timeoutMs: 1000,
    });
    expect(result.settled).toBe(false);
    expect(result.changed).toBe(false);
  });
});
