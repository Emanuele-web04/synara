import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveRoutePanelBootstrap,
  resolveThreadPickerTitle,
  resolveToggledChatPanelPatch,
} from "./-chatThreadRoute.logic";

const TURN_ID = TurnId.makeUnsafe("turn-1");
const OTHER_TURN_ID = TurnId.makeUnsafe("turn-2");

describe("resolveThreadPickerTitle", () => {
  it("falls back to a stable untitled label", () => {
    expect(resolveThreadPickerTitle(null)).toBe("New chat");
    expect(resolveThreadPickerTitle("")).toBe("New chat");
  });

  it("preserves non-empty thread titles", () => {
    expect(resolveThreadPickerTitle("Bug bash")).toBe("Bug bash");
  });
});

describe("resolveRoutePanelBootstrap", () => {
  it("hydrates diff deep links exactly once per scope and search payload", () => {
    const first = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
        diffFilePath: "src/chat.tsx",
      },
      lastAppliedSearchKey: null,
    });

    expect(first.panelPatch).toEqual({
      panel: "diff",
      diffTurnId: TURN_ID,
      diffFilePath: "src/chat.tsx",
    });
    expect(first.nextAppliedSearchKey).toEqual(expect.any(String));

    const duplicate = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
        diffFilePath: "src/chat.tsx",
      },
      lastAppliedSearchKey: first.nextAppliedSearchKey,
    });

    expect(duplicate).toEqual({
      nextAppliedSearchKey: first.nextAppliedSearchKey,
      panelPatch: null,
    });
  });

  it("resets once route search params are stripped so the same deep link can replay", () => {
    const first = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
        diffFilePath: "src/chat.tsx",
      },
      lastAppliedSearchKey: null,
    });

    const cleared = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {},
      lastAppliedSearchKey: first.nextAppliedSearchKey,
    });

    expect(cleared).toEqual({
      nextAppliedSearchKey: null,
      panelPatch: null,
    });

    const replay = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
        diffFilePath: "src/chat.tsx",
      },
      lastAppliedSearchKey: cleared.nextAppliedSearchKey,
    });

    expect(replay.panelPatch).toEqual({
      panel: "diff",
      diffTurnId: TURN_ID,
      diffFilePath: "src/chat.tsx",
    });
  });

  it("reapplies the same deep link when the mounted thread scope changes", () => {
    const first = resolveRoutePanelBootstrap({
      scopeId: "thread-1",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
      },
      lastAppliedSearchKey: null,
    });

    const nextThread = resolveRoutePanelBootstrap({
      scopeId: "thread-2",
      search: {
        panel: "diff",
        diff: "1",
        diffTurnId: TURN_ID,
      },
      lastAppliedSearchKey: first.nextAppliedSearchKey,
    });

    expect(nextThread.panelPatch).toEqual({
      panel: "diff",
      diffTurnId: TURN_ID,
      diffFilePath: null,
    });
  });
});

describe("resolveToggledChatPanelPatch", () => {
  it("preserves the last diff target when switching from diff to browser", () => {
    expect(
      resolveToggledChatPanelPatch(
        {
          panel: "diff",
          diffTurnId: TURN_ID,
          diffFilePath: "src/chat.tsx",
        },
        "browser",
      ),
    ).toEqual({
      panel: "browser",
      diffTurnId: TURN_ID,
      diffFilePath: "src/chat.tsx",
    });
  });

  it("keeps diff context even when closing the browser panel", () => {
    expect(
      resolveToggledChatPanelPatch(
        {
          panel: "browser",
          diffTurnId: OTHER_TURN_ID,
          diffFilePath: "src/browser.tsx",
        },
        "browser",
      ),
    ).toEqual({
      panel: null,
      diffTurnId: OTHER_TURN_ID,
      diffFilePath: "src/browser.tsx",
    });
  });
});
