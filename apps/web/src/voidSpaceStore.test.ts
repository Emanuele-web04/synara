import { SPACE_NAME_MAX_LENGTH } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_VOID_SPACE } from "~/lib/spaceGrouping";
import { normalizeVoidSpace, useVoidSpaceStore } from "./voidSpaceStore";

const STORAGE_KEY = "synara:void-space:v1";

describe("voidSpaceStore", () => {
  let entries: Map<string, string>;

  beforeEach(() => {
    entries = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => entries.get(key) ?? null,
        setItem: (key: string, value: string) => entries.set(key, value),
        removeItem: (key: string) => entries.delete(key),
      },
    });
    useVoidSpaceStore.setState({ voidSpace: DEFAULT_VOID_SPACE });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("renders something safe for any persisted shape", () => {
    expect(normalizeVoidSpace(null)).toEqual(DEFAULT_VOID_SPACE);
    expect(normalizeVoidSpace({ name: "   ", icon: "not-an-icon" })).toEqual(DEFAULT_VOID_SPACE);
    expect(normalizeVoidSpace({ name: "  Inbox  ", icon: "bag" })).toEqual({
      name: "Inbox",
      icon: "bag",
    });
    expect(normalizeVoidSpace({ name: "x".repeat(SPACE_NAME_MAX_LENGTH + 10) }).name).toHaveLength(
      SPACE_NAME_MAX_LENGTH,
    );
  });

  it("patches one field at a time and persists the result", () => {
    useVoidSpaceStore.getState().setVoidSpace({ name: "Da ordinare" });
    useVoidSpaceStore.getState().setVoidSpace({ icon: "bag" });

    expect(useVoidSpaceStore.getState().voidSpace).toEqual({ name: "Da ordinare", icon: "bag" });
    expect(JSON.parse(entries.get(STORAGE_KEY) ?? "null")).toEqual({
      name: "Da ordinare",
      icon: "bag",
    });
  });

  it("keeps the default as an absent key so it can still follow the product", () => {
    useVoidSpaceStore.getState().setVoidSpace({ name: "Da ordinare", icon: "bag" });
    expect(entries.has(STORAGE_KEY)).toBe(true);

    useVoidSpaceStore.getState().resetVoidSpace();

    expect(useVoidSpaceStore.getState().voidSpace).toEqual(DEFAULT_VOID_SPACE);
    expect(entries.has(STORAGE_KEY)).toBe(false);
  });

  it("ignores an edit that changes nothing", () => {
    const before = useVoidSpaceStore.getState().voidSpace;

    useVoidSpaceStore.getState().setVoidSpace({ name: DEFAULT_VOID_SPACE.name });

    expect(useVoidSpaceStore.getState().voidSpace).toBe(before);
    expect(entries.has(STORAGE_KEY)).toBe(false);
  });
});
