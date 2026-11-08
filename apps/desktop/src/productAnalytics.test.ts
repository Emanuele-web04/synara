import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { ProductAnalytics } from "./productAnalytics";
import { BetaDiagnostics } from "./betaDiagnostics";

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-product-analytics-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("defaults off, reconstructs allowlisted events, and clears queued data on opt-out", async () => {
  const homeDir = makeRoot();
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
  );
  const analytics = new ProductAnalytics({
    homeDir,
    channel: "beta",
    appVersion: "1.2.3-beta.1",
    platform: "darwin",
    fetcher,
  });

  expect(analytics.getState()).toEqual({ enabled: false });
  analytics.track({ event: "feature.used", outcome: "succeeded", feature: "search" });
  expect(existsSync(join(homeDir, "product-analytics", "install-id"))).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();

  analytics.setEnabled(true);
  const firstInstallId = readFileSync(
    join(homeDir, "product-analytics", "install-id"),
    "utf8",
  ).trim();
  analytics.track({
    event: "feature.used",
    outcome: "succeeded",
    feature: "search",
    query: "private query",
    projectName: "private project",
    threadId: "private thread",
  });
  expect(existsSync(join(homeDir, "product-analytics", "events.json"))).toBe(true);

  const analyticsDir = join(homeDir, "product-analytics");
  const orphaned = ["events.json.tmp-4321", "account-hash.tmp-4321", "cohort.json.tmp-4321"];
  for (const name of orphaned) writeFileSync(join(analyticsDir, name), "private legacy metadata");
  writeFileSync(join(analyticsDir, "unrelated.tmp-4321"), "preserve");
  analytics.setEnabled(false);
  expect(analytics.getState()).toEqual({ enabled: false });
  for (const name of orphaned) expect(existsSync(join(analyticsDir, name))).toBe(false);
  expect(existsSync(join(analyticsDir, "unrelated.tmp-4321"))).toBe(true);
  expect(existsSync(join(homeDir, "product-analytics", "install-id"))).toBe(false);
  expect(existsSync(join(homeDir, "product-analytics", "events.json"))).toBe(false);

  analytics.setEnabled(true);
  const secondInstallId = readFileSync(
    join(homeDir, "product-analytics", "install-id"),
    "utf8",
  ).trim();
  expect(secondInstallId).not.toBe(firstInstallId);
  analytics.track({ event: "turn.completed", outcome: "succeeded", inputTokens: 120 });

  // Current-version durable rows are rebuilt, not trusted even after the identity migration.
  const currentQueuePath = join(homeDir, "product-analytics", "events.json");
  const currentQueue = JSON.parse(readFileSync(currentQueuePath, "utf8"));
  currentQueue[0].accountHash = "aabeca326019f52e2e13cbab8574fcac";
  writeFileSync(currentQueuePath, JSON.stringify(currentQueue));
  const currentOrphan = `${currentQueuePath}.tmp-8765`;
  writeFileSync(currentOrphan, "private interrupted write");
  const restored = new ProductAnalytics({
    homeDir,
    channel: "beta",
    appVersion: "1.2.3-beta.1",
    platform: "darwin",
    fetcher,
  });
  expect(existsSync(currentOrphan)).toBe(false);
  await restored.flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  const request = fetcher.mock.calls[0]?.[1];
  const body = JSON.parse(String(request?.body)) as { events: Array<Record<string, unknown>> };
  expect(body.events).toHaveLength(1);
  expect(body.events[0]).toMatchObject({
    v: 1,
    installId: secondInstallId,
    channel: "beta",
    surface: "desktop",
    platform: "darwin",
    appVersion: "1.2.3-beta.1",
    event: "turn.completed",
    outcome: "succeeded",
    inputTokens: 120,
  });
  expect(Object.keys(body.events[0] ?? {}).toSorted()).toEqual(
    [
      "appVersion",
      "channel",
      "event",
      "id",
      "inputTokens",
      "installId",
      "outcome",
      "platform",
      "surface",
      "ts",
      "v",
    ].toSorted(),
  );
  expect(JSON.stringify(body)).not.toContain("private");
  analytics.dispose();
  restored.dispose();
});

