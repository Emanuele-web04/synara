import { ThreadId } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import { changeComputerPermission } from "./changeComputerPermission";

it.each([true, false])(
  "keeps the displayed value pending confirmation for enabled=%s",
  async (enabled) => {
    let confirm!: () => void;
    const persist = vi.fn();
    const result = changeComputerPermission({
      threadId: ThreadId.makeUnsafe("persisted-idle-or-closed"),
      enabled,
      establishedThread: true,
      change: () =>
        new Promise<void>((resolve) => {
          confirm = resolve;
        }),
      persist,
    });
    expect(persist).not.toHaveBeenCalled();
    confirm();
    await result;
    expect(persist).toHaveBeenCalledWith("persisted-idle-or-closed", enabled);
  },
);

it("retains the preference after a stop failure", async () => {
  const persist = vi.fn();
  await expect(
    changeComputerPermission({
      threadId: ThreadId.makeUnsafe("thread"),
      enabled: false,
      establishedThread: true,
      change: async () => {
        throw new Error("stop failed");
      },
      persist,
    }),
  ).rejects.toThrow("stop failed");
  expect(persist).not.toHaveBeenCalled();
});

it("changes a local draft without a provider runtime", async () => {
  const change = vi.fn();
  const persist = vi.fn();
  await changeComputerPermission({
    threadId: ThreadId.makeUnsafe("draft"),
    enabled: false,
    establishedThread: false,
    change,
    persist,
  });
  expect(change).not.toHaveBeenCalled();
  expect(persist).toHaveBeenCalledWith("draft", false);
});
