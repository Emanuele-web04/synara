import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { waitForActionableTarget } from "./actionability";

const runtimeReturning = (value: unknown): BrowserAutomationVisibleRuntime => ({
  threadId: "thread-actionability" as BrowserAutomationVisibleRuntime["threadId"],
  tabId: "tab-actionability",
  webContents: {
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
      sendCommand: vi.fn(async (method: string) => {
        expect(method).toBe("Runtime.callFunctionOn");
        return { result: { value } };
      }),
    },
  } as unknown as WebContents,
});

describe("browser target actionability", () => {
  it("returns the stable hit-tested point and rect produced by the visible guest", async () => {
    const runtime = runtimeReturning({
      ok: true,
      target: {
        point: { x: 125, y: 72 },
        rect: { x: 100, y: 50, width: 50, height: 44 },
      },
    });

    await expect(
      waitForActionableTarget(runtime, "object-1", {
        editable: true,
        timeoutMs: 750,
      }),
    ).resolves.toEqual({
      ok: true,
      target: {
        point: { x: 125, y: 72 },
        rect: { x: 100, y: 50, width: 50, height: 44 },
      },
    });
  });

  it("preserves stale and bounded timeout diagnostics without inventing a target", async () => {
    await expect(
      waitForActionableTarget(
        runtimeReturning({
          ok: false,
          reason: "stale_ref",
          detail: "ref no longer resolves",
        }),
        "stale",
        {},
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "stale_ref",
      detail: "ref no longer resolves",
    });

    await expect(
      waitForActionableTarget(
        runtimeReturning({
          ok: false,
          reason: "timeout",
          detail: "covered",
        }),
        "covered",
        {},
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "timeout",
      detail: "covered",
    });
  });

  it("rejects malformed renderer values as a safe timeout", async () => {
    await expect(
      waitForActionableTarget(
        runtimeReturning({
          ok: true,
          target: { point: { x: Number.NaN, y: 1 } },
        }),
        "malformed",
        {},
      ),
    ).resolves.toEqual({
      ok: false,
      reason: "timeout",
      detail: "actionability result unavailable",
    });
  });
});