it("rejects invalid enums and out-of-range counters before they enter the queue", async () => {
  const homeDir = makeRoot();
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
  );
  const analytics = new ProductAnalytics({
    homeDir,
    channel: "stable",
    appVersion: "1.0.0",
    platform: "mystery",
    fetcher,
  });
  analytics.setEnabled(true);
  analytics.track({ event: "feature.used", outcome: "succeeded", feature: "invented" });
  analytics.track({
    event: "turn.completed",
    outcome: "succeeded",
    outputTokens: 1_000_000_000_001,
  });
  analytics.track({ event: "turn.completed", outcome: "succeeded", durationMs: 1.5 });
  analytics.track({
    event: "command.used",
    outcome: "succeeded",
    command: "slash:private-team-name",
  });
  await analytics.flush();
  expect(fetcher).not.toHaveBeenCalled();
  analytics.track({ event: "turn.completed", outcome: "succeeded", outputTokens: 14 });
  await analytics.flush();
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
    events: Array<Record<string, unknown>>;
  };
  expect(body.events).toHaveLength(1);
  expect(body.events[0]).toMatchObject({ platform: "other", outputTokens: 14 });
  analytics.dispose();
});

it("aborts an in-flight send immediately when consent is withdrawn", async () => {
  const homeDir = makeRoot();
  const request = { signal: null as AbortSignal | null };
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    request.signal = init?.signal ?? null;
    return await new Promise<Response>((_resolve, reject) => {
      request.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  });
  const analytics = new ProductAnalytics({
    homeDir,
    channel: "stable",
    appVersion: "1.0.0",
    platform: "linux",
    fetcher,
  });
  analytics.setEnabled(true);
  analytics.track({ event: "app.open", outcome: "succeeded" });
  const pending = analytics.flush();
  expect(fetcher).toHaveBeenCalledOnce();
  analytics.setEnabled(false);
  await pending;
  expect(request.signal?.aborted).toBe(true);
  expect(existsSync(join(homeDir, "product-analytics", "events.json"))).toBe(false);
  analytics.dispose();
});

it("discards rejected batches and honors retry backoff for server failures", async () => {
  vi.useFakeTimers();
  const homeDir = makeRoot();
  let status = 422;
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status }),
  );
  const analytics = new ProductAnalytics({
    homeDir,
    channel: "stable",
    appVersion: "1.0.0",
    platform: "linux",
    fetcher,
  });
  analytics.setEnabled(true);
  analytics.track({ event: "app.open", outcome: "succeeded" });
  await analytics.flush();
  expect(
    JSON.parse(readFileSync(join(homeDir, "product-analytics", "events.json"), "utf8")),
  ).toEqual([]);

  status = 503;
  analytics.track({ event: "connection.connect", outcome: "failed", mode: "remote" });
  await analytics.flush();
  analytics.track({ event: "connection.connect", outcome: "succeeded", mode: "remote" });
  await analytics.flush();
  expect(fetcher).toHaveBeenCalledTimes(2);

  status = 204;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(fetcher).toHaveBeenCalledTimes(3);
  analytics.dispose();
  vi.useRealTimers();
});

it("drops malformed persisted event UUIDs before they can poison a send batch", async () => {
  const homeDir = makeRoot();
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
  );
  const analytics = new ProductAnalytics({
    homeDir,
    channel: "beta",
    appVersion: "1.0.0-beta.1",
    platform: "darwin",
    fetcher,
  });
  analytics.setEnabled(true);
  analytics.track({ event: "app.open", outcome: "succeeded" });
  const queuePath = join(homeDir, "product-analytics", "events.json");
  const queue = JSON.parse(readFileSync(queuePath, "utf8")) as Array<Record<string, unknown>>;
  queue[0]!.id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  writeFileSync(queuePath, JSON.stringify(queue));
  analytics.dispose();

  const restored = new ProductAnalytics({
    homeDir,
    channel: "beta",
    appVersion: "1.0.0-beta.1",
    platform: "darwin",
    fetcher,
  });
  await restored.flush();
  expect(fetcher).not.toHaveBeenCalled();
  expect(JSON.parse(readFileSync(queuePath, "utf8"))).toEqual([]);
  restored.dispose();
});

