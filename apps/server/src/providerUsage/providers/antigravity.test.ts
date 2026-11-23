// FILE: providerUsage/providers/antigravity.test.ts
// Purpose: Protect the official `/usage` response boundary and honest signed-out/error states.

import { afterEach, describe, expect, it, vi } from "vitest";

import { runAntigravityHelperProcess } from "../../provider/antigravityCli";
import { antigravityUsageFetcher } from "./antigravity";

vi.mock("../../provider/antigravityCli", () => ({ runAntigravityHelperProcess: vi.fn() }));

const run = vi.mocked(runAntigravityHelperProcess);
const ctx = { homeDir: "/unused", env: {}, platform: process.platform, nowMs: 0 };

function nativeOutput(groups: unknown[], numTurns = 0) {
  return JSON.stringify({
    status: "SUCCESS",
    num_turns: numTurns,
    command: { name: "usage", data: { groups } },
  });
}

afterEach(() => run.mockReset());

describe("Antigravity live limits", () => {
  it("renders the CLI buckets for Gemini, third-party models, and plan-specific groups", async () => {
    run.mockResolvedValue({
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
    run.mockResolvedValue(result);
    const snapshot = await antigravityUsageFetcher.fetch(ctx);
    expect(snapshot).toMatchObject({ status, limits: [] });
    expect(snapshot.detail ?? "").not.toMatch(
      /https:\/\/accounts\.google\.com|raw provider diagnostic/u,
    );
  });
});
