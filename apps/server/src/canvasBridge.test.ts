import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { EMPTY_CANVAS_SCENE } from "@synara/shared/excalidrawScene";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  authorizeCanvasBridgeCapability,
  issueCanvasBridgeCapability,
  resetCanvasBridgeCapabilitiesForTest,
  revokeCanvasBridgeCapability,
  startCanvasBridgeServer,
} from "./canvasBridge";
import { createCanvasDrawing } from "./canvasDrawingFiles";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(resetCanvasBridgeCapabilitiesForTest);

describe("canvas bridge capabilities", () => {
  it("binds a high-entropy token to one drawing", () => {
    const grant = issueCanvasBridgeCapability({ cwd: "/project", threadId: "drawing-1" });
    expect(grant.token.length).toBeGreaterThan(32);
    expect(authorizeCanvasBridgeCapability(grant.token, "drawing-1")).toEqual({
      cwd: "/project",
      threadId: "drawing-1",
    });
    expect(authorizeCanvasBridgeCapability(grant.token, "drawing-2")).toBeNull();
  });

  it("rejects a revoked capability", () => {
    const grant = issueCanvasBridgeCapability({ cwd: "/project", threadId: "drawing-1" });
    revokeCanvasBridgeCapability(grant.token);
    expect(authorizeCanvasBridgeCapability(grant.token, "drawing-1")).toBeNull();
  });

  it("serves capability-scoped drawings on an independent loopback listener", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "synara-canvas-bridge-"));
    roots.push(cwd);
    const snapshot = await createCanvasDrawing({ cwd, threadId: "drawing-loopback" });
    const grant = issueCanvasBridgeCapability({ cwd, threadId: "drawing-loopback" });
    const server = await startCanvasBridgeServer();
    try {
      const response = await fetch(`${server.baseUrl}/internal/canvas/read`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${grant.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ threadId: "drawing-loopback" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        revision: snapshot.revision,
        scene: EMPTY_CANVAS_SCENE,
      });
    } finally {
      await server.close();
    }
  });
});
