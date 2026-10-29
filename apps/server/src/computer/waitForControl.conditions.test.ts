import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComputerState, ComputerUiNode } from "@synara/contracts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { waitForControl } from "./waitForControl.ts";

vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn() }));
const target = { windowId: "fake-calculator", label: "Display" };
const withValue = (state: ComputerState, value: string | null): ComputerState => {
  const visit = (node: ComputerUiNode): ComputerUiNode => ({
    ...node,
    ...(node.label === target.label ? { value } : {}),
    children: node.children.map(visit),
  });
  return { ...state, root: visit(state.root!) };
};

function clock() {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.mocked(delay).mockImplementation(async (ms = 0) => {
    now += ms;
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("evidence-based control waits", () => {
  it.each(["root", "nested"])(
    "never proves absence using a truncated %s branch",
    async (location) => {
      const state = await new FakeComputerBackend().getState({ includeTree: true });
      const incomplete =
        location === "root"
          ? { ...state.root!, truncated: true, children: [] }
          : { ...state.root!, children: [{ ...state.root!, truncated: true, children: [] }] };
      const read = vi.fn().mockResolvedValue({ ...state, root: incomplete });
      expect(
        await waitForControl(read, { ...target, label: "Missing" }, 5000, undefined, {
          absent: true,
        }),
      ).toMatchObject({ status: "unavailable", checks: 1 });
      expect(delay).not.toHaveBeenCalled();
    },
  );

  it("waits for the exact value rather than mere field presence", async () => {
    clock();
    const state = await new FakeComputerBackend().getState({ includeTree: true });
    const read = vi
      .fn()
      .mockResolvedValueOnce(withValue(state, "saving"))
      .mockResolvedValue(withValue(state, "saved"));
    expect(
      await waitForControl(read, target, 1000, undefined, { valueEquals: "saved" }),
    ).toMatchObject({ status: "ready", checks: 2, waitedMs: 100 });
  });

  it("supports empty values but refuses unreadable values", async () => {
    const state = await new FakeComputerBackend().getState({ includeTree: true });
    expect(
      await waitForControl(async () => withValue(state, ""), target, 0, undefined, {
        valueEquals: "",
      }),
    ).toMatchObject({ status: "ready" });
    expect(
      await waitForControl(async () => withValue(state, null), target, 0, undefined, {
        valueEquals: "",
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("resets the stability interval when the condition ceases to hold", async () => {
    clock();
    const state = await new FakeComputerBackend().getState({ includeTree: true });
    const read = vi
      .fn()
      .mockResolvedValueOnce(withValue(state, "done"))
      .mockResolvedValueOnce(withValue(state, "busy"))
      .mockResolvedValue(withValue(state, "done"));
    expect(
      await waitForControl(read, target, 2000, undefined, { valueEquals: "done", stableMs: 300 }),
    ).toMatchObject({ status: "ready", checks: 4, waitedMs: 600 });
  });

  it("backs off polling within the deadline instead of repeatedly sampling at 100ms", async () => {
    clock();
    const state = await new FakeComputerBackend().getState({ includeTree: true });
    const read = vi.fn().mockResolvedValue(state);
    expect(await waitForControl(read, { ...target, label: "Missing" }, 2000)).toMatchObject({
      status: "timeout",
      checks: 7,
      waitedMs: 2000,
    });
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([100, 200, 400, 500, 500, 300]);
  });

  it("cancels without another observation", async () => {
    clock();
    const controller = new AbortController();
    vi.mocked(delay).mockImplementation(async () => {
      controller.abort();
    });
    const state = await new FakeComputerBackend().getState({ includeTree: true });
    const read = vi.fn().mockResolvedValue(state);
    await expect(
      waitForControl(read, { ...target, label: "Missing" }, 1000, controller.signal),
    ).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([{ absent: true, valueEquals: "x" }, { stableMs: -1 }, { stableMs: 101 }])(
    "rejects contradictory or unbounded conditions before reading: %j",
    async (options) => {
      const read = vi.fn();
      await expect(waitForControl(read, target, 100, undefined, options)).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
    },
  );
});
