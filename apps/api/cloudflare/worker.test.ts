import { randomUUID } from "node:crypto";
import { loadApiConfig } from "../src/config";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
    envVars: Record<string, string> = {};
    startAndWaitForPorts() {
      return (this.ctx as { start: (env: Record<string, string>) => Promise<void> }).start(
        this.envVars,
      );
    }
    stop(signal: string) {
      return (this.ctx as { stop: (signal: string) => Promise<void> }).stop(signal);
    }
    fetch(request: Request) {
      return (this.ctx as { forward: (request: Request) => Promise<Response> }).forward(request);
    }
  },
}));

import worker, { AccountApi } from "./worker";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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

  it.each([500, 429])("hides raw SDK transport errors returned with status %s", async (status) => {
    const { env, fetch } = setup();
    fetch.mockResolvedValue(
      new Response("Failed to start container: synthetic-private-startup-detail", { status }),
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await worker.fetch(new Request("https://api.example/api/v1/me"), env);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-private");
  });

  it.each([400, 401, 403, 429, 500, 503])(
    "preserves application JSON errors with status %s",
    async (status) => {
      const { env, fetch } = setup();
      const upstream = Response.json(
        { error: "billing_unavailable", message: "Safe application response" },
        { status },
      );
      fetch.mockResolvedValue(upstream);
      expect(await worker.fetch(new Request("https://api.example/api/v1/me"), env)).toBe(upstream);
    },
  );

  it("does not consume or rewrite a WebSocket upgrade response", async () => {
    const { env, fetch } = setup();
    const upgrade = { status: 101, headers: new Headers() } as Response;
    fetch.mockResolvedValue(upgrade);
    expect(await worker.fetch(new Request("https://api.example/"), env)).toBe(upgrade);
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

function billingBindings(environment: "sandbox" | "production") {
  return {
    POLAR_BILLING_ENABLED: "true",
    POLAR_ENVIRONMENT: environment,
    POLAR_PRODUCTION_PAYMENTS_ENABLED: environment === "production" ? "true" : "false",
    POLAR_REMOTE_ACCESS_ENFORCED: "true",
    POLAR_RETURN_ORIGINS: "https://billing.example.com",
    POLAR_ACCESS_TOKEN: "synthetic-worker-billing-token",
    POLAR_WEBHOOK_SECRET: "synthetic-worker-webhook-secret",
    POLAR_ORGANIZATION_ID: randomUUID(),
    POLAR_MONTHLY_PRODUCT_ID: randomUUID(),
    POLAR_YEARLY_PRODUCT_ID: randomUUID(),
    POLAR_DESKTOP_BENEFIT_ID: randomUUID(),
    POLAR_CHECKOUT_SUCCESS_URL: "https://billing.example.com/return",
    POLAR_PORTAL_RETURN_URL: "https://billing.example.com/settings",
    POLAR_EXPECTED_CURRENCY: "USD",
    POLAR_EXPECTED_MONTHLY_AMOUNT_MINOR: "799",
    POLAR_EXPECTED_YEARLY_AMOUNT_MINOR: "8499",
    POLAR_EXPECTED_TAX_BEHAVIOR: "exclusive",
  };
}

function runtime(running = false) {
  const values = new Map<string, string>();
  let resolveExit: (() => void) | undefined;
  const process = {
    running,
    monitor: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveExit = resolve;
        }),
    ),
  };
  const exit = () => {
    process.running = false;
    resolveExit?.();
  };
  const start = vi.fn(async (_env: Record<string, string>) => {
    process.running = true;
  });
  const stop = vi.fn(async (_signal: string) => {
    exit();
  });
  const forward = vi.fn(async (_request: Request) => new Response("runtime", { status: 200 }));
  const get = vi.fn(async (key: string) => values.get(key));
  const put = vi.fn(async (key: string, value: string) => {
    values.set(key, value);
  });
  const remove = vi.fn(async (key: string) => values.delete(key));
  const context = {
    container: process,
    storage: { get, put, delete: remove },
    start,
    stop,
    forward,
  } as unknown as ConstructorParameters<typeof AccountApi>[0];
  return { context, values, process, start, stop, forward, get, put, remove, exit };
}