it("keeps opt-out in memory after a persistence error and retries durable opt-out", () => {
  const root = makeRoot();
  const homeDir = join(root, "home");
  const analyticsDir = join(homeDir, "product-analytics");
  const movedDir = join(root, "saved-analytics");
  const analytics = new ProductAnalytics({
    homeDir,
    channel: "stable",
    appVersion: "1.0.0",
    platform: "linux",
    fetcher: vi.fn(async () => new Response(null, { status: 204 })),
  });
  analytics.setEnabled(true);
  analytics.track({ event: "app.open", outcome: "succeeded" });

  renameSync(analyticsDir, movedDir);
  writeFileSync(analyticsDir, "blocks consent storage");
  expect(() => analytics.setEnabled(false)).toThrow();
  expect(analytics.getState()).toEqual({ enabled: false });

  rmSync(analyticsDir);
  renameSync(movedDir, analyticsDir);
  expect(analytics.setEnabled(false)).toEqual({ enabled: false });
  const restored = new ProductAnalytics({
    homeDir,
    channel: "stable",
    appVersion: "1.0.0",
    platform: "linux",
  });
  expect(restored.getState()).toEqual({ enabled: false });
  expect(existsSync(join(analyticsDir, "install-id"))).toBe(false);
  analytics.dispose();
  restored.dispose();
});

it.each(["cleanup", "consent"] as const)(
  "revokes companion uploads even when %s persistence fails",
  async (failure) => {
    const homeDir = makeRoot();
    const analytics = new ProductAnalytics({
      homeDir,
      channel: "remote",
      appVersion: "1.0.6-remote.18",
      platform: "darwin",
      fetcher: vi.fn(async () => new Response(null, { status: 204 })),
    });
    analytics.setEnabled(true);
    analytics.track({ event: "app.open", outcome: "succeeded" });
    const diagnostics = new BetaDiagnostics({
      homeDir,
      flavor: "remote",
      appVersion: "1.0.6-remote.18",
      platform: "darwin",
      arch: "arm64",
      env: {},
      isEnabled: () => analytics.getState().enabled,
    });
    analytics.onChange((enabled) => {
      if (!enabled) diagnostics.discardQueue();
    });
    let resolveHeld: (response: Response) => void;
    const held = new Promise<Response>((resolve) => {
      resolveHeld = resolve;
    });
    const request = { signal: null as AbortSignal | null };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      request.signal = init?.signal ?? null;
      return held;
    });
    diagnostics.track("app.start", { kind: "lifecycle" });
    const upload = diagnostics.flush();
    try {
      const blockedPath = join(
        homeDir,
        "product-analytics",
        failure === "cleanup" ? "events.json" : "consent.json",
      );
      rmSync(blockedPath, { force: true });
      mkdirSync(blockedPath);
      expect(() => analytics.setEnabled(false)).toThrow();
      expect(analytics.getState()).toEqual({ enabled: false });
      expect(request.signal?.aborted).toBe(true);
      expect(existsSync(join(homeDir, "diagnostics", "events.jsonl"))).toBe(false);
    } finally {
      resolveHeld!(new Response(null, { status: 204 }));
      await upload;
      await diagnostics.dispose();
      analytics.dispose();
      fetchSpy.mockRestore();
    }
  },
);

it("does not schedule a retry after disposal aborts a pending send", async () => {
  vi.useFakeTimers();
  const homeDir = makeRoot();
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    return await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  });
  const analytics = new ProductAnalytics({
    homeDir,
    channel: "stable",
    appVersion: "1.0.0",
    platform: "linux",
    fetcher,
  });
  analytics.setEnabled(true);
  analytics.track({ event: "app.open", outcome: "succeeded" });
  const pending = analytics.flush();
  expect(fetcher).toHaveBeenCalledOnce();
  analytics.dispose();
  await pending;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetcher).toHaveBeenCalledOnce();
  vi.useRealTimers();
});

