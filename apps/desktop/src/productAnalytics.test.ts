import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { ProductAnalytics } from "./productAnalytics";

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

  analytics.setEnabled(false);
  expect(analytics.getState()).toEqual({ enabled: false });
  expect(existsSync(join(homeDir, "product-analytics", "install-id"))).toBe(false);
  expect(existsSync(join(homeDir, "product-analytics", "events.json"))).toBe(false);

  analytics.setEnabled(true);
  const secondInstallId = readFileSync(
    join(homeDir, "product-analytics", "install-id"),
    "utf8",
  ).trim();
  expect(secondInstallId).not.toBe(firstInstallId);
  analytics.track({ event: "turn.completed", outcome: "succeeded", inputTokens: 120 });

  const restored = new ProductAnalytics({
    homeDir,
    channel: "beta",
    appVersion: "1.2.3-beta.1",
    platform: "darwin",
    fetcher,
  });
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