describe("Cloudflare account API container configuration", () => {
  const ctx = {} as ConstructorParameters<typeof AccountApi>[0];

  it.each([
    [undefined, "user_mini, user_macbook", undefined],
    ["user_simulator", "user_mini, user_macbook,user_simulator", "true"],
    ["user_simulator", "user_mini, user_macbook,user_simulator", "false"],
  ])("preserves enrollment and forwards beta policy (%s)", (additional, expected, beta) => {
    const { env } = setup();
    const container = new AccountApi(ctx, {
      ...env,
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_ZONE_ID: "b".repeat(32),
      CLOUDFLARE_API_TOKEN: "test-tunnel-token",
      CLOUDFLARE_TUNNEL_DOMAIN: "example.com",
      REMOTE_TEST_USER_IDS: "user_mini, user_macbook",
      WORKOS_IDENTITY_MAP: '{"clientId":"test","users":{},"organizations":{}}',
      APNS_PRODUCTION_PRIVATE_KEY: "test-production-private-key",
      APNS_PRODUCTION_KEY_ID: "PROD123456",
      ...(additional ? { REMOTE_TEST_ADDITIONAL_USER_IDS: additional } : {}),
      ...(beta ? { REMOTE_BETA_ACCESS_ENABLED: beta } : {}),
    });

    expect(container.envVars).toMatchObject({
      NODE_ENV: "production",
      IDENTITY_PROVIDER: "workos",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_ZONE_ID: "b".repeat(32),
      CLOUDFLARE_API_TOKEN: "test-tunnel-token",
      CLOUDFLARE_TUNNEL_DOMAIN: "example.com",
      REMOTE_TEST_USER_IDS: expected,
      WORKOS_IDENTITY_MAP: '{"clientId":"test","users":{},"organizations":{}}',
      APNS_PRODUCTION_PRIVATE_KEY: "test-production-private-key",
      APNS_PRODUCTION_KEY_ID: "PROD123456",
    });
    if (beta) expect(container.envVars).toHaveProperty("REMOTE_BETA_ACCESS_ENABLED", beta);
    else expect(container.envVars).not.toHaveProperty("REMOTE_BETA_ACCESS_ENABLED");
  });

  it.each(["sandbox", "production"] as const)(
    "passes complete %s billing policy through the real API config parser",
    (environment) => {
      const { env } = setup();
      const bindings = billingBindings(environment);
      const container = new AccountApi(ctx, {
        ...env,
        ...bindings,
        API_SIGNING_KEY: Buffer.alloc(32, 1).toString("base64url"),
      });
      expect(container.envVars).toMatchObject(bindings);
      expect(loadApiConfig(container.envVars)).toMatchObject({
        remoteBillingEnforced: true,
        polarBilling: {
          environment,
          accessToken: bindings.POLAR_ACCESS_TOKEN,
          webhookSecret: bindings.POLAR_WEBHOOK_SECRET,
          expectedCatalog: {
            currency: "USD",
            monthlyAmountMinor: 799,
            yearlyAmountMinor: 8499,
            taxBehavior: "exclusive",
          },
        },
      });
    },
  );

  it("keeps billing off by default and preserves invalid or partial policy for fail-closed validation", () => {
    const { env } = setup();
    const base = { ...env, API_SIGNING_KEY: Buffer.alloc(32, 1).toString("base64url") };
    const disabled = new AccountApi(ctx, base);
    expect(disabled.envVars).toMatchObject({
      POLAR_BILLING_ENABLED: "false",
      POLAR_PRODUCTION_PAYMENTS_ENABLED: "false",
      POLAR_REMOTE_ACCESS_ENFORCED: "false",
    });
    expect(loadApiConfig(disabled.envVars)).toMatchObject({ remoteBillingEnforced: false });
    const partial = new AccountApi(ctx, {
      ...base,
      POLAR_BILLING_ENABLED: "true",
      POLAR_ENVIRONMENT: "sandbox",
      POLAR_REMOTE_ACCESS_ENFORCED: "true",
    });
    expect(() => loadApiConfig(partial.envVars)).toThrow("Missing required environment variables");
    const invalid = new AccountApi(ctx, { ...base, POLAR_REMOTE_ACCESS_ENFORCED: "" });
    expect(() => loadApiConfig(invalid.envVars)).toThrow("POLAR_REMOTE_ACCESS_ENFORCED");
  });

  it("starts once and replaces a warm old policy before forwarding, persisting only its hash", async () => {
    const { env } = setup();
    const state = runtime();
    const first = new AccountApi(state.context, env);
    await first.fetch(new Request("https://api.example/api/v1/instance"));
    expect(state.start).toHaveBeenCalledTimes(1);
    const oldFingerprint = [...state.values.values()][0];
    expect(oldFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const bindings = billingBindings("sandbox");
    const next = new AccountApi(state.context, { ...env, ...bindings });
    await next.fetch(new Request("https://api.example/api/v1/hosts/test/authorization"));
    expect(state.stop).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(state.start).toHaveBeenCalledTimes(2);
    expect(state.start.mock.calls[1]![0]).toMatchObject(bindings);
    const fingerprint = [...state.values.values()][0];
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toBe(oldFingerprint);
    expect([...state.values.values()].join()).not.toContain(bindings.POLAR_ACCESS_TOKEN);
    await new AccountApi(state.context, { ...env, ...bindings }).fetch(
      new Request("https://api.example/"),
    );
    expect(state.stop).toHaveBeenCalledTimes(1);
    expect(state.start).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent handovers and never forwards to the warm unverified process", async () => {
    const { env } = setup();
    const state = runtime(true);
    state.stop.mockImplementation(async () => {});
    const container = new AccountApi(state.context, { ...env, ...billingBindings("sandbox") });
    const pending = [
      container.fetch(new Request("https://api.example/one")),
      container.fetch(new Request("https://api.example/two")),
    ];
    await vi.waitFor(() => expect(state.stop).toHaveBeenCalledTimes(1));
    expect(state.forward).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    state.exit();
    await Promise.all(pending);
    expect(state.process.monitor).toHaveBeenCalledTimes(1);
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.put).toHaveBeenCalledTimes(1);
    expect(state.forward).toHaveBeenCalledTimes(2);
  });

  it("returns retryable 503 without forwarding or marking a stalled handover ready", async () => {
    vi.useFakeTimers();
    const { env, fetch } = setup();
    const state = runtime(true);
    state.stop.mockImplementation(async () => {});
    const container = new AccountApi(state.context, env);
    fetch.mockImplementation((request) => container.fetch(request));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = worker.fetch(
      new Request("https://api.example/api/v1/hosts/test/authorization"),
      env,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    const response = await pending;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(state.stop).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    expect(state.forward).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.put).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith("[account-api] Container unavailable");
  });

  it.each([false, true])(
    "checks readiness after sleep even with a previously verified config (new object: %s)",
    async (newObject) => {
      const { env, fetch } = setup();
      const state = runtime();
      const first = new AccountApi(state.context, env);
      await first.fetch(new Request("https://api.example/"));
      state.process.running = false;
      state.start.mockRejectedValue(new Error("synthetic-private-startup-detail"));
      // The real SDK returns a raw 500 if its automatic restart fails inside fetch.
      state.forward.mockImplementation(
        async () =>
          new Response("Failed to start container: synthetic-private-startup-detail", {
            status: 500,
          }),
      );
      const container = newObject ? new AccountApi(state.context, env) : first;
      fetch.mockImplementation((request) => container.fetch(request));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const response = await worker.fetch(new Request("https://api.example/api/v1/instance"), env);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("synthetic-private");
      expect(state.forward).toHaveBeenCalledTimes(1);
      expect(state.start).toHaveBeenCalledTimes(2);
      expect(state.stop).not.toHaveBeenCalled();
      expect(state.put).toHaveBeenCalledTimes(1);
      expect(state.remove).toHaveBeenCalledTimes(1);
      expect(state.values.size).toBe(0);
    },
  );

  it("does not persist or forward a configuration whose API process cannot become ready", async () => {
    const { env } = setup();
    const state = runtime();
    state.start.mockRejectedValue(new Error("Synthetic startup refused"));
    const container = new AccountApi(state.context, env);
    await expect(container.fetch(new Request("https://api.example/"))).rejects.toThrow(
      "Synthetic startup refused",
    );
    expect(state.put).not.toHaveBeenCalled();
    expect(state.forward).not.toHaveBeenCalled();
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
    expect(container.envVars).not.toHaveProperty("REMOTE_BETA_ACCESS_ENABLED");
    expect(container.envVars).not.toHaveProperty("MIGRATION_PROXY_SECRET");
    expect(container.envVars).not.toHaveProperty("ACCOUNT_API");
    expect(container.envVars).not.toHaveProperty("APNS_PRODUCTION_PRIVATE_KEY");
    expect(container.envVars).not.toHaveProperty("APNS_PRODUCTION_KEY_ID");
  });
});
