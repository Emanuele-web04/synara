import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { readBridgeConfig, readScene, saveScene, type CanvasBridgeConfig } from "./bridge";
import { applyElementOperations } from "./scene";

const MAX_INPUT_BYTES = 5 * 1024 * 1024;

export const CANVAS_AGENT_GUIDE = `# Synara Excalidraw tools

Always call read_scene before changing an existing drawing. Ask exactly one focused
clarifying question when a choice changes factual structure (for example TCP/IP
four-layer versus five-layer); choose sensible defaults for purely visual choices.
Use stable unique ids and preserve elements the user did not ask to change.

create_view accepts a JSON array string. Common elements use type, id, x, y, width,
height; rectangles may include label: {text, fontSize}; arrows use points and
endArrowhead. Use readable fonts (16+ body, 20+ headings), consistent directions,
pastel fills, and clear hierarchy. A delete pseudo-element uses
{"type":"delete","ids":"id1,id2"}. Changes are revision-checked and atomic.`;

function toolError(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

export function createServer(config: CanvasBridgeConfig = readBridgeConfig()): McpServer {
  const server = new McpServer({ name: "Synara Excalidraw", version: "0.3.2-synara.1" });
  const checkpoints = new Map<string, ReadonlyArray<Record<string, unknown>>>();

  server.registerTool(
    "read_me",
    {
      description: "Read the Synara Excalidraw scene and collaboration contract.",
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text", text: CANVAS_AGENT_GUIDE }] }),
  );

  server.registerTool(
    "read_scene",
    {
      description: "Read the current editable Excalidraw scene before modifying it.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const snapshot = await readScene(config);
        return {
          content: [{ type: "text", text: JSON.stringify(snapshot.scene) }],
          structuredContent: {
            revision: snapshot.revision,
            elementCount: snapshot.scene.elements.length,
          },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "create_view",
    {
      description: "Atomically apply editable Excalidraw element operations to the current drawing.",
      inputSchema: { elements: z.string().max(MAX_INPUT_BYTES) },
    },
    async ({ elements }) => {
      try {
        const operations = JSON.parse(elements) as unknown;
        if (
          !Array.isArray(operations) ||
          !operations.every(
            (entry) => entry && typeof entry === "object" && !Array.isArray(entry),
          )
        ) {
          throw new Error("elements must be a JSON array of Excalidraw element objects.");
        }
        const current = await readScene(config);
        const restoreOperation = operations.find(
          (entry) => (entry as Record<string, unknown>).type === "restoreCheckpoint",
        ) as Record<string, unknown> | undefined;
        const restoreCheckpointId = restoreOperation?.id;
        const restoredElements =
          typeof restoreCheckpointId === "string"
            ? checkpoints.get(restoreCheckpointId)
            : undefined;
        if (typeof restoreCheckpointId === "string" && !restoredElements) {
          throw new Error(`Checkpoint '${restoreCheckpointId}' is unavailable.`);
        }
        const scene = applyElementOperations(
          restoredElements ? { ...current.scene, elements: restoredElements } : current.scene,
          operations as Array<Record<string, unknown>>,
        );
        const saved = await saveScene(config, { scene, expectedRevision: current.revision });
        const checkpointId = randomUUID().replaceAll("-", "").slice(0, 18);
        checkpoints.set(checkpointId, saved.scene.elements);
        if (checkpoints.size > 100) checkpoints.delete(checkpoints.keys().next().value!);
        return {
          content: [
            {
              type: "text",
              text: `Drawing saved with ${saved.scene.elements.length} editable elements. Checkpoint: ${checkpointId}`,
            },
          ],
          structuredContent: {
            checkpointId,
            revision: saved.revision,
            elementCount: saved.scene.elements.length,
          },
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}
