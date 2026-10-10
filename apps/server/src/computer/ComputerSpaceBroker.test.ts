import { describe, expect, it, vi } from "vitest";
import type { ComputerSpaceInventory, ComputerWindow } from "@synara/contracts";

import { ComputerSpaceBroker, type ComputerSpaceSnapshot } from "./ComputerSpaceBroker.ts";

const owner = { threadId: "a", turnId: "one" };
const other = { threadId: "b", turnId: "two" };
const window: ComputerWindow = {
  id: "cua:10:20",
  title: "Fixture",
  appName: "Fixture",
  pid: 10,
  focused: false,
  visible: false,
  minimized: false,
  spaceIds: [2],
  currentSpaceId: 1,
  onCurrentSpace: false,
};
function inventory(current = 1): ComputerSpaceInventory {
  return {
    source: "macos-managed-spaces",
    complete: true,
    spaces: [1, 2, 3].map((id) => ({
      id,
      uuid: `uuid-${id}`,
      displayId: "display-a",
      kind: "desktop",
      current: id === current,
    })),
  };
}
function setup() {
  let snapshot: ComputerSpaceSnapshot = { inventory: inventory(), windows: [window] };
  const read = vi.fn(async () => snapshot);
  const broker = new ComputerSpaceBroker({ readSnapshot: read, assertActive: () => {} });
  return {
    broker,
    read,
    set: (value: ComputerSpaceSnapshot) => {
      snapshot = value;
    },
    snapshot: () => snapshot,
  };
}
function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ComputerSpaceBroker", () => {
  it("lists native empty Spaces and reserves/selects without any desktop mutation", async () => {
    const { broker } = setup();
    expect((await broker.inspect()).inventory.spaces).toHaveLength(3);
    const reservation = await broker.reserve(owner, 2, [2], window.id);
    expect(reservation).toMatchObject({ spaceId: 2, selectedWindowId: window.id, selectedPid: 10 });
    await expect(broker.assertWindowAllowed(owner, window)).resolves.toBeUndefined();
    expect((await broker.inspect(3)).windows).toEqual([]);
  });

  it("requires user designation before reading or reserving", async () => {
    const { broker, read } = setup();
    await expect(broker.reserve(owner, 2, [], window.id)).rejects.toMatchObject({
      code: "computer_space_not_designated",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("refuses current, unproven and unsupported Space identities", async () => {
    const { broker, set } = setup();
    await expect(broker.reserve(owner, 1, [1])).rejects.toMatchObject({
      code: "computer_space_current",
    });
    for (const patch of [{ uuid: null }, { current: null }, { kind: "fullscreen" as const }]) {
      const value = inventory();
      set({
        inventory: {
          ...value,
          spaces: value.spaces.map((s) => (s.id === 2 ? { ...s, ...patch } : s)),
        },
        windows: [window],
      });
      await expect(broker.reserve(owner, 2, [2])).rejects.toMatchObject({
        code: "computer_space_identity_unproven",
      });
    }
  });

  it("excludes other tasks and requires one exact noncurrent window", async () => {
    const { broker, set } = setup();
    await broker.reserve(owner, 2, [2]);
    await expect(broker.reserve(other, 2, [2])).rejects.toMatchObject({
      code: "computer_space_reserved",
    });
    await expect(broker.assertWindowAllowed(other, window)).rejects.toMatchObject({
      code: "computer_space_reserved",
    });
    await expect(broker.assertWindowAllowed(owner, window)).rejects.toMatchObject({
      code: "computer_space_window_not_selected",
    });
    for (const candidate of [
      { ...window, spaceIds: [1, 2] },
      { ...window, onCurrentSpace: true },
      { ...window, spaceIds: [] },
    ]) {
      set({ inventory: inventory(), windows: [candidate] });
      await expect(broker.select(owner, candidate.id)).rejects.toMatchObject({
        code: "computer_space_target_membership_unproven",
      });
    }
  });

  it("invalidates on current-Space entry and does not silently resume after departure", async () => {
    const { broker, set } = setup();
    await broker.reserve(owner, 2, [2], window.id);
    set({ inventory: inventory(2), windows: [{ ...window, onCurrentSpace: true }] });
    await expect(broker.assertWindowAllowed(owner, window)).rejects.toMatchObject({
      code: "computer_space_current",
    });
    set({ inventory: inventory(), windows: [window] });
    await expect(broker.assertWindowAllowed(owner, window)).rejects.toMatchObject({
      code: "computer_space_current",
    });
    await broker.reserve(owner, 2, [2], window.id);
    await expect(broker.assertWindowAllowed(owner, window)).resolves.toBeUndefined();
  });

  it.each([{ uuid: "new-uuid" }, { displayId: "display-b" }])(
    "invalidates session-ID reuse or display churn: %j",
    async (patch) => {
      const { broker, set } = setup();
      await broker.reserve(owner, 2, [2], window.id);
      const value = inventory();
      set({
        inventory: {
          ...value,
          spaces: value.spaces.map((s) => (s.id === 2 ? { ...s, ...patch } : s)),
        },
        windows: [window],
      });
      await expect(broker.assertWindowAllowed(owner, window)).rejects.toMatchObject({
        code: "computer_space_reservation_changed",
      });
    },
  );

  it("rejects a replaced PID and a window moved out of the reservation", async () => {
    const { broker, set } = setup();
    await broker.reserve(owner, 2, [2], window.id);
    set({ inventory: inventory(), windows: [{ ...window, pid: 11 }] });
    await expect(broker.assertWindowAllowed(owner, window)).rejects.toMatchObject({
      code: "computer_space_window_not_selected",
    });
    set({ inventory: inventory(), windows: [{ ...window, spaceIds: [3] }] });
    await expect(broker.assertWindowAllowed(owner, window)).rejects.toMatchObject({
      code: "computer_space_target_outside_reservation",
    });
  });

  it("fences an old noncurrent read after a newer observation invalidates the reservation", async () => {
    const { broker, read, set, snapshot } = setup();
    await broker.reserve(owner, 2, [2], window.id);
    const oldSnapshot = snapshot();
    const gate = held<ComputerSpaceSnapshot>();
    read.mockImplementationOnce(() => gate.promise);
    const pending = broker.reserve(owner, 2, [2], window.id);
    const outcome = expect(pending).rejects.toMatchObject({
      code: "computer_space_reservation_changed",
    });
    set({ inventory: inventory(2), windows: [window] });
    await broker.inspect();
    gate.resolve(oldSnapshot);
    await outcome;
    expect(broker.reservationFor(owner)?.invalidReason).toBe("computer_space_current");
  });

  it("turn teardown fences pending replacement without releasing a different stored turn", async () => {
    const { broker, read, snapshot } = setup();
    await broker.reserve(owner, 2, [2], window.id);
    const gate = held<ComputerSpaceSnapshot>();
    read.mockImplementationOnce(() => gate.promise);
    const next = { ...owner, turnId: "next" };
    const pending = broker.reserve(next, 3, [3]);
    const outcome = expect(pending).rejects.toMatchObject({
      code: "computer_space_reservation_changed",
    });
    broker.release(owner.threadId, next.turnId);
    expect(broker.reservationFor(owner)).not.toBeNull();
    gate.resolve(snapshot());
    await outcome;
    broker.release(owner.threadId, owner.turnId);
    expect(broker.reservationFor(owner)).toBeNull();
  });

  it("disposal and latest user revocation prevent pending reservation commit", async () => {
    const { broker, read, snapshot } = setup();
    await expect(broker.reserve(owner, 2, [2], window.id, async () => false)).rejects.toMatchObject(
      { code: "computer_space_not_designated" },
    );
    const gate = held<ComputerSpaceSnapshot>();
    read.mockImplementationOnce(() => gate.promise);
    const pending = broker.reserve(owner, 2, [2]);
    const outcome = expect(pending).rejects.toMatchObject({
      code: "computer_space_reservation_changed",
    });
    broker.dispose();
    gate.resolve(snapshot());
    await outcome;
  });

  it("refuses native launch, app-wide changes and unscoped input while reserved", async () => {
    const { broker } = setup();
    await broker.reserve(owner, 2, [2], window.id);
    expect(() => broker.assertNativeLaunchAllowed(owner.threadId)).toThrowError(
      expect.objectContaining({ code: "computer_space_operation_unsupported" }),
    );
    expect(() => broker.assertNativeLaunchAllowed(other.threadId)).toThrowError(
      expect.objectContaining({ code: "computer_space_operation_unsupported" }),
    );
    expect(() => broker.assertTargetBound(owner.threadId, undefined)).toThrowError(
      expect.objectContaining({ code: "computer_space_window_not_selected" }),
    );
    await expect(broker.assertAppMutationAllowed(owner, 10)).rejects.toMatchObject({
      code: "computer_space_operation_unsupported",
    });
    await expect(broker.assertAppMutationAllowed(other, 10)).rejects.toMatchObject({
      code: "computer_space_reserved",
    });
  });

  it("does no inventory work on ordinary input when no task has a reservation", async () => {
    const { broker, read } = setup();
    await broker.assertWindowAllowed(owner, window);
    await broker.assertAppMutationAllowed(owner, 10);
    broker.assertNativeLaunchAllowed(owner.threadId);
    broker.assertTargetBound(owner.threadId, undefined);
    expect(read).not.toHaveBeenCalled();
  });

  it("ambiguous duplicate inventory cannot preserve a reservation", async () => {
    const { broker, set } = setup();
    await broker.reserve(owner, 2, [2], window.id);
    const value = inventory();
    set({
      inventory: { ...value, spaces: [...value.spaces, { ...value.spaces[1]!, current: true }] },
      windows: [window],
    });
    await expect(broker.assertWindowAllowed(owner, window)).rejects.toMatchObject({
      code: "computer_space_reservation_changed",
    });
  });
});
