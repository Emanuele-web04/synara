import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerSpaceInventory, ComputerWindow } from "@synara/contracts";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { withComputerTask } from "./computerTaskContext.ts";

const window: ComputerWindow = {
  id: "cua:10:20",
  title: "Fixture",
  appName: "Fixture",
  pid: 10,
  focused: false,
  visible: false,
  minimized: false,
  bounds: { x: 20, y: 20, width: 300, height: 200 },
  spaceIds: [2],
  currentSpaceId: 1,
  onCurrentSpace: false,
};
const inventory: ComputerSpaceInventory = {
  source: "macos-managed-spaces",
  complete: true,
  spaces: [1, 2].map((id) => ({
    id,
    uuid: `uuid-${id}`,
    displayId: "display-a",
    kind: "desktop",
    current: id === 1,
  })),
};
const managers: ComputerManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.dispose()));
});

async function setup() {
  const listSpaces = vi.fn(async () => inventory);
  const backend = Object.assign(
    new FakeComputerBackend({ windows: [window], agentDialect: "macos", browser: true }),
    { listSpaces },
  );
  const manager = new ComputerManager({ backend, actionSettleMs: 0 });
  managers.push(manager);
  await manager.spaceBroker.reserve({ threadId: "a", turnId: null }, 2, [2], window.id);
  return { manager, backend, listSpaces };
}

describe("ComputerManager reserved Space boundaries", () => {
  it("guards exact target keys and refuses them after the user enters the Space", async () => {
    const { manager, backend, listSpaces } = await setup();
    await manager.pressKey("a", "Tab", window.id);
    expect(backend.callsFor("pressKey")).toHaveLength(1);
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
    listSpaces.mockResolvedValue({
      ...inventory,
      spaces: inventory.spaces.map((s) => ({ ...s, current: s.id === 2 })),
    });
    await expect(manager.pressKey("a", "Tab", window.id)).rejects.toMatchObject({
      code: "computer_space_current",
    });
    expect(backend.callsFor("pressKey")).toHaveLength(1);
  });

  it.each([
    [
      "activate",
      (m: ComputerManager) => m.activateWindow("a", window.id, { userRequestedVisibleUse: true }),
    ],
    [
      "foreground",
      (m: ComputerManager) =>
        m.foregroundWithRestore("a", window.id, undefined, { userRequestedVisibleUse: true }),
    ],
    ["launch", (m: ComputerManager) => m.launchApp("a", "Fixture")],
    [
      "app menu",
      (m: ComputerManager) =>
        m.invokeMenu("a", { pid: 10 }, ["File", "New"], { userRequestedVisibleUse: true }),
    ],
    [
      "window menu",
      (m: ComputerManager) =>
        m.invokeMenu("a", { windowId: window.id }, ["File", "New"], {
          userRequestedVisibleUse: true,
        }),
    ],
    ["visibility", (m: ComputerManager) => m.setAppVisibility("a", 10, false)],
    ["minimize", (m: ComputerManager) => m.setWindowMinimized("a", window.id, true)],
    [
      "move",
      (m: ComputerManager) =>
        m.setWindowFrame("a", window.id, { x: 0, y: 0, width: 300, height: 200 }),
    ],
    ["kill", (m: ComputerManager) => m.killApp("a", window.id)],
  ] as const)(
    "refuses %s before native dispatch, even with visible-use consent",
    async (_name, action) => {
      const { manager, backend } = await setup();
      await expect(action(manager)).rejects.toMatchObject({
        code: "computer_space_operation_unsupported",
      });
      for (const method of [
        "raiseWindow",
        "launchApp",
        "invokeMenu",
        "setAppVisibility",
        "setWindowMinimized",
        "setWindowFrame",
        "killApp",
      ])
        expect(backend.callsFor(method)).toHaveLength(0);
    },
  );

  it("rejects unbound keys and coordinates before input", async () => {
    const { manager, backend } = await setup();
    await expect(manager.pressKey("a", "Tab")).rejects.toMatchObject({
      code: "computer_space_window_not_selected",
    });
    await expect(manager.click("a", { x: 5, y: 5 })).rejects.toMatchObject({
      code: "computer_space_window_not_selected",
    });
    expect(backend.callsFor("pressKey")).toHaveLength(0);
    expect(backend.callsFor("click")).toHaveLength(0);
  });

  it("generic foreground excursions refuse before the action or restore can run", async () => {
    const { manager, backend } = await setup();
    const action = vi.fn(async () => "changed");
    await expect(
      manager.withForegroundRestore("a", action, { userRequestedVisibleUse: true }),
    ).rejects.toMatchObject({ code: "computer_space_operation_unsupported" });
    expect(action).not.toHaveBeenCalled();
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
  });

  it("visible browser launch refuses while isolated headless preparation remains separate", async () => {
    const { manager, backend } = await setup();
    await expect(
      manager.browserCall(
        "a",
        undefined,
        "browser_prepare",
        { allow_launch: true, windowed: true },
        undefined,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "computer_space_operation_unsupported" });
    expect(backend.callsFor("browser.call")).toHaveLength(0);
    await expect(
      manager.browserCall("a", undefined, "browser_prepare", {
        allow_launch: true,
        windowed: false,
      }),
    ).resolves.toBeDefined();
  });

  it("matching turn release, removal and disposal clear only task bookkeeping", async () => {
    const { manager, backend } = await setup();
    manager.spaceBroker.release("a");
    const owner = { threadId: "a", turnId: "turn-a" };
    await withComputerTask({ threadId: "a", turnId: "turn-a" }, () =>
      manager.spaceBroker.reserve(owner, 2, [2]),
    );
    await manager.releaseDesktopControl("a", "old-turn");
    expect(manager.spaceBroker.reservationFor(owner)).not.toBeNull();
    await manager.releaseDesktopControl("a", "turn-a");
    expect(manager.spaceBroker.reservationFor(owner)).toBeNull();
    await manager.spaceBroker.reserve(owner, 2, [2]);
    await manager.handleThreadRemoved("a");
    expect(manager.spaceBroker.reservationFor(owner)).toBeNull();
    expect(backend.callsFor("raiseWindow")).toHaveLength(0);
  });
});
