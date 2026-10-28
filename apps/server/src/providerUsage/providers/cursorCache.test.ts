// FILE: providerUsage/providers/cursorCache.test.ts
// Purpose: Exercise Cursor credential reads through the public usage cache, with synthetic
// encrypted cells and a mocked OS process boundary; never accesses a real keychain.

import * as childProcess from "node:child_process";

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { outboundHttp } from "@synara/shared/outboundHttp";

import { __resetProviderUsageCacheForTests, collectProviderUsageSnapshots } from "../index";
import { readItemTableValues } from "../sqlite";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: vi.fn(),
}));
vi.mock("../sqlite", () => ({ readItemTableValues: vi.fn() }));
vi.mock("../credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credentials")>()),
  readKeychainPassword: vi.fn(async () => null),
}));
vi.mock("../registry", async () => ({
  PROVIDER_USAGE_FETCHERS: { cursor: (await import("./cursor")).cursorUsageFetcher },
}));

// OpenSSL AES-CBC fixtures using Chromium's macOS v10 parameters, not the decryptor.
const SEALED = "cursor-safe-storage:v1:djEwoQNoqjHiFmFD35qI68RBs/vxcCaCsYn57EBJrXoOTKs=";
const ROTATED = "cursor-safe-storage:v1:djEwLDraZMSDmhOIL07ikXjTH7o7qTFxN0adkylMnjI4dgs=";
const ctx = {
  homeDir: "/fixture-cursor-home",
  env: {},
  platform: "darwin" as const,
  nowMs: 1_780_000_000_000,
};

beforeEach(() => {
  __resetProviderUsageCacheForTests();
  vi.mocked(readItemTableValues).mockResolvedValue({ "cursorAuth/accessToken": SEALED });
  vi.mocked(childProcess.execFile).mockImplementation(((
    _file: string,
    _args: string[],
    _options: childProcess.ExecFileOptionsWithStringEncoding,
    callback: (
      error: childProcess.ExecFileException | null,
      stdout: string,
      stderr: string,
    ) => void,
  ) => {
    const child = new childProcess.ChildProcess();
    queueMicrotask(() => callback(null, "fixture-password", ""));
    return child;
  }) as typeof childProcess.execFile);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("unseals once for coalesced requests, skips keychain on cache hits, and refreshes rotated cells", async () => {
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
  const request = vi.spyOn(outboundHttp, "request").mockImplementation(async () => {
    await pending;
    return {
      status: 200,
      headers: new Headers(),
      body: new TextEncoder().encode("{}"),
      url: "https://api2.cursor.sh",
    };
  });

  const firstPromise = collectProviderUsageSnapshots(ctx, { provider: "cursor" });
  const secondPromise = collectProviderUsageSnapshots(ctx, { provider: "cursor" });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  const readsBeforeResponse = vi.mocked(childProcess.execFile).mock.calls.length;
  release();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  expect(first[0]?.status).toBe("ok");
  expect(second).toEqual(first);
  expect(readsBeforeResponse).toBe(1);
  expect(childProcess.execFile).toHaveBeenCalledTimes(1);
  expect(new Headers(request.mock.calls[0]?.[0].headers).get("authorization")).toBe(
    "Bearer fixture-cursor-access-token",
  );

  expect(
    await collectProviderUsageSnapshots(
      { ...ctx, nowMs: ctx.nowMs + 1_000 },
      { provider: "cursor" },
    ),
  ).toEqual(first);
  expect(childProcess.execFile).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(2);

  vi.mocked(readItemTableValues).mockResolvedValue({ "cursorAuth/accessToken": ROTATED });
  const rotated = await collectProviderUsageSnapshots(
    { ...ctx, nowMs: ctx.nowMs + 2_000 },
    { provider: "cursor" },
  );
  expect(rotated[0]?.status).toBe("ok");
  expect(childProcess.execFile).toHaveBeenCalledTimes(2);
  expect(new Headers(request.mock.calls[2]?.[0].headers).get("authorization")).toBe(
    "Bearer fixture-cursor-rotated-token",
  );
});
