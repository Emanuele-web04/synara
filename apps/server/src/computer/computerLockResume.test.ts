import { describe, expect, it, vi } from "vitest";

import { CuaComputerBackend } from "./CuaComputerBackend.ts";
import type { cuaRequest } from "@synara/shared/cuaDriverProtocol";

const PNG_400x200 = (() => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(400, 16);
  header.writeUInt32BE(200, 20);
  return header.toString("base64");
})();
const BOUNDS = { x: 0, y: 0, width: 200, height: 100 };

interface LockableControls {
  /** Bump the desktop generation, as a lock/resume does. */
  lock: () => void;
  /**
   * Run one OS interruption cycle: bump the generation AND the interruption
   * count, with `pauses` as the reasons still active at observation time —
   * `[]` models a lock that already released before the next reply.
   */
  interrupt: (pauses: string[]) => void;
  /** Lift every pause reason while keeping the interruption count. */
  resumeDesktop: () => void;
  /** Hold click replies until released, to straddle the lock. */
  holdClicks: () => void;
  releaseClicks: () => void;
}

/** Scripted Cua stub: no Fake — Fake enforces no epoch or grounding. */
function lockableFixture(): {
  backend: CuaComputerBackend;
  calls: Array<{ name?: string }>;
  controls: LockableControls;
} {
  const calls: Array<{ name?: string }> = [];
  let desktopEpoch = 0;
  let interruptions = 0;
  let pauses: string[] = [];
  let clickGate: Promise<void> | undefined;
  let releaseClick = () => {};
  const request = vi.fn(async (_endpoint: string, req: Record<string, unknown>) => {
    calls.push({ ...(typeof req.name === "string" ? { name: req.name } : {}) });
    const method = req.method as string | undefined;
    const state = () => ({
      // The simulated native host is macOS regardless of the CI runner OS.
      hostPlatform: "darwin",
      desktopEpoch,
      desktopInterruptions: interruptions,
      desktopPauses: pauses,
    });
    if (method === "probe" || method === "stop") return { ok: true, ...state() };
    // The host refuses every call while a pause is active.
    if (method === "call" && pauses.length > 0)
      return {
        ok: true,
        ...state(),
        result: {
          isError: true,
          structuredContent: {
            effect: "refused",
            code: "desktop_input_paused",
            message: "Desktop is locked.",
          },
        },
      };
    if (req.name === "check_permissions")
      return {
        ok: true,
        ...state(),
        result: { structuredContent: { accessibility: true, screen_recording: true } },
      };
    if (req.name === "list_windows")
      return {
        ok: true,
        ...state(),
        result: {
          structuredContent: {
            windows: [
              {
                pid: 10,
                window_id: 20,
                title: "Owned fixture",
                bounds: BOUNDS,
                is_on_screen: true,
                on_current_space: true,
                z_index: 1,
              },
            ],
          },
        },
      };
    if (req.name === "get_screen_size")
      return {
        ok: true,
        ...state(),
        result: { structuredContent: { width: 1000, height: 800, scale_factor: 2 } },
      };
    if (req.name === "check_input_ready")
      return {
        ok: true,
        ...state(),
        result: { structuredContent: { ready: true, pid: 10, window_id: 20 } },
      };
    if (req.name === "get_window_state")
      return {
        ok: true,
        ...state(),
        result: {
          structuredContent: {
            pid: 10,
            window_id: 20,
            window_bounds: BOUNDS,
            screenshot_frame_valid: true,
            elements: [],
          },
          content: [{ type: "image", mimeType: "image/png", data: PNG_400x200 }],
        },
      };
    if (req.name === "click") {
      if (clickGate) await clickGate;
      // The reply carries the generation current at delivery, not at dispatch.
      return {
        ok: true,
        ...state(),
        result: {
          structuredContent: {
            route: "synthetic_events",
            delivery: { mode: "background" },
            effect: "unverifiable",
          },
        },
      };
    }
    return { ok: true, ...state(), result: { structuredContent: {} } };
  }) as unknown as typeof cuaRequest;
  const backend = new CuaComputerBackend({ endpoint: "/lock-resume", request });
  return {
    backend,
    calls,
    controls: {
      lock: () => {
        desktopEpoch += 1;
      },
      interrupt: (active: string[]) => {
        desktopEpoch += 1;
        interruptions += 1;
        pauses = active;
      },
      resumeDesktop: () => {
        pauses = [];
      },
      holdClicks: () => {
        clickGate = new Promise<void>((resolve) => {
          releaseClick = resolve;
        });
      },
      releaseClicks: () => releaseClick(),
    },
  };
}

