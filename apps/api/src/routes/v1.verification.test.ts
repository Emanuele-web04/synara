import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { IdentityProviderError } from "../identity/interfaces";
import { createWorkosIdentityProvider } from "../identity/workos";
import { startFakeWorkos, type FakeWorkos } from "../testing/fakeWorkos";
import { createV1Routes } from "./v1";

describe("access-token verification failures", () => {
  let workos: FakeWorkos;
  beforeAll(async () => {
    workos = await startFakeWorkos();
  });
  afterAll(async () => workos.close());
  afterEach(() => vi.restoreAllMocks());

  it.each(["discovery", "keys", "expired", "ambiguous-key"] as const)(
    "keeps a %s failure distinct from an invalid session",
    async (failure) => {
      const { verifier } = createWorkosIdentityProvider(
        workos.config(
          failure === "discovery"
            ? { workosApiUrl: `${workos.origin}/unavailable` }
            : failure === "keys"
              ? { workosIssuer: workos.issuer, workosJwksUrl: `${workos.origin}/unavailable` }
              : {},
        ),
      );
      const token = await workos.signAccessToken({
        sub: "user_verification",
        sid: "session_verification",
        ...(failure === "expired" ? { expiresIn: "-1s" } : {}),
      });
      if (failure === "ambiguous-key") {
        const fetch = globalThis.fetch;
        vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
          const response = await fetch(...args);
          if (!String(args[0]).includes("/sso/jwks/")) return response;
          const { keys } = (await response.json()) as { keys: unknown[] };
          return Response.json({ keys: [...keys, ...keys] });
        });
      }
      const onError = vi.fn(
        (_error: Error) => new Response("Service unavailable", { status: 500 }),
      );
      const app = new Hono().onError(onError).route(
        "/api/v1",
        // Rejected verification ends before any database access.
        createV1Routes({ verifier } as unknown as Parameters<typeof createV1Routes>[0]),
      );
      const response = await app.request("/api/v1/me", {
        headers: { authorization: `Bearer ${token}` },
      });

      if (failure === "expired" || failure === "ambiguous-key") {
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ error: "unauthorized" });
        expect(onError).not.toHaveBeenCalled();
      } else {
        expect(response.status).toBe(500);
        expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(IdentityProviderError);
        expect(await response.text()).not.toContain(token);
      }
    },
  );
});
