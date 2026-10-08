import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeV2Client } from "./openCodeV2Client.ts";
import type { OpenCodeV2Fetch } from "./openCodeV2TransportHttp.ts";

const model = {
  id: "muse-spark",
  providerID: "opencode",
  name: "Muse Spark",
  enabled: true,
  limit: { context: 128_000, output: 16_000 },
  capabilities: { tools: true, input: ["text"], output: ["text"] },
};

function fixture(
  respond: (path: string, init?: RequestInit) => unknown | Response | Promise<unknown>,
) {
  const calls: Array<{ path: string; headers: Headers; signal: AbortSignal | null | undefined }> =
    [];
  const fetch: OpenCodeV2Fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push({ path, headers: new Headers(init?.headers), signal: init?.signal });
    const value = await respond(path, init);
    return value instanceof Response ? value : Response.json(value);
  };
  return {
    calls,
    client: createOpenCodeV2Client({
      baseUrl: "http://localhost:5555",
      directory: "/default",
      username: "opencode",
      password: "test-secret",
      fetch,
    }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("OpenCode v2 catalog settling", () => {
  it("waits for a raw empty inventory before reading provider metadata once", async () => {
    let reads = 0;
    const controller = new AbortController();
    const { client, calls } = fixture((path) =>
      path === "/api/model"
        ? { data: ++reads === 1 ? [] : [model, { ...model, providerID: "openrouter" }] }
        : {
            data: [
              { id: "opencode", name: "OpenCode Zen" },
              { id: "openrouter", name: "OpenRouter" },
            ],
          },
    );
    const result = await client.provider.list(
      { directory: "/a path/日本語" },
      { signal: controller.signal },
    );
    expect(calls.map((call) => call.path)).toEqual(["/api/model", "/api/model", "/api/provider"]);
    expect(result.data?.connected).toEqual(["opencode", "openrouter"]);
    expect(result.data?.all.map((provider) => provider.name)).toEqual([
      "OpenCode Zen",
      "OpenRouter",
    ]);
    for (const call of calls) {
      expect(call.headers.get("authorization")).toBe(
        `Basic ${Buffer.from("opencode:test-secret").toString("base64")}`,
      );
      expect(call.headers.get("x-opencode-directory")).toBe(encodeURIComponent("/a path/日本語"));
    }
    controller.abort();
    expect(calls.every((call) => call.signal?.aborted)).toBe(true);
  });

  it("returns a legitimately empty catalog after exactly five model reads", async () => {
    const { client, calls } = fixture(() => []);
    const result = await client.provider.list();
    expect(calls.map((call) => call.path)).toEqual([
      "/api/model",
      "/api/model",
      "/api/model",
      "/api/model",
      "/api/model",
      "/api/provider",
    ]);
    expect(result.data).toEqual({ all: [], connected: [], default: {} });
  }, 12_000);

  it.each(["model-disabled", "provider-disabled"])(
    "does not poll a nonempty %s inventory after filtering",
    async (disabled) => {
      const { client, calls } = fixture((path) =>
        path === "/api/model"
          ? [{ ...model, enabled: disabled !== "model-disabled" }]
          : [
              {
                id: "opencode",
                activation: disabled === "provider-disabled" ? "disabled" : "enabled",
              },
            ],
      );
      expect((await client.provider.list()).data?.all).toEqual([]);
      expect(calls.map((call) => call.path)).toEqual(["/api/model", "/api/provider"]);
    },
  );

  it.each([
    { response: { models: [] }, error: "expected an array" },
    { response: new Response("not json"), error: "invalid JSON" },
    { response: new Response("unavailable", { status: 503 }), error: "HTTP 503" },
  ])("does not retry malformed or failed model reads: $error", async ({ response, error }) => {
    const { client, calls } = fixture(() => response);
    await expect(client.provider.list()).rejects.toThrow(error);
    expect(calls.map((call) => call.path)).toEqual(["/api/model"]);
  });

  it("cancels the real settling wait without dispatching another model or provider read", async () => {
    const controller = new AbortController();
    const { client, calls } = fixture(() => []);
    const pending = client.provider.list({}, { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await rejection;
    expect(calls.map((call) => call.path)).toEqual(["/api/model"]);
  });

  it("forwards cancellation to an in-flight model read", async () => {
    const controller = new AbortController();
    const { client, calls } = fixture(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const pending = client.provider.list({}, { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    controller.abort();
    await rejection;
    expect(calls).toHaveLength(1);
  });

  it("does not dispatch a catalog read after caller cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const { client, calls } = fixture(() => []);
    await expect(client.provider.list({}, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(calls).toEqual([]);
  });

  it("forwards cancellation while provider metadata is being read", async () => {
    const controller = new AbortController();
    const { client, calls } = fixture((path, init) => {
      if (path === "/api/model") return [model];
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending = client.provider.list({}, { signal: controller.signal });
    const rejection = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    controller.abort();
    await rejection;
    expect(calls.map((call) => call.path)).toEqual(["/api/model", "/api/provider"]);
  });

  it("expires the settling deadline during the real empty-inventory wait", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    let settlingDeadlineCreated = false;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
      if (duration === 15_000 && !settlingDeadlineCreated) {
        settlingDeadlineCreated = true;
        return nativeTimeout(20);
      }
      return nativeTimeout(duration);
    });
    const { client, calls } = fixture(() => []);
    await expect(client.provider.list()).rejects.toMatchObject({
      name: "AbortError",
      cause: { name: "TimeoutError" },
    });
    expect(calls.map((call) => call.path)).toEqual(["/api/model"]);
  });

  it("expires the total catalog budget while provider metadata is pending", async () => {
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) =>
      nativeTimeout(duration === 30_000 ? 20 : duration),
    );
    const { client, calls } = fixture((path, init) => {
      if (path === "/api/model") return [model];
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    await expect(client.provider.list()).rejects.toMatchObject({ name: "TimeoutError" });
    expect(calls.map((call) => call.path)).toEqual(["/api/model", "/api/provider"]);
  });
});
