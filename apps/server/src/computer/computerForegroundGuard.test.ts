import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ComputerApprovalGate } from "./ComputerApprovalGate.ts";
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

interface GuardControls {
  /** Answer readiness with a native auth-sheet refusal. */
  refuseReadinessAsAuthSheet: () => void;
  /** Answer keyboard input with a native refusal under `code`. */
  refuseInput: (code: string) => void;
}

/** Scripted Cua stub: no Fake — Fake enforces no delivery mode or sheet state. */
function guardFixture(): {
  backend: CuaComputerBackend;
  calls: Array<{ name?: string }>;
  controls: GuardControls;
} {
  const calls: Array<{ name?: string }> = [];
  let readinessRefusal: Record<string, unknown> | undefined;
  let inputRefusal: { code: string } | undefined;
  const respond = (req: Record<string, unknown>) => {
    calls.push({ ...(typeof req.name === "string" ? { name: req.name } : {}) });
    const method = req.method as string | undefined;
    if (method === "probe" || method === "stop") return { ok: true };
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
    if (req.name === "check_input_ready") {
      if (readinessRefusal)
        return {
          ok: true,
          result: { isError: true, structuredContent: readinessRefusal },
        };
      return {
        ok: true,
        result: { structuredContent: { ready: true, pid: 10, window_id: 20 } },
      };
    }
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
          content: [{ type: "image", mimeType: "image/png", data: PNG_400x200 }],
        },
      };
    if (req.name === "type_text" && inputRefusal)
      return {
        ok: true,
        result: {
          isError: true,
          structuredContent: {
            effect: "refused",
            code: inputRefusal.code,
            message: "The native operation could not complete.",
          },
          content: [{ type: "text", text: "No actuator ran." }],
        },
      };
    return { ok: true, result: { structuredContent: {} } };
  };
  // The real host identifies its platform on every reply. Direct input starts
  // with list_windows, so probe-only metadata does not describe this host yet.
  const request = vi.fn(async (_endpoint: string, req: Record<string, unknown>) => ({
    ...respond(req),
    hostPlatform: "darwin",
  })) as unknown as typeof cuaRequest;
  const backend = new CuaComputerBackend({ endpoint: "/foreground-guard", request });
  return {
    backend,
    calls,
    controls: {
      refuseReadinessAsAuthSheet: () => {
        readinessRefusal = {
          effect: "refused",
          code: "auth_sheet_focused",
          message: "An authentication sheet has focus.",
          pid: 10,
          window_id: 20,
        };
      },
      refuseInput: (code: string) => {
        inputRefusal = { code };
      },
    },
  };
}

describe("computer foreground guard", () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  beforeEach(() => {
    // The backend may run on Linux while its authenticated native host is macOS.
    Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platformDescriptor);
  });

  it("background never activates: raise is refused before any native call", async () => {
    const { backend, calls } = guardFixture();
    try {
      // Default delivery is background: activation is refused, not queued.
      await expect(backend.raiseWindow("cua:10:20")).rejects.toMatchObject({
        effect: "not-dispatched",
        code: "foreground_required",
      });
      expect(calls.filter((call) => call.name === "bring_to_front")).toHaveLength(0);
      expect(calls).toHaveLength(0);
    } finally {
      await backend.dispose();
    }
  });

  it("auth sheets never approve: input and readiness refuse without settling approvals", async () => {
    const { backend, calls, controls } = guardFixture();
    const gate = new ComputerApprovalGate();
    const threadId = "foreground-guard-thread";
    let promptId = "";
    const prompt = gate.request({
      threadId,
      signal: new AbortController().signal,
      publish: async (id, decision) => {
        if (decision === undefined) promptId = id;
      },
    });
    try {
      controls.refuseInput("auth_sheet_focused");
      await expect(backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
        effect: "not-dispatched",
        code: "auth_sheet_focused",
        inputPause: { windowId: "cua:10:20" },
      });
      // Observation stays available past the sheet; the pause is input-only.
      await expect(backend.getState({ windowId: "cua:10:20" })).resolves.toMatchObject({
        computerId: "desktop",
      });
      // Readiness surfaces the same code through the read-only path.
      controls.refuseReadinessAsAuthSheet();
      await expect(backend.checkInputReady("cua:10:20")).rejects.toMatchObject({
        effect: "not-dispatched",
        code: "auth_sheet_focused",
      });
      // Neither refusal approved, denied, or otherwise touched the live prompt.
      expect(promptId).not.toBe("");
      expect(gate.respond(threadId, promptId, "accept")).toBe(true);
      expect(await prompt).toBe(true);
      expect(calls.filter((call) => call.name === "bring_to_front")).toHaveLength(0);
    } finally {
      await backend.dispose();
    }
  });

  it("secure input refuses keyboard delivery as not-dispatched without an input pause", async () => {
    const { backend, calls, controls } = guardFixture();
    try {
      controls.refuseInput("secure_input_active");
      await expect(backend.typeText("abc", "cua:10:20")).rejects.toMatchObject({
        effect: "not-dispatched",
        code: "secure_input_active",
      });
      const error = await backend.typeText("abc", "cua:10:20").catch((error) => error);
      expect(error.inputPause).toBeUndefined();
      expect(calls.filter((call) => call.name === "click")).toHaveLength(0);
    } finally {
      await backend.dispose();
    }
  });
});