const clickCount = (calls: Array<{ name?: string }>) =>
  calls.filter((call) => call.name === "click").length;

describe("computer lock/resume", () => {
  it("refuses an in-flight reply that straddles a lock without replaying it", async () => {
    const { backend, calls, controls } = lockableFixture();
    try {
      await backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
      controls.holdClicks();
      const inFlight = backend.click({ x: 50, y: 50 }, "cua:10:20");
      await vi.waitFor(() => expect(calls.some((call) => call.name === "click")).toBe(true));
      // The desktop locks and resumes while the click is in flight; a metadata
      // read observes the new generation before the reply lands.
      controls.lock();
      await backend.checkInputReady("cua:10:20");
      controls.releaseClicks();
      await expect(inFlight).rejects.toMatchObject({
        effect: "dispatched-unknown",
        code: "stale_desktop_epoch",
      });
      // Uncertain delivery is never replayed automatically.
      expect(clickCount(calls)).toBe(1);
    } finally {
      await backend.dispose();
    }
  });

  it("requires a fresh observation after resume and never auto-resumes", async () => {
    const { backend, calls, controls } = lockableFixture();
    try {
      await backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
      controls.lock();
      // The resume invalidates the pre-lock grounding: stale, refused, nothing sent.
      await expect(backend.click({ x: 50, y: 50 }, "cua:10:20")).rejects.toMatchObject({
        effect: "not-dispatched",
        code: "stale_geometry",
      });
      expect(clickCount(calls)).toBe(0);
      // Read-only observation stays available but heals nothing: the next input
      // is still refused until a fresh observation re-grounds it.
      await expect(backend.getState({ windowId: "cua:10:20" })).resolves.toMatchObject({
        computerId: "desktop",
      });
      await expect(backend.click({ x: 50, y: 50 }, "cua:10:20")).rejects.toMatchObject({
        code: "stale_geometry",
      });
      expect(clickCount(calls)).toBe(0);
      // A fresh observation re-grounds, and only then does input flow again.
      await backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
      await expect(backend.click({ x: 50, y: 50 }, "cua:10:20")).resolves.toBeDefined();
      expect(clickCount(calls)).toBe(1);
    } finally {
      await backend.dispose();
    }
  });

  it("announces an interruption cycle once, even when it ended between replies", async () => {
    const { backend, controls } = lockableFixture();
    const events: Array<{ type: string; pauses?: readonly string[] }> = [];
    const unsubscribe = backend.onEvent((event) => {
      if (event.type === "desktop-interrupted") events.push(event);
    });
    try {
      await backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
      // The first observed count only sets the baseline: consent cannot
      // predate first contact, so nothing is announced.
      expect(events).toEqual([]);
      // A lock that engaged and released entirely between two replies still
      // advanced the count — the cycle is reported exactly once, with the
      // pauses already empty.
      controls.interrupt([]);
      await backend.checkInputReady("cua:10:20");
      expect(events).toEqual([{ type: "desktop-interrupted", pauses: [] }]);
      // A steady count reports nothing further.
      await backend.checkInputReady("cua:10:20");
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
      await backend.dispose();
    }
  });

  it("reports a still-active pause on the refusal reply it produces", async () => {
    const { backend, controls } = lockableFixture();
    const events: Array<{ type: string; pauses?: readonly string[] }> = [];
    const unsubscribe = backend.onEvent((event) => {
      if (event.type === "desktop-interrupted") events.push(event);
    });
    try {
      await backend.captureScreenshot({ kind: "window", windowId: "cua:10:20" });
      controls.interrupt(["screen-lock"]);
      // New admissions refuse while the desktop is locked, and the refusal
      // reply itself is what carries the interruption news.
      await expect(backend.checkInputReady("cua:10:20")).rejects.toMatchObject({
        effect: "not-dispatched",
        code: "computer_input_paused",
      });
      expect(events).toEqual([{ type: "desktop-interrupted", pauses: ["screen-lock"] }]);
      // The pause lifting changes no count — resume is not an interruption.
      controls.resumeDesktop();
      await backend.checkInputReady("cua:10:20");
      expect(events).toHaveLength(1);
    } finally {
      unsubscribe();
      await backend.dispose();
    }
  });
});
