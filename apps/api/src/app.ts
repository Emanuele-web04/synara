import { createCloudflareClient } from "./remote/cloudflare";
import { createPairingRendezvous } from "./remote/pairing";
import { createTunnelCoordinator } from "./remote/tunnels";
import type { AccountErrorBody } from "@synara/contracts";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type pg from "pg";
import { createAvatarStorage } from "./avatarStorage";
import type { ApiConfig } from "./config";
import { createDb } from "./db";
import { createIdentityAdapters } from "./identity";
import type { IdentityAdapters } from "./identity/interfaces";
import { AVATAR_MAX_BYTES, createV1Routes } from "./routes/v1";

/**
 * The largest request body any JSON /api/v1 route accepts. Every JSON payload
 * this API takes is small structured data — an email address, a token, a
 * profile, a host record whose contract-level field bounds sum to a few tens
 * of KB — so 64 KB is comfortably above any honest request while stopping an
 * unauthenticated caller from making `c.req.json()` buffer megabytes before
 * schema validation ever runs. The middleware rejects both an oversized
 * `Content-Length` up front and a streaming body the moment it crosses the
 * limit. The one binary route — the avatar upload — gets its own, larger
 * limit below, aligned with the route's own byte cap.
 */
export const API_MAX_BODY_BYTES = 64 * 1024;

export async function createApp(
  config: ApiConfig,
  dependencies: { createTunnels?: typeof createTunnelCoordinator } = {},
): Promise<{
  app: Hono;
  identity: IdentityAdapters;
  pool: pg.Pool;
  tunnels?: ReturnType<typeof createTunnelCoordinator>;
  cleanup: () => Promise<void>;
}> {
  const { db, pool } = createDb(config.databaseUrl);
  const identity = await createIdentityAdapters(config, db);

  const tunnels = config.cloudflareTunnel
    ? (dependencies.createTunnels ?? createTunnelCoordinator)(
        db,
        createCloudflareClient(config.cloudflareTunnel),
        config.cloudflareTunnel.domain,
      )
    : undefined;
  const app = new Hono();

  // Before the routes, so no handler ever parses an oversized body. 413 in
  // the documented error shape: `validation_failed` because the cure is the
  // caller's (shrink the request), and the client already renders that code.
  const oversizedBody = (c: Context) => {
    const body: AccountErrorBody = {
      error: "validation_failed",
      message: "Request body is too large",
    };
    return c.json(body, 413);
  };
  // The avatar upload is the one binary route and legitimately exceeds the
  // JSON cap. Its transport limit sits ABOVE the route's own AVATAR_MAX_BYTES
  // so the documented cap answers as the route's 400 (with the actionable
  // message), and this middleware only stops grossly oversized streams.
  app.use(
    "/api/v1/profile/avatar",
    bodyLimit({ maxSize: AVATAR_MAX_BYTES + API_MAX_BODY_BYTES, onError: oversizedBody }),
  );
  app.use("/api/*", async (c, next) =>
    c.req.path === "/api/v1/profile/avatar"
      ? next()
      : bodyLimit({ maxSize: API_MAX_BODY_BYTES, onError: oversizedBody })(c, next),
  );

  app.route(
    "/api/v1",
    createV1Routes({
      ...(tunnels ? { tunnels } : {}),
      ...(config.remoteTestUserIds ? { remoteTestUserIds: config.remoteTestUserIds } : {}),
      verifier: identity.verifier,
      grants: identity.grants,
      signing: identity.signing,
      hostKeys: identity.hostKeys,
      devices: identity.devices,
      hostGrants: identity.hostGrants,
      hostSecrets: identity.hostSecrets,
      accountBaseUrl: config.baseUrl,
      apiIssuer: config.apiPublicUrl,
      db,
      ...(config.avatarStorage ? { avatarStorage: createAvatarStorage(config.avatarStorage) } : {}),
      trustedProxyHops: config.trustedProxyHops,
      ...(config.profileProxySecret ? { profileProxySecret: config.profileProxySecret } : {}),
    }),
  );
  // Older relay clients fail closed; there is no internal revocation feed.
  app.get("/internal/revocations", (c) =>
    c.json(
      { error: "unauthorized", message: "Relay service token invalid" } satisfies AccountErrorBody,
      401,
    ),
  );

  /**
   * Safety net: any unhandled throw under an API route still answers with an
   * AccountErrorBody. Without this Hono emits plain-text "Internal Server
   * Error", so a client parsing the documented JSON shape fails on exactly the
   * responses it most needs to read. Non-API paths keep the default handler.
   */
  app.onError((error, c) => {
    if (!c.req.path.startsWith("/api/") && !c.req.path.startsWith("/internal/")) throw error;
    // Database errors can embed SQL parameters (including rendezvous secrets).
    console.error(`[api] unhandled error on ${c.req.method} ${c.req.routePath}`);
    const body: AccountErrorBody = {
      error: "internal_error",
      message: "Something went wrong handling this request",
    };
    return c.json(body, 500);
  });

  /**
   * This service is an API and nothing else — there is no auth ceremony UI to
   * serve: email-code sign-in happens in the app, and SSO finishes on the
   * identity provider's own hosted page. A human who reaches the root (or any
   * other non-API path) gets a sentence telling them where they are rather
   * than a 404 that reads like an outage.
   */
  app.notFound((c) => {
    if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/internal/")) {
      const body: AccountErrorBody = { error: "validation_failed", message: "Unknown API route" };
      return c.json(body, 404);
    }
    return c.text(
      "Synara account API. Sign in from the Synara app. See https://github.com/Emanuele-web04/synara",
      200,
    );
  });

  return {
    app,
    identity,
    pool,
    ...(tunnels ? { tunnels } : {}),
    cleanup: async () => {
      await createPairingRendezvous(db, config.apiPublicUrl).cleanup();
      await tunnels?.cleanup();
    },
  };
}
