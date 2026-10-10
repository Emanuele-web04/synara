import { describe, expect, it } from "vitest";

import { canForkThread } from "./threadFork";

type ForkCandidate = Parameters<typeof canForkThread>[0]["thread"];

function threadWith(overrides: { parentThreadId?: string }, streaming: boolean): ForkCandidate {
  return {
    parentThreadId: null,
    sidechatSourceThreadId: null,
    sidechatContext: null,
    messages: [{ role: "assistant", streaming }],
    ...overrides,
  } as ForkCandidate;
}

const ordinary = { providerHandoff: true, workspaceHandoff: true };

describe("canForkThread", () => {
  it("offers fork once the thread has a settled message", () => {
    expect(canForkThread({ thread: threadWith({}, false), handoffAvailability: ordinary })).toBe(
      true,
    );
  });

  it("holds fork back while the only message is still streaming", () => {
    expect(canForkThread({ thread: threadWith({}, true), handoffAvailability: ordinary })).toBe(
      false,
    );
  });

  it("hides fork for threads without their own checkout", () => {
    expect(
      canForkThread({
        thread: threadWith({}, false),
        handoffAvailability: { providerHandoff: true, workspaceHandoff: false },
      }),
    ).toBe(false);
    expect(
      canForkThread({
        thread: threadWith({ parentThreadId: "parent" }, false),
        handoffAvailability: ordinary,
      }),
    ).toBe(false);
  });
});
