import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  DOCK_PANE_DEFERRED_HYDRATION_FRAMES,
  dockPaneActivationKey,
  isDeferredRuntimePaneKind,
  resolveDockPaneRuntimeMode,
} from "./dockPaneActivation";

describe("dockPaneActivation", () => {
  it("treats browser, sidechat, and terminal panes as deferred runtime panes", () => {
    expect(isDeferredRuntimePaneKind("browser")).toBe(true);
    expect(isDeferredRuntimePaneKind("sidechat")).toBe(true);
    expect(isDeferredRuntimePaneKind("terminal")).toBe(true);
    expect(isDeferredRuntimePaneKind("diff")).toBe(false);
    expect(isDeferredRuntimePaneKind("git")).toBe(false);
  });

  it("keeps light panes live even when restored from persisted state", () => {
    expect(resolveDockPaneRuntimeMode({ kind: "diff", reason: "restore", hydrated: false })).toBe(
      "live",
    );
    expect(resolveDockPaneRuntimeMode({ kind: "git", reason: "restore", hydrated: false })).toBe(
      "live",
    );
  });

  it("previews restored heavy panes until they are hydrated", () => {
    expect(
      resolveDockPaneRuntimeMode({ kind: "browser", reason: "restore", hydrated: false }),
    ).toBe("preview");
    expect(resolveDockPaneRuntimeMode({ kind: "browser", reason: "restore", hydrated: true })).toBe(
      "live",
    );
  });

  it("hydrates heavy panes immediately after explicit user actions", () => {
    expect(
      resolveDockPaneRuntimeMode({ kind: "browser", reason: "explicit", hydrated: false }),
    ).toBe("live");
    expect(
      resolveDockPaneRuntimeMode({ kind: "sidechat", reason: "explicit", hydrated: false }),
    ).toBe("live");
  });

  it("builds a stable pane key scoped by host thread, pane id, and kind", () => {
    expect(
      dockPaneActivationKey({
        threadId: ThreadId.makeUnsafe("thread-1"),
        paneId: "pane-1",
        kind: "browser",
      }),
    ).toBe("thread-1\u0000pane-1\u0000browser");
  });

  it("uses two frames for restored heavy-pane hydration", () => {
    expect(DOCK_PANE_DEFERRED_HYDRATION_FRAMES).toBe(2);
  });
});
