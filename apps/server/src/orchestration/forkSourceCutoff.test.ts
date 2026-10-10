import { MessageId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { resolveForkSourceCutoff } from "./forkSourceCutoff.ts";

const message = (id: string, role: "user" | "assistant" | "system", turnId: string | null) => ({
  id: MessageId.makeUnsafe(id),
  role,
  turnId: turnId === null ? null : TurnId.makeUnsafe(turnId),
});

const twoTurns = [
  message("u1", "user", "t1"),
  message("a1", "assistant", "t1"),
  message("u2", "user", "t2"),
  message("a2", "assistant", "t2"),
];

describe("resolveForkSourceCutoff", () => {
  it("forks at the latest point when no message was chosen", () => {
    expect(resolveForkSourceCutoff({ throughMessageId: null, sourceMessages: twoTurns })).toEqual({
      kind: "latest",
    });
  });

  it("pins the chosen turn even when its message currently ends the source", () => {
    expect(
      resolveForkSourceCutoff({
        throughMessageId: MessageId.makeUnsafe("a2"),
        sourceMessages: [...twoTurns, message("s1", "system", null)],
      }),
    ).toEqual({ kind: "turn", turnId: TurnId.makeUnsafe("t2") });
  });

  it("stops native history at the chosen earlier turn", () => {
    expect(
      resolveForkSourceCutoff({
        throughMessageId: MessageId.makeUnsafe("a1"),
        sourceMessages: twoTurns,
      }),
    ).toEqual({ kind: "turn", turnId: TurnId.makeUnsafe("t1") });
  });

  it("refuses a native cut in the middle of a turn", () => {
    expect(
      resolveForkSourceCutoff({
        throughMessageId: MessageId.makeUnsafe("a1"),
        sourceMessages: [
          message("u1", "user", "t1"),
          message("a1", "assistant", "t1"),
          message("a1b", "assistant", "t1"),
        ],
      }).kind,
    ).toBe("unavailable");
  });

  it("refuses a native cut at an earlier message without a provider turn", () => {
    expect(
      resolveForkSourceCutoff({
        throughMessageId: MessageId.makeUnsafe("imported"),
        sourceMessages: [message("imported", "assistant", null), ...twoTurns],
      }).kind,
    ).toBe("unavailable");
  });

  it("refuses a native cut when the chosen message is gone", () => {
    expect(
      resolveForkSourceCutoff({
        throughMessageId: MessageId.makeUnsafe("missing"),
        sourceMessages: twoTurns,
      }).kind,
    ).toBe("unavailable");
    expect(
      resolveForkSourceCutoff({
        throughMessageId: MessageId.makeUnsafe("a1"),
        sourceMessages: undefined,
      }).kind,
    ).toBe("unavailable");
  });
});