it("shares Remote usage by default until the user opts out, and reports daily activity", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T10:00:00.000Z"));
  const homeDir = makeRoot();
  const queued = () =>
    JSON.parse(readFileSync(join(homeDir, "product-analytics", "events.json"), "utf8")) as Array<
      Record<string, unknown>
    >;
  const make = () =>
    new ProductAnalytics({
      homeDir,
      channel: "remote",
      appVersion: "1.0.6-remote.17",
      platform: "win32",
      defaultEnabled: true,
      fetcher: vi.fn(async () => new Response(null, { status: 503 })),
    });
  const analytics = make();
  const changes: boolean[] = [];
  analytics.onChange((enabled) => changes.push(enabled));
  expect(analytics.getState()).toEqual({ enabled: true });

  analytics.start();
  analytics.track({ event: "connection.connect", outcome: "failed", reason: "not_accepting" });
  // A cause belongs to a failure only.
  analytics.track({ event: "chat.request", outcome: "succeeded", reason: "timeout" });
  expect(queued().map((event) => [event.event, event.channel, event.reason])).toEqual([
    ["app.active", "remote", undefined],
    ["connection.connect", "remote", "not_accepting"],
  ]);

  // Same UTC day: no second heartbeat. Next day: one more.
  vi.advanceTimersByTime(60_000);
  expect(queued().filter((event) => event.event === "app.active")).toHaveLength(1);
  vi.setSystemTime(new Date("2026-10-18T00:00:30.000Z"));
  vi.advanceTimersByTime(30_000);
  expect(queued().filter((event) => event.event === "app.active")).toHaveLength(2);

  analytics.setEnabled(false);
  expect(make().getState()).toEqual({ enabled: false });
  analytics.setEnabled(true);
  expect(queued().map((event) => event.event)).toEqual(["app.active"]);
  analytics.setEnabled(false);
  analytics.dispose();
  expect(changes).toEqual([false, true, false]);
});

it("rotates legacy account-linked identity and discards unsent legacy telemetry", async () => {
  const homeDir = makeRoot();
  const fetcher = vi.fn(
    async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
  );
  const make = () =>
    new ProductAnalytics({
      homeDir,
      channel: "remote",
      appVersion: "1.0.6-remote.18",
      platform: "darwin",
      defaultEnabled: true,
      fetcher,
    });
  const analytics = make();
  analytics.track({ event: "app.open", outcome: "succeeded" });
  analytics.dispose();
  const dir = join(homeDir, "product-analytics");
  const path = join(dir, "events.json");
  const old = JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, unknown>>;
  const oldInstallId = old[0]!.installId;
  rmSync(join(dir, "identity-version"), { force: true });
  old[0]!.accountHash = "aabeca326019f52e2e13cbab8574fcac";
  writeFileSync(path, JSON.stringify(old));
  writeFileSync(join(dir, "account-hash"), "aabeca326019f52e2e13cbab8574fcac");
  const restored = make();
  expect(existsSync(join(dir, "account-hash"))).toBe(false);
  const newInstallId = readFileSync(join(dir, "install-id"), "utf8").trim();
  expect(newInstallId).not.toBe(oldInstallId);
  expect(existsSync(path)).toBe(false);
  restored.track({
    event: "app.open",
    outcome: "succeeded",
    accountHash: "untrusted",
    userId: "private-user",
  });
  await restored.flush();
  const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as {
    events: Array<Record<string, unknown>>;
  };
  expect(body.events).toHaveLength(1);
  expect(body.events[0]?.installId).toBe(newInstallId);
  expect(body.events.every((event) => !Object.hasOwn(event, "accountHash"))).toBe(true);
  expect(JSON.stringify(body)).not.toContain("private-user");
  restored.dispose();
});

it("keeps an unreadable recorded choice off instead of falling back to the default", () => {
  const homeDir = makeRoot();
  // A directory in place of the consent file makes the read fail without ENOENT.
  mkdirSync(join(homeDir, "product-analytics", "consent.json"), { recursive: true });
  const analytics = new ProductAnalytics({
    homeDir,
    channel: "remote",
    appVersion: "1.0.6-remote.17",
    platform: "darwin",
    defaultEnabled: true,
  });
  expect(analytics.getState()).toEqual({ enabled: false });
});

