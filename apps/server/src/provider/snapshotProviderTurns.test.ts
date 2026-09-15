import { TurnId } from "@synara/contracts";
import { expect, it } from "vitest";
import { snapshotProviderTurns } from "./snapshotProviderTurns.ts";

it("preserves returned history across append, item replacement and rollback", () => {
  const first = { id: TurnId.makeUnsafe("first"), items: [{ text: "first output" }] };
  const history = [first];
  const snapshot = snapshotProviderTurns(history);
  first.items[0] = { text: "replacement" };
  history.push({ id: TurnId.makeUnsafe("second"), items: [{ text: "second output" }] });
  const beforeRollback = snapshotProviderTurns(history);
  history.splice(1);
  expect(snapshot).toEqual([{ id: "first", items: [{ text: "first output" }] }]);
  expect(beforeRollback).toHaveLength(2);
});
