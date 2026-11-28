import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FetchJsonResult } from "./http";

const fetchJson = vi.fn<(input: Record<string, unknown>) => Promise<FetchJsonResult>>();
vi.mock("./http", () => ({ fetchJson: (input: Record<string, unknown>) => fetchJson(input) }));

const { normalizeUsageHubUrl, parseHubAccounts, readUsageHub, usageHubAccountKey, usageHubLabel } =
  await import("./usageHubs");

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const hub = { id: "hub-1", url: "https://hub.example.ts.net:8318", managementKey: "secret" };

function response(status: number, json: unknown): FetchJsonResult {
  return { status, ok: status >= 200 && status < 300, json, headers: new Headers() };
}

beforeEach(() => {
  fetchJson.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeUsageHubUrl", () => {
  it("keeps https and loopback http origins, dropping any path", () => {
    expect(normalizeUsageHubUrl(" https://hub.example.ts.net:8318/management.html ")).toBe(
      "https://hub.example.ts.net:8318",
    );
    expect(normalizeUsageHubUrl("http://127.0.0.1:8317")).toBe("http://127.0.0.1:8317");
  });

  it("rejects plain http to other hosts and invalid URLs", () => {
    expect(() => normalizeUsageHubUrl("http://192.168.1.5:8317")).toThrow(/https:\/\//);
    expect(() => normalizeUsageHubUrl("hub.local")).toThrow(/full URL/);
  });
});

describe("usageHubLabel", () => {
  it("falls back to the host", () => {
    expect(usageHubLabel({ url: hub.url })).toBe("hub.example.ts.net:8318");
    expect(usageHubLabel({ url: hub.url, label: " Home " })).toBe("Home");
  });
});

describe("parseHubAccounts", () => {
  it("keeps enabled Codex and Claude accounts only", () => {
    const accounts = parseHubAccounts({
      files: [
        {
          id: "a.json",
          auth_index: "0",
          provider: "codex",
          email: "a@x.dev",
          id_token: { chatgpt_account_id: "acct-1" },
        },
        { id: "b.json", auth_index: 1, provider: "claude" },
        { id: "c.json", auth_index: "2", provider: "gemini" },
        { id: "d.json", auth_index: "3", provider: "codex", disabled: true },
        { id: "e.json", provider: "claude" },
      ],
    });
    expect(accounts).toEqual([
      {
        id: "a.json",
        authIndex: "0",
        provider: "codex",
        email: "a@x.dev",
        chatgptAccountId: "acct-1",
      },
      {
        id: "b.json",
        authIndex: "1",
        provider: "claude",
        email: undefined,
        chatgptAccountId: undefined,
      },
    ]);
    expect(parseHubAccounts(null)).toEqual([]);
  });
});

describe("readUsageHub", () => {
  it("reads each pooled account through the hub's api-call", async () => {
    fetchJson.mockImplementation(async (input) => {
      const url = String(input.url);
      if (url.endsWith("/v0/management/auth-files")) {
        return response(200, {
          files: [
            { id: "codex.json", auth_index: "0", provider: "codex", email: "c@x.dev" },
            { id: "claude.json", auth_index: "1", provider: "claude" },
          ],
        });
      }
      const body = input.body as { auth_index: string; url: string };
      if (body.auth_index === "0") {
        return response(200, {
          status_code: 200,
          body: JSON.stringify({
            plan_type: "pro",
            rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000 } },
          }),
        });
      }
      return response(200, { status_code: 429, body: "{}" });
    });

    const result = await readUsageHub(hub, NOW);

    expect(fetchJson).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://hub.example.ts.net:8318/v0/management/auth-files",
        headers: expect.objectContaining({ Authorization: "Bearer secret" }),
        allowPrivateAddress: true,
      }),
    );
    expect(result.error).toBeUndefined();
    expect(result.accounts).toHaveLength(2);
    const [codex, claude] = result.accounts;
    expect(codex).toMatchObject({ id: "codex.json", email: "c@x.dev" });
    // A stable, slug-safe key doubles as the snapshot's instance id.
    expect(codex?.key).toMatch(/^hub_[0-9a-f]{24}$/);
    expect(codex?.usage.instanceId).toBe(codex?.key);
    expect(codex?.key).toBe(usageHubAccountKey("hub-1", "codex.json"));
    expect(claude?.key).not.toBe(codex?.key);
    expect(codex?.usage).toMatchObject({ provider: "codex", status: "ok", planName: "Pro" });
    expect(codex?.usage.limits[0]).toMatchObject({ window: "5h", usedPercent: 42 });
    expect(claude?.usage).toMatchObject({ provider: "claudeAgent", status: "error" });
    expect(claude?.usage.detail).toContain("HTTP 429");
  });

  it("keeps the hub row with an error when the key is rejected or the hub is down", async () => {
    fetchJson.mockResolvedValueOnce(response(401, null));
    expect(await readUsageHub(hub, NOW)).toMatchObject({
      id: "hub-1",
      accounts: [],
      error: "The hub rejected the management key.",
    });

    fetchJson.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect((await readUsageHub(hub, NOW)).error).toBe("Could not reach the hub.");
  });
});