it("negotiates before entry, reports each return window once across restarts, and resets with opt-out", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
  const homeDir = makeRoot();
  const cohortPath = join(homeDir, "product-analytics", "cohort.json");
  let supported = false;
  const received: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const events = JSON.parse(String(init?.body)).events as Array<Record<string, unknown>>;
    received.push(...events);
    return Response.json(
      {
        cohortAcknowledged: supported
          ? events.filter((event) => event.cohortStage).map((event) => event.id)
          : [],
      },
      { headers: supported ? { "x-synara-product-cohorts": "1" } : {} },
    );
  });
  const make = () =>
    new ProductAnalytics({
      homeDir,
      channel: "remote",
      appVersion: "1.2.3",
      platform: "darwin",
      defaultEnabled: true,
      fetcher,
    });
  let analytics = make();
  analytics.start();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  expect(existsSync(cohortPath)).toBe(false);
  supported = true;
  analytics.track({
    event: "app.open",
    outcome: "succeeded",
    cohortDay: "private-name",
    cohortStage: "new",
  });
  await vi.waitFor(() =>
    expect(JSON.parse(readFileSync(cohortPath, "utf8")).completed).toEqual(["new"]),
  );
  expect(received.filter((event) => event.cohortStage).map((event) => event.cohortDay)).toEqual([
    "2026-07-01",
  ]);
  const firstId = received.find((event) => event.cohortStage === "new")!.installId;
  for (const [offset, stages] of [
    [7, ["new", "week1"]],
    [10, ["new", "week1"]],
    [30, ["new", "week1", "month1"]],
    [36, ["new", "week1", "month1"]],
  ] as const) {
    analytics.dispose();
    vi.setSystemTime(new Date(Date.parse("2026-07-01T12:00:00.000Z") + offset * 86400000));
    analytics = make();
    analytics.start();
    await vi.waitFor(() =>
      expect(JSON.parse(readFileSync(cohortPath, "utf8")).completed).toEqual(stages),
    );
  }
  expect(received.filter((event) => event.cohortStage).map((event) => event.cohortStage)).toEqual([
    "new",
    "week1",
    "month1",
  ]);
  analytics.setEnabled(false);
  expect(existsSync(cohortPath)).toBe(false);
  analytics.setEnabled(true);
  await vi.waitFor(() =>
    expect(JSON.parse(readFileSync(cohortPath, "utf8")).completed).toEqual(["new"]),
  );
  expect(received.filter((event) => event.cohortStage === "new").at(-1)?.installId).not.toBe(
    firstId,
  );
  analytics.dispose();
});

it("recovers a queued entry after interrupted state persistence and retries its stable UUID", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-01T12:00:00.000Z"));
  const homeDir = makeRoot();
  const cohortPath = join(homeDir, "product-analytics", "cohort.json");
  const ids: unknown[] = [];
  let fail = true;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const events = JSON.parse(String(init?.body)).events as Array<Record<string, unknown>>;
    const entries = events.filter((event) => event.cohortStage);
    ids.push(...entries.map((event) => event.id));
    if (entries.length && fail) throw new Error("synthetic response loss");
    return Response.json(
      { cohortAcknowledged: entries.map((event) => event.id) },
      { headers: { "x-synara-product-cohorts": "1" } },
    );
  });
  const make = () =>
    new ProductAnalytics({
      homeDir,
      channel: "remote",
      appVersion: "1.2.3",
      platform: "darwin",
      defaultEnabled: true,
      fetcher,
    });
  const first = make();
  first.start();
  await vi.waitFor(() => expect(ids).toHaveLength(1));
  first.dispose();
  rmSync(cohortPath);
  fail = false;
  const restored = make();
  restored.start();
  await vi.waitFor(() =>
    expect(JSON.parse(readFileSync(cohortPath, "utf8")).completed).toEqual(["new"]),
  );
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  restored.dispose();
});

it("cannot restore cohort files when opt-out races an asynchronous receipt body", async () => {
  const homeDir = makeRoot();
  let resolveReceipt!: (value: unknown) => void;
  let receiptPending = false;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const events = JSON.parse(String(init?.body)).events as Array<Record<string, unknown>>;
    if (events.some((event) => event.cohortStage))
      return {
        ok: true,
        headers: new Headers({ "x-synara-product-cohorts": "1" }),
        json: () => {
          receiptPending = true;
          return new Promise((resolve) => {
            resolveReceipt = resolve;
          });
        },
      } as Response;
    return Response.json({}, { headers: { "x-synara-product-cohorts": "1" } });
  });
  const analytics = new ProductAnalytics({
    homeDir,
    channel: "remote",
    appVersion: "1.2.3",
    platform: "darwin",
    defaultEnabled: true,
    fetcher,
  });
  analytics.start();
  await vi.waitFor(() => expect(receiptPending).toBe(true));
  analytics.setEnabled(false);
  resolveReceipt({ cohortAcknowledged: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(existsSync(join(homeDir, "product-analytics", "cohort.json"))).toBe(false);
  expect(existsSync(join(homeDir, "product-analytics", "events.json"))).toBe(false);
  expect(existsSync(join(homeDir, "product-analytics", "install-id"))).toBe(false);
  analytics.dispose();
});

