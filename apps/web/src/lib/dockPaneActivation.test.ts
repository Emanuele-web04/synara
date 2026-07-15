import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  DOCK_PANE_DEFERRED_HYDRATION_FRAMES,
  dockPaneActivationKey,
  isDeferredRuntimePaneKind,
  isKeepMountedPaneKind,
  reconcileKeepMountedPaneIds,
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

  it("keeps stateful panes mounted across tab switches", () => {
    expect(isKeepMountedPaneKind("terminal")).toBe(true);
    expect(isKeepMountedPaneKind("explorer")).toBe(true);
    expect(isKeepMountedPaneKind("browser")).toBe(false);
    expect(isKeepMountedPaneKind("sidechat")).toBe(false);
    expect(isKeepMountedPaneKind("diff")).toBe(false);
    expect(isKeepMountedPaneKind("git")).toBe(false);
  });

  describe("reconcileKeepMountedPaneIds", () => {
    const panes = [
      { id: "term", kind: "terminal" as const },
      { id: "explorer", kind: "explorer" as const },
      { id: "diff", kind: "diff" as const },
    ];

    it("adds the active pane only when it is a keep-mounted kind", () => {
      expect([
        ...reconcileKeepMountedPaneIds({
          previous: new Set(),
          panes,
          activePaneId: "term",
          activePaneKind: "terminal",
        }),
      ]).toEqual(["term"]);

      expect([
        ...reconcileKeepMountedPaneIds({
          previous: new Set(),
          panes,
          activePaneId: "explorer",
          activePaneKind: "explorer",
        }),
      ]).toEqual(["explorer"]);

      expect([
        ...reconcileKeepMountedPaneIds({
          previous: new Set(),
          panes,
          activePaneId: "diff",
          activePaneKind: "diff",
        }),
      ]).toEqual([]);
    });

    it("retains previously mounted stateful panes after another tab becomes active", () => {
      const result = reconcileKeepMountedPaneIds({
        previous: new Set(["term", "explorer"]),
        panes,
        activePaneId: "diff",
        activePaneKind: "diff",
      });
      expect(result.has("term")).toBe(true);
      expect(result.has("explorer")).toBe(true);
    });

    it("drops kept ids that no longer exist (closed pane or thread switch)", () => {
      const result = reconcileKeepMountedPaneIds({
        previous: new Set(["term", "stale"]),
        panes: [{ id: "diff", kind: "diff" as const }],
        activePaneId: "diff",
        activePaneKind: "diff",
      });
      expect(result.has("term")).toBe(false);
      expect(result.has("stale")).toBe(false);
    });

    it("ignores an active id that is not in the live pane list", () => {
      const result = reconcileKeepMountedPaneIds({
        previous: new Set(),
        panes,
        activePaneId: "ghost",
        activePaneKind: "terminal",
      });
      expect(result.size).toBe(0);
    });
  });
});
