import http from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { ExternalMcpGateway } from "./Services/ExternalMcpGateway.ts";
import { ExternalMcpService } from "./Services/ExternalMcpService.ts";
import { EXTERNAL_MCP_MAX_BODY_BYTES, externalMcpRouteLayer } from "./httpRoute.ts";

const EXTERNAL_TOKEN = "syn_mcp_v1_external-route-test";

async function withExternalMcpServer(
  input: { readonly host?: string; readonly publicUrl?: URL },
  run: (input: {
    readonly origin: string;
    readonly handledBodies: ReadonlyArray<unknown>;
  }) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  const handledBodies: unknown[] = [];
  let nodeServer: http.Server | null = null;
  try {
    const verified = {
      integration: {
        integrationId: "integration-route-test",
        name: "Route test",
        audience: "synara.external-mcp",
        credentialHash: "hash-only",
        capabilities: ["projects:read"],
        projectIds: ["project-route-test"],
        createdAt: "2026-07-20T00:00:00.000Z",
        expiresAt: "2026-08-20T00:00:00.000Z",
        lastUsedAt: null,
        pairedAt: "2026-07-20T00:00:00.000Z",
        revokedAt: null,
        rateLimitPerMinute: 60,
        concurrencyLimit: 2,
      },
      capabilities: new Set(["projects:read"]),
      allowedProjectIds: new Set(["project-route-test"]),
    } as never;
    const service = {
      verifyCredential: (credential: string) =>
        credential === EXTERNAL_TOKEN
          ? Effect.succeed(verified)
          : Effect.fail({ code: "external_credential_invalid", message: "invalid", status: 401 }),
      listIntegrations: () => Effect.succeed([]),
      createIntegration: () => Effect.die("not used"),
      revokeIntegration: () => Effect.succeed(false),
      pair: () => Effect.die("not used"),
      assertActive: () => Effect.succeed(verified),
      assertProject: () => Effect.void,
      assertTaskRead: () => Effect.void,
      beginAudit: () => Effect.succeed("audit-route-test"),
      finishAudit: () => Effect.void,
    } as never;
    const gateway = {
      handlePost: (request: { readonly body: unknown }) => {
        handledBodies.push(request.body);
        return Effect.succeed({ status: 200, body: { ok: true } });
      },
      handleVerifiedPost: (request: { readonly body: unknown }) => {
        handledBodies.push(request.body);
        return Effect.succeed({ status: 200, body: { ok: true } });
      },
    } as never;
    const auth = {
      authenticateHttpRequest: () =>
        Effect.succeed({
          sessionId: "owner-session",
          subject: "owner",
          method: "bootstrap",
          role: "owner",
          credentialSource: "cookie",
        }),
    } as never;

    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(externalMcpRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(ExternalMcpService, service),
              Layer.succeed(ExternalMcpGateway, gateway),
              Layer.succeed(ServerAuth, auth),
              Layer.succeed(ServerConfig, {
                host: input.host ?? "127.0.0.1",
                publicUrl: input.publicUrl,
              } as never),
              NodeServices.layer,
            ),
          ),
        ),
        scope,
      ),
    );

    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Missing test server address");
    await run({ origin: `http://127.0.0.1:${address.port}`, handledBodies });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("externalMcpRouteLayer", () => {
  it("rejects non-external tokens before reading the body and enforces its smaller limit", async () => {
    await withExternalMcpServer({}, async ({ origin, handledBodies }) => {
      const oversizedBody = "x".repeat(EXTERNAL_MCP_MAX_BODY_BYTES + 1);
      const providerToken = await fetch(`${origin}/mcp/external`, {
        method: "POST",
        headers: { Authorization: "Bearer sagw_session_provider-token" },
        body: oversizedBody,
      });
      expect(providerToken.status).toBe(401);

      const oversized = await fetch(`${origin}/mcp/external`, {
        method: "POST",
        headers: { Authorization: `Bearer ${EXTERNAL_TOKEN}` },
        body: oversizedBody,
      });
      expect(oversized.status).toBe(413);
      expect(handledBodies).toHaveLength(0);

      const body = { jsonrpc: "2.0", id: 1, method: "ping" };
      const valid = await fetch(`${origin}/mcp/external`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${EXTERNAL_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(valid.status).toBe(200);
      expect(handledBodies).toEqual([body]);
    });
  });

  it("does not expose the external endpoint from a remotely bound instance", async () => {
    await withExternalMcpServer({ host: "0.0.0.0" }, async ({ origin, handledBodies }) => {
      const response = await fetch(`${origin}/mcp/external`, {
        method: "POST",
        headers: { Authorization: `Bearer ${EXTERNAL_TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(response.status).toBe(404);
      expect(handledBodies).toHaveLength(0);
    });
  });
});
