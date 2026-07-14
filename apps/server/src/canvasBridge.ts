import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import type { CanvasDrawingRef } from "@synara/contracts";
import { MAX_CANVAS_SCENE_BYTES } from "@synara/shared/excalidrawScene";

import {
  CanvasDrawingConflictError,
  readCanvasDrawing,
  saveCanvasDrawing,
} from "./canvasDrawingFiles";

const CAPABILITY_TTL_MS = 12 * 60 * 60 * 1_000;
const MAX_CAPABILITIES = 256;
const MAX_BRIDGE_REQUEST_BYTES = MAX_CANVAS_SCENE_BYTES + 64 * 1024;

interface CanvasBridgeGrant extends CanvasDrawingRef {
  expiresAt: number;
}

const grants = new Map<string, CanvasBridgeGrant>();

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function pruneExpired(now = Date.now()): void {
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
  while (grants.size >= MAX_CAPABILITIES) {
    const oldest = grants.keys().next().value;
    if (oldest === undefined) break;
    grants.delete(oldest);
  }
}

export function issueCanvasBridgeCapability(
  input: CanvasDrawingRef,
): { readonly token: string; readonly expiresAt: number } {
  pruneExpired();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + CAPABILITY_TTL_MS;
  grants.set(tokenKey(token), { ...input, expiresAt });
  return { token, expiresAt };
}

export function revokeCanvasBridgeCapability(token: string): void {
  grants.delete(tokenKey(token));
}

export function authorizeCanvasBridgeCapability(
  token: string,
  threadId: string,
): CanvasDrawingRef | null {
  const now = Date.now();
  pruneExpired(now);
  const grant = grants.get(tokenKey(token));
  if (!grant) return null;
  const left = Buffer.from(grant.threadId);
  const right = Buffer.from(threadId);
  if (left.byteLength !== right.byteLength || !timingSafeEqual(left, right)) return null;
  grant.expiresAt = now + CAPABILITY_TTL_MS;
  return { cwd: grant.cwd, threadId: grant.threadId };
}

export function resetCanvasBridgeCapabilitiesForTest(): void {
  grants.clear();
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readJsonBody(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteLength += buffer.byteLength;
    if (byteLength > MAX_BRIDGE_REQUEST_BYTES) {
      throw new RangeError("Canvas bridge request is too large.");
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

export interface CanvasBridgeServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

export function startCanvasBridgeServer(): Promise<CanvasBridgeServer> {
  return new Promise((resolve, reject) => {
    const server = createServer(async (request, response) => {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405).end("Method Not Allowed");
        return;
      }

      try {
        const payload = await readJsonBody(request);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          response.writeHead(400).end("Bad Request");
          return;
        }
        const record = payload as Record<string, unknown>;
        const threadId = typeof record.threadId === "string" ? record.threadId : "";
        const authorization = request.headers.authorization ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
        const drawing = authorizeCanvasBridgeCapability(token, threadId);
        if (!drawing) {
          response.writeHead(403).end("Forbidden");
          return;
        }

        if (request.url === "/internal/canvas/read") {
          sendJson(response, 200, await readCanvasDrawing(drawing));
          return;
        }
        if (request.url === "/internal/canvas/save") {
          if (typeof record.expectedRevision !== "string" || !record.scene) {
            response.writeHead(400).end("Bad Request");
            return;
          }
          sendJson(
            response,
            200,
            await saveCanvasDrawing({
              ...drawing,
              expectedRevision: record.expectedRevision,
              scene: record.scene as never,
            }),
          );
          return;
        }
        response.writeHead(404).end("Not Found");
      } catch (error) {
        if (response.headersSent) {
          response.end();
          return;
        }
        const status =
          error instanceof CanvasDrawingConflictError
            ? 409
            : error instanceof RangeError
              ? 413
              : error instanceof SyntaxError
                ? 400
                : 500;
        response.writeHead(status).end(
          error instanceof CanvasDrawingConflictError
            ? error.message
            : status === 413
              ? "Payload Too Large"
              : status === 400
                ? "Bad Request"
                : "Canvas bridge request failed",
        );
      }
    });

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Canvas bridge did not receive a TCP address."));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
      });
    });
  });
}
