// FILE: worker.test.ts
// Purpose: Unit coverage for ingest validation, server-side redaction, and
// dashboard session auth. Runs in plain vitest (no workerd pool): the tested
// helpers are pure functions over plain inputs.

import { describe, expect, it } from "vitest";

import worker, {
  compareVersionsDesc,
  normalizeEvent,
  normalizeProductEvent,
  parseApiFilters,
  rangeDays,
  releaseHealth,
  signSession,
  verifyAccessJwt,
  verifySessionCookie,
  type Env,
} from "./worker";

const baseEvent = {
  v: 1,
  id: "11111111-2222-3333-4444-555555555555",
  ts: new Date().toISOString(),
  installId: "00000000-0000-4000-8000-000000000000",
  appVersion: "9.9.9-beta.1",
  flavor: "beta",
  platform: "darwin",
  arch: "arm64",
  event: "app.start",
  payload: { kind: "lifecycle" },
};

describe("normalizeEvent", () => {
  it("accepts a minimal #1265-era lifecycle event", () => {
    const row = normalizeEvent(baseEvent);
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      event: "app.start",
      kind: "lifecycle",
      installId: baseEvent.installId,
      appVersion: "9.9.9-beta.1",
      message: null,
      stack: null,
      logTail: null,
    });
  });

  it("accepts app.error and redacts free text server-side", () => {
    const row = normalizeEvent({
      ...baseEvent,
      event: "app.error",
      payload: {
        kind: "error",
        source: "renderer",
        message: "failed for user@example.com at /Users/alice/x",
        stack: "Error: key=sk-AbCdEfGhIjKlMnOpQrStUvWx\n    at f (a.ts:1:1)",
        fingerprint: "abcdef0123456789",
      },
    });
    expect(row).not.toBeNull();
    expect(row!.source).toBe("renderer");
    expect(row!.fingerprint).toBe("abcdef0123456789");
    expect(row!.message).toContain("<email>");
    expect(row!.message).toContain("~/…/x");
    expect(JSON.stringify(row)).not.toContain("user@example.com");
    expect(JSON.stringify(row)).not.toContain("sk-AbCd");
    expect(JSON.stringify(row)).not.toContain("alice");
  });

  it("accepts crash events with a redacted logTail", () => {
    const row = normalizeEvent({
      ...baseEvent,
      event: "app.child-process-crash",
      payload: {
        kind: "crash",
        processType: "backend",
        reason: "code=1",
        logTail: "dial 10.0.0.8:8080 failed, password=hunter2",
      },
    });
    expect(row!.logTail).toContain("<ip>");
    expect(row!.logTail).not.toContain("hunter2");
    expect(row!.processType).toBe("backend");
  });

  it.each([
    ["unknown event", { ...baseEvent, event: "chat.message" }],
    ["non-beta flavor", { ...baseEvent, flavor: "production" }],
    ["bad version", { ...baseEvent, appVersion: "not-semver" }],
    ["overlong version", { ...baseEvent, appVersion: "1.2.3-" + "a".repeat(64) }],
    ["bad install id", { ...baseEvent, installId: "not-a-uuid" }],
    ["missing v", { ...baseEvent, v: 2 }],
    ["bad ts", { ...baseEvent, ts: "yesterday" }],
  ])("drops %s", (_name, event) => {
    expect(normalizeEvent(event)).toBeNull();
  });

  it("drops events outside the accepted timestamp window", () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    const future = new Date(now + 25 * 60 * 60 * 1000).toISOString();
    const old = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    const edge = new Date(now + 23 * 60 * 60 * 1000).toISOString();
    expect(normalizeEvent({ ...baseEvent, ts: future }, now)).toBeNull();
    expect(normalizeEvent({ ...baseEvent, ts: old }, now)).toBeNull();
    expect(normalizeEvent({ ...baseEvent, ts: edge }, now)).not.toBeNull();
  });

  it("keeps a valid client id for idempotent ingest", () => {
    const row = normalizeEvent(baseEvent);
    expect(row!.clientId).toBe("11111111-2222-3333-4444-555555555555");
    expect(normalizeEvent({ ...baseEvent, id: "not-a-uuid" })!.clientId).toBeNull();
    const { id: _id, ...noId } = baseEvent;
    expect(normalizeEvent(noId)!.clientId).toBeNull();
  });

  it("caps payload.kind and other free strings", () => {
    const row = normalizeEvent({
      ...baseEvent,
      event: "app.error",
      payload: {
        kind: `error${"x".repeat(200)}`,
        source: "main",
        message: "m",
        fingerprint: "abcdef0123456789",
      },
    });
    expect(row!.kind.length).toBeLessThanOrEqual(16);
  });
});

