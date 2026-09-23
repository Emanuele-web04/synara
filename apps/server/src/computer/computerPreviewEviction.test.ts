import { describe, expect, it, vi } from "vitest";

import { CuaComputerBackend } from "./CuaComputerBackend.ts";
import { withComputerTask } from "./computerTaskContext.ts";
import type { cuaRequest } from "@synara/shared/cuaDriverProtocol";

const BOUNDS = { x: 0, y: 0, width: 200, height: 100 };

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header);
  header.write("IHDR", 12);
  header.writeUInt32BE(400, 16);
  header.writeUInt32BE(200, 20);
  return header.toString("base64");
})();

function evictionFixture(): {
  backend: CuaComputerBackend;
  endTaskCalls: () => number;
} {
  const calls: Array<{ method?: string }> = [];
  const request = vi.fn(async (_endpoint: string, req: Record<string, unknown>) => {
    calls.push({ ...(typeof req.method === "string" ? { method: req.method } : {}) });
    if (req.name === "check_permissions")
      return {
        ok: true,
        result: { structuredContent: { accessibility: true, screen_recording: true } },
      };
    if (req.name === "list_windows")
      return {
        ok: true,
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
        result: { structuredContent: { width: 1000, height: 800, scale_factor: 2 } },
      };
    if (req.name === "get_window_state")
      return {
        ok: true,
        result: {
          structuredContent: {
            pid: 10,
            window_id: 20,
            window_bounds: BOUNDS,
            screenshot_frame_valid: true,
            elements: [],
          },
          content: [{ type: "image", mimeType: "image/png", data: PNG_HEADER }],
        },
      };
    return { ok: true, result: { structuredContent: {} } };
  }) as unknown as typeof cuaRequest;
  const backend = new CuaComputerBackend({ endpoint: "/evict", request });
  return { backend, endTaskCalls: () => calls.filter((call) => call.method === "end_task").length };
}

describe("computer preview task eviction", () => {
  it("a dispatching task survives flooding while idle tasks are evicted", async () => {
    const { backend, endTaskCalls } = evictionFixture();
    try {
      // Live task attaches first.
      await withComputerTask({ threadId: "evict-live", turnId: "turn-live" }, () =>
        backend.getState({ windowId: "cua:10:20", includeTree: true }),
      );
      // A live task re-dispatches often: flood the table with other tasks
      // while it keeps working. Recency refresh must keep it young; only
      // tasks that stopped dispatching may be evicted.
      for (let i = 0; i < 600; i++) {
        await withComputerTask({ threadId: `flood-${i}`, turnId: `turn-${i}` }, () =>
          backend.getState({ windowId: "cua:10:20", includeTree: true }),
        );
        if (i % 50 === 0) {
          await withComputerTask({ threadId: "evict-live", turnId: "turn-live" }, () =>
            backend.getState({ windowId: "cua:10:20", includeTree: true }),
          );
        }
      }
      // The live task still ends its preview: it was never evicted.
      await backend.endTask("evict-live", "turn-live");
      expect(endTaskCalls()).toBe(1);
      // A task that stopped dispatching early was evicted: ending it is silent.
      await backend.endTask("flood-0", "turn-0");
      expect(endTaskCalls()).toBe(1);
    } finally {
      await backend.dispose();
    }
  });
});
