// FILE: providerUsage/providers/antigravity.test.ts
// Purpose: Protect the official `/usage` response boundary and honest signed-out/error states.

import { defaultInstanceIdForProvider } from "@synara/shared/providerInstances";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runAntigravityHelperProcess } from "../../provider/antigravityCli";
import { __resetProviderUsageCacheForTests, collectProviderUsageSnapshots } from "../index";
import { antigravityUsageFetcher } from "./antigravity";

vi.mock("../../provider/antigravityCli", () => ({ runAntigravityHelperProcess: vi.fn() }));

const run = vi.mocked(runAntigravityHelperProcess);
const ctx = { homeDir: "/unused", env: {}, platform: process.platform, nowMs: 0 };

const supportedVersion = { code: 0, stderr: "", stdout: "agy 1.1.11" };

function nativeOutput(groups: unknown[], numTurns = 0) {
  return JSON.stringify({
    status: "SUCCESS",
    num_turns: numTurns,
    command: { name: "usage", data: { groups } },
  });
}

afterEach(() => {
  run.mockReset();
  __resetProviderUsageCacheForTests();
});

describe("Antigravity live limits", () => {
  it("renders the CLI buckets for Gemini, third-party models, and plan-specific groups", async () => {
    run.mockResolvedValueOnce(supportedVersion).mockResolvedValueOnce({
      code: 0,
      stderr: "",
      stdout: nativeOutput([
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-5h",
              window: "5h",
              remaining_fraction: 0,
              reset_time: "2026-11-23T18:00:00Z",
            },
            { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.75 },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            { id: "3p-weekly", window: "weekly", remaining_fraction: 1 },
            { id: "3p-5h", window: "5h", remaining_fraction: 1, disabled: true },
          ],
        },
        {
          name: "Gemini 4 Argon",
          buckets: [{ id: "gemini-argon-wtu-weekly", window: "weekly", remaining_fraction: 0.5 }],
        },
      ]),
    });

    const snapshot = await antigravityUsageFetcher.fetch(ctx);
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toEqual([
      {
        window: "5h",
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: "2026-11-23T18:00:00.000Z",
      },
      { window: "Weekly", usedPercent: 25, windowDurationMins: 10_080 },
      { window: "Claude and GPT models Weekly", usedPercent: 0 },
      { window: "Gemini 4 Argon Weekly", usedPercent: 50 },
    ]);
  });

  it("coalesces pending requests then reads the next native login state in the same profile", async () => {
    const initial =
      Promise.withResolvers<Awaited<ReturnType<typeof runAntigravityHelperProcess>>>();
    run
      .mockResolvedValueOnce(supportedVersion)
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValueOnce(supportedVersion)
      .mockResolvedValueOnce({
        code: 1,
        stderr: "Authentication required. Please visit the URL to log in",
        stdout: "",
      });
    const selectedProfile = { ...ctx, instanceId: defaultInstanceIdForProvider("antigravity") };
    const query = { provider: "antigravity" } as const;
    const first = collectProviderUsageSnapshots(selectedProfile, query);
    const concurrent = collectProviderUsageSnapshots(selectedProfile, query);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    initial.resolve({
      code: 0,
      stderr: "",
      stdout: nativeOutput([
        {
          name: "Gemini Models",
          buckets: [{ id: "gemini-5h", window: "5h", remaining_fraction: 0.5 }],
        },
      ]),
    });
    const snapshots = await first;
    expect(await concurrent).toEqual(snapshots);
    expect(run).toHaveBeenCalledTimes(2);
    expect(snapshots).toMatchObject([
      { status: "ok", limits: [{ window: "5h", usedPercent: 50 }] },
    ]);

    const signedOut = await collectProviderUsageSnapshots(
      { ...selectedProfile, nowMs: 1_000 },
      query,
    );
    expect(run).toHaveBeenCalledTimes(4);
    expect(signedOut).toMatchObject([{ status: "needs-auth", limits: [] }]);
  });

  it.each(["agy 1.1.10", "version unavailable"])(
    "does not send /usage as a prompt when the version probe returns %s",
    async (stdout) => {
      run.mockResolvedValueOnce({ code: 0, stderr: "", stdout });

      const snapshot = await antigravityUsageFetcher.fetch(ctx);

      expect(snapshot.status).toBe("error");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[1]).toEqual(["--version"]);
    },
  );

  it.each([
    {
      name: "interactive authentication",
      code: 1,
      stdout: "",
      stderr:
        "Authentication required. Please visit the URL to log in:\nhttps://accounts.google.com/test",
      status: "needs-auth",
    },
    {
      name: "a successful report without subscription quotas",
      code: 0,
      stdout: nativeOutput([]),
      stderr: "",
      status: "ok",
    },
    {
      name: "a process failure",
      code: 1,
      stdout: "",
      stderr: "raw provider diagnostic",
      status: "error",
    },
    { name: "a model turn", code: 0, stdout: nativeOutput([], 1), stderr: "", status: "error" },
  ])("handles $name without leaking native output", async ({ status, ...result }) => {
    run.mockResolvedValueOnce(supportedVersion).mockResolvedValueOnce(result);
    const snapshot = await antigravityUsageFetcher.fetch(ctx);
    expect(snapshot).toMatchObject({ status, limits: [] });
    expect(snapshot.detail ?? "").not.toMatch(
      /https:\/\/accounts\.google\.com|raw provider diagnostic/u,
    );
  });
});