describe("normalizeProductEvent", () => {
  const productEvent = {
    v: 1,
    id: "11111111-2222-4333-8444-555555555555",
    ts: "2026-10-05T12:00:00.000Z",
    installId: "00000000-0000-4000-8000-000000000000",
    channel: "stable",
    surface: "desktop",
    platform: "darwin",
    appVersion: "1.2.3",
    event: "feature.used",
    outcome: "succeeded",
    feature: "settings",
    durationMs: 123,
  };

  it("accepts the bounded event contract for both release channels and mobile surfaces", () => {
    expect(normalizeProductEvent(productEvent, Date.parse(productEvent.ts))).toMatchObject({
      event: "feature.used",
      channel: "stable",
      feature: "settings",
      durationMs: 123,
    });
    expect(
      normalizeProductEvent(
        { ...productEvent, channel: "beta", surface: "ipados", platform: "ipados" },
        Date.parse(productEvent.ts),
      ),
    ).toMatchObject({ channel: "beta", surface: "ipados", platform: "ipados" });
    expect(
      normalizeProductEvent(
        { ...productEvent, appVersion: "1.2.3-beta.2+build.17" },
        Date.parse(productEvent.ts),
      ),
    ).toMatchObject({ appVersion: "1.2.3-beta.2+build.17" });
  });

  it.each(["connection.pair", "connection.connect", "connection.reconnect", "chat.request"])(
    "accepts bounded duration for %s",
    (event) => {
      expect(
        normalizeProductEvent(
          { ...productEvent, event, durationMs: 500 },
          Date.parse(productEvent.ts),
        ),
      ).toMatchObject({ event, durationMs: 500 });
    },
  );

  it.each([
    ["bad channel", { channel: "other" }],
    ["bad event", { event: "custom.event" }],
    ["bad outcome", { outcome: "unknown" }],
    ["bad feature", { feature: "free text" }],
    ["null optional feature", { feature: null }],
    ["fractional duration", { durationMs: 1.5 }],
    ["excessive duration", { durationMs: 86_400_001 }],
    ["excessive token count", { inputTokens: 1_000_000_000_001 }],
    ["non-ISO timestamp", { ts: "2026-10-05" }],
  ])("rejects %s", (_name, patch) => {
    const raw = { ...productEvent, ...patch };
    expect(normalizeProductEvent(raw, Date.parse(productEvent.ts))).toBeNull();
  });

  it("rejects timestamps outside the 7-day and 5-minute ingest window", () => {
    const now = Date.parse(productEvent.ts);
    expect(
      normalizeProductEvent(
        { ...productEvent, ts: new Date(now - 7 * DAY_MS - 1).toISOString() },
        now,
      ),
    ).toBeNull();
    expect(
      normalizeProductEvent(
        { ...productEvent, ts: new Date(now + 5 * 60_000 + 1).toISOString() },
        now,
      ),
    ).toBeNull();
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

describe("trusted forwarder rate-limit keys", () => {
  async function capturedRateLimitKey(
    forwardedIp: string,
    proof: string,
    cloudflareIp = "198.51.100.7",
  ) {
    const keys: string[] = [];
    const env = {
      FORWARDER_SECRET: "forwarder-secret",
      INGEST_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          keys.push(key);
          return { success: true };
        },
      },
    } as unknown as Env;
    const response = await worker.fetch(
      new Request("https://worker.invalid/v1/events", {
        method: "POST",
        headers: {
          "cf-connecting-ip": cloudflareIp,
          "x-synara-client-ip": forwardedIp,
          "x-synara-forwarder-secret": proof,
        },
        body: "not-json\n",
      }),
      env,
    );
    expect(response.status).toBe(200);
    return keys[0];
  }

  it("uses a valid forwarded IP only with a valid bounded proof", async () => {
    await expect(capturedRateLimitKey("2001:db8::1234", "forwarder-secret")).resolves.toBe(
      "2001:db8::1234",
    );
  });

  it.each([
    ["invalid proof", "2001:db8::1234", "wrong-proof"],
    ["invalid IP", "2001:db8::g", "forwarder-secret"],
    ["overlong IP", "a".repeat(46), "forwarder-secret"],
  ])("uses the Cloudflare IP for %s", async (_name, forwardedIp, proof) => {
    await expect(capturedRateLimitKey(forwardedIp, proof)).resolves.toBe("198.51.100.7");
  });
});

describe("usage + beta events", () => {
  it("stores valid osVersion/locale on app.start, drops invalid ones", () => {
    const ok = normalizeEvent({
      ...baseEvent,
      payload: { kind: "lifecycle", osVersion: "15.3", locale: "en" },
    });
    expect(ok).toMatchObject({ osVersion: "15.3", locale: "en" });
    const bad = normalizeEvent({
      ...baseEvent,
      payload: { kind: "lifecycle", osVersion: "macOS 15.3.1 beta", locale: "EN-US" },
    });
    expect(bad).toMatchObject({ osVersion: "", locale: "" });
    // Windows-style three-part versions drop to nothing rather than truncate.
    const win = normalizeEvent({
      ...baseEvent,
      payload: { kind: "lifecycle", osVersion: "10.0.22621" },
    });
    expect(win!.osVersion).toBe("");
  });

  it("validates beta outcomes per event and drops invalid events", () => {
    expect(
      normalizeEvent({
        ...baseEvent,
        event: "beta.installed",
        payload: { kind: "beta", outcome: "imported" },
      }),
    ).toMatchObject({ outcome: "imported" });
    expect(
      normalizeEvent({
        ...baseEvent,
        event: "beta.left",
        payload: { kind: "beta", outcome: "keep" },
      }),
    ).toMatchObject({ outcome: "keep" });
    // Outcomes are not interchangeable across the two events.
    expect(
      normalizeEvent({
        ...baseEvent,
        event: "beta.installed",
        payload: { kind: "beta", outcome: "trash" },
      }),
    ).toBeNull();
    expect(
      normalizeEvent({
        ...baseEvent,
        event: "beta.left",
        payload: { kind: "beta", outcome: "imported" },
      }),
    ).toBeNull();
    expect(
      normalizeEvent({
        ...baseEvent,
        event: "beta.installed",
        payload: { kind: "beta" },
      }),
    ).toBeNull();
  });

  it("usage.daily merges duplicate providers and clamps counts", () => {
    const row = normalizeEvent({
      ...baseEvent,
      event: "usage.daily",
      payload: {
        kind: "usage",
        providers: [
          { provider: "claudeAgent", threads: 3.9, turns: 9.9, turnsFailed: 1 },
          { provider: "claudeAgent", threads: 1, turns: Number.NaN, turnsFailed: -2 },
          { provider: "opencode", threads: 200_000, turns: 4, turnsFailed: 0 },
          { provider: "not a provider!", threads: 9, turns: 9, turnsFailed: 9 },
        ],
        projects: 7.7,
        activeThreads: -1,
      },
    });
    expect(row).not.toBeNull();
    expect(row!.providers).toEqual([
      { provider: "claudeAgent", threads: 4, turns: 9, turnsFailed: 1 },
      { provider: "opencode", threads: 100_000, turns: 4, turnsFailed: 0 },
    ]);
    expect(row!.projects).toBe(7);
    expect(row!.activeThreads).toBe(0);
  });

  it("drops usage.daily when providers is not an array", () => {
    expect(
      normalizeEvent({
        ...baseEvent,
        event: "usage.daily",
        payload: { kind: "usage", providers: "claudeAgent", projects: 1, activeThreads: 1 },
      }),
    ).toBeNull();
    expect(
      normalizeEvent({
        ...baseEvent,
        event: "usage.daily",
        payload: { kind: "usage", projects: 1, activeThreads: 1 },
      }),
    ).toBeNull();
    // An empty array is still a valid (empty) snapshot.
    expect(
      normalizeEvent({
        ...baseEvent,
        event: "usage.daily",
        payload: { kind: "usage", providers: [], projects: 0, activeThreads: 0 },
      })!.providers,
    ).toEqual([]);
  });
});

describe("releaseHealth bands", () => {
  it("maps crash-free pct to healthy/watch/unhealthy", () => {
    expect(releaseHealth(null)).toBeNull();
    expect(releaseHealth(100)).toBe("healthy");
    expect(releaseHealth(99.5)).toBe("healthy");
    expect(releaseHealth(99.4)).toBe("watch");
    expect(releaseHealth(98)).toBe("watch");
    expect(releaseHealth(97.9)).toBe("unhealthy");
    expect(releaseHealth(50)).toBe("unhealthy");
  });
});

describe("dashboard API", () => {
  const authed = async (env: Env) => {
    const token = await signSession("k", Math.floor(Date.now() / 1000) + 3600);
    return { cookie: `synara_beta_dash=${token}` };
  };

  // Records every query; canned results keep the handler paths exercised.
  const makeEnv = (allResults: { match: string; results: Record<string, unknown>[] }[] = []) => {
    const calls: { sql: string; binds: unknown[] }[] = [];
    const db = {
      prepare: (sql: string) => {
        const methods = (binds: unknown[]) => ({
          run: async () => {
            calls.push({ sql, binds });
            return { meta: { changes: 1 } };
          },
          all: async () => {
            calls.push({ sql, binds });
            const hit = allResults.find((r) => sql.includes(r.match));
            return { results: hit?.results ?? [] };
          },
          first: async () => {
            calls.push({ sql, binds });
            return null;
          },
        });
        return { bind: (...binds: unknown[]) => methods(binds), ...methods([]) };
      },
    };
    return { calls, env: { DB: db, DASHBOARD_SESSION_KEY: "k" } as unknown as Env };
  };

  it("overview queries the equal-length previous window and returns the new shape", async () => {
    const { calls, env } = makeEnv();
    const headers = await authed(env);
    const res = await worker.fetch(new Request("http://x/api/overview?days=7", { headers }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("previous");
    expect(body).not.toHaveProperty("sparklines");
    expect(body).toHaveProperty("lastEventAt");
    expect(body).toHaveProperty("latestRelease");
    expect(body.previous).toMatchObject({
      activeInstalls: 0,
      newIssues: 0,
      updateFailures: 0,
    });
    expect(body.previous).not.toHaveProperty("errors");
    expect(body.previous).not.toHaveProperty("crashes");
    // The previous-window queries cover the rolling [now-14d, now-7d) —
    // the same length as the current window, ending at its start.
    const prevQueries = calls.filter((c) => c.sql.includes("ts >= ? AND ts < ?"));
    expect(prevQueries.length).toBeGreaterThanOrEqual(3);
    for (const call of prevQueries) {
      const [lo, hi] = call.binds as string[];
      expect(Date.parse(hi) - Date.parse(lo)).toBeCloseTo(7 * 86_400_000, -3);
      // Upper bound equals the current range's rolling lower bound: some
      // metric query uses it as its `ts >= ?` bind.
      expect(calls.some((c) => !c.sql.includes("ts < ?") && c.binds[0] === hi)).toBe(true);
    }
    // Rolling stats keep the clock time; day-bucketed queries are midnight-
    // aligned and emit exactly `days` daily buckets ending today.
    const rollingBind = prevQueries[0]!.binds[1] as string;
    expect(rollingBind).not.toContain("T00:00:00.000Z");
    const bucketed = calls.find((c) => c.sql.includes("GROUP BY day, event"))!;
    expect(bucketed.binds[0]).toContain("T00:00:00.000Z");
    const today = new Date().toISOString().slice(0, 10);
    const timeseries = body.timeseries as { day: string }[];
    expect(timeseries[timeseries.length - 1]!.day).toBe(today);
    expect(timeseries.length).toBe(7);
  });

  it("overview hides the previous window entirely for the All range", async () => {
    const { calls, env } = makeEnv();
    const headers = await authed(env);
    const res = await worker.fetch(new Request("http://x/api/overview?days=365", { headers }), env);
    const body = (await res.json()) as {
      previous: Record<string, number | null>;
      timeseries: { day: string }[];
    };
    expect(body.previous).toEqual({
      activeInstalls: null,
      crashFreePct: null,
      newIssues: null,
      updateFailures: null,
    });
    // No previous-window queries run at all.
    expect(calls.some((c) => c.sql.includes("ts >= ? AND ts < ?"))).toBe(false);
    const timeseries = body.timeseries;
    expect(timeseries.length).toBe(365);
    expect(timeseries[timeseries.length - 1]!.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it("overview lands a just-now event in the last day bucket", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { env } = makeEnv([
      {
        match: "GROUP BY day, event",
        results: [{ day: today, event: "app.error", n: 3 }],
      },
    ]);
    const headers = await authed(env);
    const res = await worker.fetch(new Request("http://x/api/overview?days=30", { headers }), env);
    const body = (await res.json()) as {
      timeseries: { day: string; errors: number }[];
    };
    expect(body.timeseries[body.timeseries.length - 1]).toMatchObject({
      day: today,
      errors: 3,
    });
  });

  it("overview suppresses the new-issues delta under a version filter", async () => {
    const { env } = makeEnv();
    const headers = await authed(env);
    const res = await worker.fetch(
      new Request("http://x/api/overview?days=30&version=1.0.0-beta.1", { headers }),
      env,
    );
    const body = (await res.json()) as { previous: { newIssues: number | null } };
    expect(body.previous.newIssues).toBeNull();
  });

  it("serves only the allowlisted public files without a session", async () => {
    const db = { prepare: () => ({ bind: () => ({}), all: async () => ({ results: [] }) }) };
    const assets = {
      fetch: async (req: Request) =>
        new Response(`asset:${new URL(req.url).pathname}`, {
          headers: { "content-type": "image/png" },
        }),
    };
    const env = { DB: db, ASSETS: assets, DASHBOARD_SESSION_KEY: "k" } as unknown as Env;
    // Public files answer without a session.
    const icon = await worker.fetch(new Request("http://x/beta.png"), env);
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    // Everything else still goes through the gate: /index.html redirects to
    // login, extensioned non-allowlisted paths don't serve the shell either.
    const index = await worker.fetch(new Request("http://x/index.html"), env);
    expect(index.status).toBe(302);
    const other = await worker.fetch(new Request("http://x/secret.png"), env);
    expect(other.status).toBe(302);
    // API paths are untouched by the allowlist.
    const api = await worker.fetch(new Request("http://x/api/x.png"), env);
    expect(api.status).toBe(401);
  });

  it("activity returns shaped rows and requires a session", async () => {
    const rows = [
      {
        id: 9,
        ts: "2026-09-23T00:00:00.000Z",
        event: "beta.installed",
        kind: "beta",
        issueKey: null,
        appVersion: "0.9.4-beta.1",
        platform: "darwin",
        outcome: "imported",
        message: null,
      },
      {
        id: 8,
        ts: "2026-09-22T00:00:00.000Z",
        event: "app.child-process-crash",
        kind: "crash",
        issueKey: "crash:backend:code=1",
        appVersion: "0.9.4-beta.1",
        platform: "win32",
        outcome: "ok",
        message: null,
      },
    ];
    const { calls, env } = makeEnv([{ match: "beta.installed", results: rows }]);
    expect((await worker.fetch(new Request("http://x/api/activity", {}), env)).status).toBe(401);
    const headers = await authed(env);
    const res = await worker.fetch(new Request("http://x/api/activity", { headers }), env);
    const body = (await res.json()) as { activity: Record<string, unknown>[] };
    expect(body.activity).toHaveLength(2);
    expect(body.activity[0]).toMatchObject({
      id: 9,
      event: "beta.installed",
      issueKey: null,
      title: "New install (copied from Synara)",
      appVersion: "0.9.4-beta.1",
      platform: "darwin",
    });
    expect(body.activity[1]).toMatchObject({
      issueKey: "crash:backend:code=1",
      title: "Backend exited with code 1",
    });
    // The query is capped and filtered to the activity event set.
    const sql = calls.find((c) => c.sql.includes("ORDER BY ts DESC"))!.sql;
    expect(sql).toContain("LIMIT 15");
    expect(sql).toContain("'beta.installed'");
  });
});

describe("session cookie", () => {
  it("round-trips a signed session", async () => {
    const secret = "test-session-key";
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const token = await signSession(secret, expiresAt);
    expect(await verifySessionCookie(`synara_beta_dash=${token}`, secret)).toBe(true);
  });

  it("rejects expired, tampered, and wrong-key sessions", async () => {
    const secret = "test-session-key";
    const future = Math.floor(Date.now() / 1000) + 3600;
    const token = await signSession(secret, future);
    const [expiry] = token.split(".");
    expect(await verifySessionCookie(`synara_beta_dash=${expiry}.badbadbad`, secret)).toBe(false);
    expect(await verifySessionCookie(`synara_beta_dash=${token}`, "other-key")).toBe(false);
    const expired = await signSession(secret, Math.floor(Date.now() / 1000) - 10);
    expect(await verifySessionCookie(`synara_beta_dash=${expired}`, secret)).toBe(false);
    expect(await verifySessionCookie(null, secret)).toBe(false);
    expect(await verifySessionCookie("other=1", secret)).toBe(false);
  });
});

describe("password login", () => {
  const env = {
    DASHBOARD_PASSWORD: "primary-pw",
    DASHBOARD_PASSWORD_2: "secondary-pw",
    DASHBOARD_SESSION_KEY: "k",
  } as unknown as Env;

  const postLogin = (e: Env, password: string) =>
    worker.fetch(
      new Request("http://x/api/login", {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
      e,
    );

  it("accepts either configured password and issues a session cookie", async () => {
    for (const password of ["primary-pw", "secondary-pw"]) {
      const res = await postLogin(env, password);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toContain("synara_beta_dash=");
    }
  });

  it("rejects wrong passwords and reports unconfigured without any", async () => {
    expect((await postLogin(env, "nope")).status).toBe(401);
    const bare = { DASHBOARD_SESSION_KEY: "k" } as unknown as Env;
    expect((await postLogin(bare, "primary-pw")).status).toBe(503);
  });
});

describe("verifyAccessJwt", () => {
  const TEAM = "https://synara.cloudflareaccess.com";
  const AUD = "test-aud-tag";

  const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");

  async function makeJwt(
    overrides: Record<string, unknown> = {},
    kid = "k1",
  ): Promise<{ jwt: string; keys: Map<string, CryptoKey> }> {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", kid })));
    const payload = b64url(
      new TextEncoder().encode(
        JSON.stringify({
          iss: TEAM,
          aud: [AUD],
          exp: Math.floor(Date.now() / 1000) + 3600,
          email: "kartik@example.com",
          ...overrides,
        }),
      ),
    );
    const sig = await crypto.subtle.sign(
      { name: "RSASSA-PKCS1-v1_5" },
      pair.privateKey,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return {
      jwt: `${header}.${payload}.${b64url(new Uint8Array(sig))}`,
      keys: new Map([[kid, pair.publicKey]]),
    };
  }

  const env = { POLICY_AUD: AUD, TEAM_DOMAIN: TEAM };

  it("accepts a valid Access JWT", async () => {
    const { jwt, keys } = await makeJwt();
    expect(await verifyAccessJwt(jwt, env, undefined, async () => keys)).toBe(true);
  });

  it("rejects wrong aud, expired, wrong issuer, bad kid, and non-allowlisted email", async () => {
    const good = await makeJwt();
    const getKeys = async () => good.keys;
    expect(
      await verifyAccessJwt(good.jwt, { ...env, POLICY_AUD: "other" }, undefined, getKeys),
    ).toBe(false);

    const expired = await makeJwt({ exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await verifyAccessJwt(expired.jwt, env, undefined, async () => expired.keys)).toBe(
      false,
    );

    const wrongIss = await makeJwt({ iss: "https://other.cloudflareaccess.com" });
    expect(await verifyAccessJwt(wrongIss.jwt, env, undefined, async () => wrongIss.keys)).toBe(
      false,
    );

    const otherKid = await makeJwt({}, "unknown-kid");
    expect(await verifyAccessJwt(otherKid.jwt, env, undefined, async () => new Map())).toBe(false);

    expect(
      await verifyAccessJwt(
        good.jwt,
        { ...env, ALLOWED_EMAILS: "kartik@example.com,emanuele@example.com" },
        undefined,
        getKeys,
      ),
    ).toBe(true);
    expect(
      await verifyAccessJwt(
        good.jwt,
        { ...env, ALLOWED_EMAILS: "emanuele@example.com" },
        undefined,
        getKeys,
      ),
    ).toBe(false);
  });

  it("rejects malformed and unsigned input without touching the key source", async () => {
    const getKeys = async () => {
      throw new Error("should not fetch");
    };
    expect(await verifyAccessJwt("not-a-jwt", env, undefined, getKeys)).toBe(false);
    expect(await verifyAccessJwt("", env, undefined, getKeys)).toBe(false);
    expect(await verifyAccessJwt("a.b.c", env, undefined, getKeys)).toBe(false);
  });
});

describe("parseApiFilters", () => {
  const now = Date.parse("2026-09-24T00:00:00.000Z");
  const parse = (qs: string) => parseApiFilters(new URL(`http://x/api/issues${qs}`), now);

  it("defaults to 7 days and no filters", () => {
    const f = parse("");
    expect(f.days).toBe(7);
    expect(f.clause).toBe("");
    expect(f.binds).toEqual([]);
  });

  it("drops invalid values instead of storing them", () => {
    const f = parse("?days=banana&version=not a version&platform=amiga&kind=meme&source=gpu");
    expect(f.days).toBe(7);
    expect(f.version).toBeNull();
    expect(f.platform).toBeNull();
    expect(f.kind).toBeNull();
    expect(f.source).toBeNull();
    expect(f.clause).toBe("");
  });

  it("binds every value; nothing is interpolated", () => {
    const f = parse(
      "?days=30&version=0.9.3-beta.1&platform=darwin&kind=crash&source=renderer&q=quota",
    );
    expect(f.days).toBe(30);
    expect(f.clause).not.toContain("0.9.3");
    expect(f.clause).not.toContain("quota");
    expect(f.binds).toEqual(["0.9.3-beta.1", "darwin", "renderer", "%quota%", "%quota%"]);
    expect(f.clause).toContain("app_version = ?");
    expect(f.clause).toContain("LIKE ? ESCAPE");
  });

  it("scope filters keep only version + platform", () => {
    const f = parse("?version=0.9.3-beta.1&platform=darwin&kind=crash&source=renderer&q=quota");
    expect(f.scopeBinds).toEqual(["0.9.3-beta.1", "darwin"]);
    expect(f.scopeClause).toContain("app_version = ?");
    expect(f.scopeClause).not.toContain("LIKE");
    expect(f.scopeClause).not.toContain("event");
    expect(f.platformBinds).toEqual(["darwin"]);
    expect(f.platformClause).toBe(" AND platform = ?");
  });

  it("escapes LIKE wildcards in q", () => {
    const f = parse(`?q=${encodeURIComponent("100%_off\\")}`);
    expect(f.binds).toEqual(["%100\\%\\_off\\\\%", "%100\\%\\_off\\\\%"]);
  });

  it("caps days at the max range and q at 100 chars", () => {
    const f = parse(`?days=9999&q=${"x".repeat(300)}`);
    expect(f.days).toBe(365);
    expect(f.q!.length).toBe(100);
  });

  it("keeps rolling and bucketed windows distinct across midnight", () => {
    // 30 minutes after UTC midnight: a 7d range is 7 calendar buckets ending
    // today, while stats and deltas roll back exactly 7x24h and 14x24h.
    const now = Date.parse("2026-09-24T00:30:00.000Z");
    const f = parseApiFilters(new URL("http://x/api/overview?days=7"), now);
    expect(f.since).toBe("2026-09-17T00:30:00.000Z");
    expect(f.prevSince).toBe("2026-09-10T00:30:00.000Z");
    expect(f.bucketSince).toBe("2026-09-18T00:00:00.000Z");
    expect(f.now).toBe(now);
    const days = rangeDays(f.bucketSince, f.now);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe("2026-09-18");
    expect(days[days.length - 1]).toBe("2026-09-24");
    // An event at 23:59 yesterday lands in the rolling window AND yesterday's
    // bucket — the two windows disagree only at the edges.
    expect(Date.parse("2026-09-17T00:29:00.000Z")).toBeLessThan(Date.parse(f.since));
  });
});

describe("compareVersionsDesc", () => {
  it("sorts semver-desc, prerelease digits numerically", () => {
    const sorted = ["0.9.3-beta.9", "0.9.3-beta.10", "0.9.4-beta.1", "0.9.3-beta.2", "1.0.0"].sort(
      compareVersionsDesc,
    );
    expect(sorted).toEqual([
      "1.0.0",
      "0.9.4-beta.1",
      "0.9.3-beta.10",
      "0.9.3-beta.9",
      "0.9.3-beta.2",
    ]);
  });
});

describe("issue key + status endpoint validation", () => {
  const makeEnv = () => {
    const calls: { sql: string; binds: unknown[] }[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          run: async () => {
            calls.push({ sql, binds });
            return { meta: { changes: 1 } };
          },
          all: async () => ({ results: [] }),
          first: async () => null,
        }),
      }),
    };
    return { calls, env: { DB: db, DASHBOARD_SESSION_KEY: "k" } as unknown as Env };
  };

  const authed = async (env: Env) => {
    const token = await signSession("k", Math.floor(Date.now() / 1000) + 3600);
    return { cookie: `synara_beta_dash=${token}` };
  };

  it("accepts valid keys, rejects traversal, overlong, and bad prefixes", async () => {
    const { env } = makeEnv();
    const headers = await authed(env);
    const get = (key: string) =>
      worker.fetch(new Request(`http://x/api/issues/${key}`, { headers }), env);
    expect((await get(encodeURIComponent("err:abc123"))).status).toBe(404);
    expect((await get(encodeURIComponent("crash:renderer:oom"))).status).toBe(404);
    expect((await get(encodeURIComponent("update:download"))).status).toBe(404);
    // Real crash reasons contain '='; printable text after the prefix is fine.
    expect((await get(encodeURIComponent("crash:backend:code=1"))).status).toBe(404);
    // 404 means the key validated and no events matched; bad keys get 400.
    expect((await get(encodeURIComponent("../x"))).status).toBe(400);
    expect((await get(encodeURIComponent("err:bad\x1fkey"))).status).toBe(400);
    expect((await get(encodeURIComponent(`err:${"a".repeat(200)}`))).status).toBe(400);
    expect((await get(encodeURIComponent("nope:abc"))).status).toBe(400);
  });

  it("requires a session for status writes", async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(
      new Request("http://x/api/issues/err%3Aabc/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "resolved" }),
      }),
      env,
    );
    expect(res.status).toBe(401);
  });

  it("rejects wrong content-type and bad status values", async () => {
    const { env } = makeEnv();
    const headers = await authed(env);
    const post = (contentType: string, body: string) =>
      worker.fetch(
        new Request("http://x/api/issues/err%3Aabc/status", {
          method: "POST",
          headers: { "content-type": contentType, ...headers },
          body,
        }),
        env,
      );
    expect((await post("text/plain", "{}")).status).toBe(415);
    expect((await post("application/json", "not json")).status).toBe(400);
    expect((await post("application/json", JSON.stringify({ status: "bogus" }))).status).toBe(400);
  });

  it("deletes the row for open and upserts otherwise", async () => {
    const { env, calls } = makeEnv();
    const headers = await authed(env);
    const post = (status: string) =>
      worker.fetch(
        new Request("http://x/api/issues/err%3Aabc/status", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ status }),
        }),
        env,
      );
    expect(await (await post("open")).json()).toEqual({ status: "open" });
    expect(await (await post("resolved")).json()).toEqual({ status: "resolved" });
    expect(calls[0]!.sql).toContain("DELETE FROM issue_status");
    expect(calls[0]!.binds).toEqual(["err:abc"]);
    expect(calls[1]!.sql).toContain("ON CONFLICT");
    expect(calls[1]!.binds[0]).toBe("err:abc");
    expect(calls[1]!.binds[1]).toBe("resolved");
  });
});
