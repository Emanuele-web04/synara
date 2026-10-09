import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    constructor(
      _ctx: unknown,
      public env: unknown,
    ) {}
  },
}));

import worker, { AccountApi } from "./worker";

afterEach(() => vi.restoreAllMocks());

function setup() {
  const fetch = vi.fn(async (_request: Request) => new Response("upstream", { status: 201 }));
  const stub = {} as DurableObjectStub<AccountApi>;
  const getByName = vi.fn(() => Object.assign(stub, { fetch }));
  const namespace = {} as Cloudflare.Env["ACCOUNT_API"];
  const env = {
    ACCOUNT_BASE_URL: "https://synara-account-api-trial.synara-orgs.workers.dev",
    API_PUBLIC_URL: "https://synara-account-api-trial.synara-orgs.workers.dev/api/v1",
    DATABASE_URL: "postgres://test@localhost/test",
    WORKOS_API_KEY: "test",
    WORKOS_CLIENT_ID: "test",
    API_SIGNING_KEY: "test",
    ACCOUNT_API: Object.assign(namespace, { getByName }),
  } satisfies Cloudflare.Env;
  return { fetch, getByName, env };
}

describe("Cloudflare account API ingress", () => {
  it("preserves the body and auth while replacing a forged proxy chain", async () => {
    const { env, fetch, getByName } = setup();
    const response = await worker.fetch(
      new Request("https://api.example/api/v1/profile", {
        method: "PATCH",
        body: '{"displayName":"Test"}',
        headers: {
          authorization: "Bearer test-token",
          "cf-connecting-ip": "2001:db8::1",
          "x-forwarded-for": "forged, 192.0.2.1",
        },
      }),
      env,
    );
    expect(response.status).toBe(201);
    expect(getByName).toHaveBeenCalledWith("account-api");
    const forwarded = fetch.mock.calls[0]![0];
    expect(forwarded.method).toBe("PATCH");
    expect(forwarded.headers.get("authorization")).toBe("Bearer test-token");
    expect(forwarded.headers.get("x-forwarded-for")).toBe("2001:db8::1");
    expect(await forwarded.text()).toBe('{"displayName":"Test"}');
  });

  it.each([undefined, "invalid", "192.0.2.1, 192.0.2.2"])(
    "does not trust a supplied chain when the edge address is %s",
    async (ip) => {
      const { env, fetch } = setup();
      await worker.fetch(
        new Request("https://api.example/", {
          headers: { "x-forwarded-for": "forged", ...(ip ? { "cf-connecting-ip": ip } : {}) },
        }),
        env,
      );
      expect(fetch.mock.calls[0]![0].headers.has("x-forwarded-for")).toBe(false);
    },
  );

  it("returns a retryable error without exposing startup credentials", async () => {
    const { env, fetch } = setup();
    fetch.mockRejectedValue(new Error("postgres://secret@db"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await worker.fetch(new Request("https://api.example/"), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.text()).not.toContain("secret");
    expect(log).toHaveBeenCalledExactlyOnceWith("[account-api] Container unavailable");
  });

  it.each([
    ["relay-key", "2001:db8::7", "2001:db8::7"],
    ["forged", "2001:db8::7", "2a06:98c0:3600::103"],
    ["relay-key", "invalid", "2a06:98c0:3600::103"],
    ["rélaÿ-kéy", "2001:db8::7", "2a06:98c0:3600::103"],
  ])(
    "accepts the original client IP only from the authenticated relay (%s)",
    async (proof, ip, expected) => {
      const { env, fetch } = setup();
      await worker.fetch(
        new Request("https://api.example/api/v1/me", {
          headers: {
            "cf-connecting-ip": "2a06:98c0:3600::103",
            "x-synara-client-ip": ip,
            "x-synara-migration-secret": proof,
          },
        }),
        { ...env, MIGRATION_PROXY_SECRET: "relay-key" },
      );
      const forwarded = fetch.mock.calls[0]![0];
      expect(forwarded.headers.get("x-forwarded-for")).toBe(expected);
      expect(forwarded.headers.has("x-synara-migration-secret")).toBe(false);
      expect(forwarded.headers.has("x-synara-client-ip")).toBe(false);
    },
  );
});

describe("Cloudflare account API container configuration", () => {
  const ctx = {} as ConstructorParameters<typeof AccountApi>[0];

  it("enables managed tunnels and explicit enrollment through Worker bindings", () => {
    const { env } = setup();
    const container = new AccountApi(ctx, {
      ...env,
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_ZONE_ID: "b".repeat(32),
      CLOUDFLARE_API_TOKEN: "test-tunnel-token",
      CLOUDFLARE_TUNNEL_DOMAIN: "example.com",
      REMOTE_TEST_USER_IDS: "user_mini, user_macbook",
    });

    expect(container.envVars).toMatchObject({
      NODE_ENV: "production",
      IDENTITY_PROVIDER: "workos",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_ZONE_ID: "b".repeat(32),
      CLOUDFLARE_API_TOKEN: "test-tunnel-token",
      CLOUDFLARE_TUNNEL_DOMAIN: "example.com",
      REMOTE_TEST_USER_IDS: "user_mini, user_macbook",
    });
  });

  it("keeps remote access unconfigured and unrelated bindings out of the container", () => {
    const { env } = setup();
    const bindings = { ...env, MIGRATION_PROXY_SECRET: "worker-only-secret" };
    const container = new AccountApi(ctx, bindings);
    expect(container.envVars).not.toHaveProperty("CLOUDFLARE_ACCOUNT_ID");
    expect(container.envVars).not.toHaveProperty("CLOUDFLARE_ZONE_ID");
    expect(container.envVars).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(container.envVars).not.toHaveProperty("CLOUDFLARE_TUNNEL_DOMAIN");
    expect(container.envVars).not.toHaveProperty("REMOTE_TEST_USER_IDS");
    expect(container.envVars).not.toHaveProperty("MIGRATION_PROXY_SECRET");
    expect(container.envVars).not.toHaveProperty("ACCOUNT_API");
  });
});
