import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  finishCodexResetAttempt,
  prepareCodexResetAttempt,
  readCodexResetAttempt,
} from "./codexResetAttempt";
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());
describe("Codex reset attempts", () => {
  it("keeps the same account/credit/key after uncertain results and remounts", () => {
    const first = prepareCodexResetAttempt("account-a", "credit-a");
    expect(readCodexResetAttempt("account-a")).toEqual(first);
    expect(prepareCodexResetAttempt("account-a", "credit-a")).toEqual(first);
    expect(() => prepareCodexResetAttempt("account-a", "credit-b")).toThrow("previous reset");
    expect(prepareCodexResetAttempt("account-b", "credit-a").idempotencyKey).not.toBe(
      first.idempotencyKey,
    );
  });
  it("supports count-only credits and starts a new attempt only after a terminal result", () => {
    const first = prepareCodexResetAttempt("account-a");
    expect(first.creditId).toBeUndefined();
    expect(prepareCodexResetAttempt("account-a")).toEqual(first);
    finishCodexResetAttempt(first);
    const second = prepareCodexResetAttempt("account-a");
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    finishCodexResetAttempt(first);
    expect(readCodexResetAttempt("account-a")).toEqual(second);
  });
  it("fails before submission when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage full");
      },
    });
    expect(() => prepareCodexResetAttempt("account-a")).toThrow("storage full");
  });
  it("does not silently replace a malformed persisted attempt", () => {
    localStorage.setItem(
      "synara:codex-reset-attempt:account-a",
      JSON.stringify({ accountId: "account-b", idempotencyKey: "old" }),
    );
    expect(() => prepareCodexResetAttempt("account-a")).toThrow("could not be read");
  });
});