it("prefers a durable replacement entry over valid stale cohort state after restart", async () => {
  vi.useFakeTimers();
  const origin = Date.parse("2026-07-01T12:00:00.000Z");
  vi.setSystemTime(origin);
  const homeDir = makeRoot();
  const cohortPath = join(homeDir, "product-analytics", "cohort.json");
  const queuePath = join(homeDir, "product-analytics", "events.json");
  const entries: Array<Record<string, unknown>> = [];
  let fail = true;
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const events = JSON.parse(String(init?.body)).events as Array<Record<string, unknown>>;
    const cohortEvents = events.filter((event) => event.cohortStage);
    entries.push(...cohortEvents);
    if (cohortEvents.length && fail) throw new Error("synthetic response loss");
    return Response.json(
      { cohortAcknowledged: cohortEvents.map((event) => event.id) },
      { headers: { "x-synara-product-cohorts": "1" } },
    );
  });
  const make = () =>
    new ProductAnalytics({
      homeDir,
      channel: "remote",
      appVersion: "1.2.3",
      platform: "darwin",
      defaultEnabled: true,
      fetcher,
    });
  const first = make();
  first.start();
  await vi.waitFor(() => expect(entries).toHaveLength(1));
  first.dispose();
  const priorState = readFileSync(cohortPath, "utf8");
  vi.setSystemTime(origin + 8 * 86400000);
  const replacement = make();
  replacement.start();
  await vi.waitFor(() =>
    expect(entries.some((event) => event.cohortDay === "2026-07-09")).toBe(true),
  );
  replacement.dispose();
  // Crash snapshot: the real replacement queue survived, but the previous state bytes remained.
  writeFileSync(cohortPath, priorState);
  expect(JSON.parse(readFileSync(cohortPath, "utf8")).day).toBe("2026-07-01");
  expect(
    JSON.parse(readFileSync(queuePath, "utf8"))
      .filter((event: Record<string, unknown>) => event.cohortStage)
      .map((event: Record<string, unknown>) => event.cohortDay),
  ).toEqual(["2026-07-09"]);
  entries.length = 0;
  fail = false;
  vi.setSystemTime(origin + 9 * 86400000);
  const restored = make();
  restored.start();
  await vi.waitFor(() =>
    expect(JSON.parse(readFileSync(cohortPath, "utf8")).completed).toEqual(["new"]),
  );
  expect(entries.map((event) => event.cohortDay)).toEqual(["2026-07-09"]);
  expect(JSON.parse(readFileSync(cohortPath, "utf8")).day).toBe("2026-07-09");
  restored.dispose();
});

it("emits the independent shared native UUID vectors from the real desktop sender", async () => {
  vi.useFakeTimers();
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        "../../../packages/contracts/fixtures/product-analytics/cohort-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { events: Array<Record<string, string | number>> };
  const homeDir = makeRoot();
  const analyticsDir = join(homeDir, "product-analytics");
  mkdirSync(analyticsDir, { recursive: true });
  writeFileSync(join(analyticsDir, "install-id"), String(fixture.events[0]!.installId));
  // The shared vector represents an established identity, including the privacy reset version.
  writeFileSync(join(analyticsDir, "identity-version"), "2\n");
  const emitted: Array<Record<string, unknown>> = [];
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const events = JSON.parse(String(init?.body)).events as Array<Record<string, unknown>>;
    const cohortEvents = events.filter((event) => event.cohortStage);
    emitted.push(...cohortEvents);
    return Response.json(
      { cohortAcknowledged: cohortEvents.map((event) => event.id) },
      { headers: { "x-synara-product-cohorts": "1" } },
    );
  });
  for (const expected of fixture.events) {
    vi.setSystemTime(new Date(String(expected.ts)));
    const analytics = new ProductAnalytics({
      homeDir,
      channel: "remote",
      appVersion: "1.4.0",
      platform: "darwin",
      defaultEnabled: true,
      fetcher,
    });
    analytics.start();
    // Settle immediate receipts without moving the fixture's event clock forward.
    await vi.advanceTimersByTimeAsync(0);
    expect(emitted.some((event) => event.cohortStage === expected.cohortStage)).toBe(true);
    analytics.dispose();
    expect(emitted.find((event) => event.cohortStage === expected.cohortStage)).toEqual({
      ...expected,
      ts: new Date(String(expected.ts)).toISOString(),
      surface: "desktop",
      platform: "darwin",
    });
  }
});
