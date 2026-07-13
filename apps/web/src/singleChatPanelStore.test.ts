import { ThreadId, TurnId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSingleChatPanelState,
  sanitizePanelStateByThreadId,
  selectSingleChatPanelState,
  useSingleChatPanelStore,
} from "./singleChatPanelStore";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const TURN_ID = TurnId.makeUnsafe("turn-1");

describe("singleChatPanelStore", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    useSingleChatPanelStore.setState({ panelStateByThreadId: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps panel state scoped to the owning thread", () => {
    useSingleChatPanelStore.getState().setThreadPanelState(THREAD_A, {
      panel: "diff",
      diffTurnId: TURN_ID,
      hasOpenedPanel: true,
      lastOpenPanel: "diff",
    });
    useSingleChatPanelStore.getState().setThreadPanelState(THREAD_B, {
      panel: "browser",
      hasOpenedPanel: true,
    });

    expect(selectSingleChatPanelState(THREAD_A)(useSingleChatPanelStore.getState())).toMatchObject({
      panel: "diff",
      diffTurnId: TURN_ID,
      lastOpenPanel: "diff",
    });
    expect(selectSingleChatPanelState(THREAD_B)(useSingleChatPanelStore.getState())).toMatchObject({
      panel: "browser",
      diffTurnId: null,
      lastOpenPanel: "browser",
    });
  });

  it("returns the default closed state for threads without panel history", () => {
    expect(selectSingleChatPanelState(THREAD_A)(useSingleChatPanelStore.getState())).toEqual(
      createDefaultSingleChatPanelState(),
    );
  });

  it("reuses one fallback snapshot for threads without panel history", () => {
    const selector = selectSingleChatPanelState(THREAD_A);

    expect(selector(useSingleChatPanelStore.getState())).toBe(
      selector(useSingleChatPanelStore.getState()),
    );
  });
});

describe("sanitizePanelStateByThreadId", () => {
  it("returns an empty record for non-object input", () => {
    expect(sanitizePanelStateByThreadId(undefined)).toEqual({});
    expect(sanitizePanelStateByThreadId([{ panel: "diff" }])).toEqual({});
  });

  it("keeps valid entries and coerces unknown panel kinds to defaults", () => {
    const result = sanitizePanelStateByThreadId({
      "thread-a": {
        panel: "diff",
        diffTurnId: "turn-1",
        diffFilePath: "src/a.ts",
        hasOpenedPanel: true,
        lastOpenPanel: "diff",
      },
      "thread-b": {
        panel: "mystery",
        diffTurnId: 42,
        diffFilePath: null,
        hasOpenedPanel: "yes",
        lastOpenPanel: "also-bogus",
      },
    });

    expect(result["thread-a"]).toEqual({
      panel: "diff",
      diffTurnId: "turn-1",
      diffFilePath: "src/a.ts",
      hasOpenedPanel: true,
      lastOpenPanel: "diff",
    });
    expect(result["thread-b"]).toEqual({
      panel: null,
      diffTurnId: null,
      diffFilePath: null,
      hasOpenedPanel: false,
      lastOpenPanel: "browser",
    });
  });

  it("drops entries that are not objects", () => {
    expect(sanitizePanelStateByThreadId({ "thread-a": "nope", "thread-b": null })).toEqual({});
  });
});
