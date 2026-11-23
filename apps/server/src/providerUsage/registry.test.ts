// FILE: providerUsage/registry.test.ts
// Purpose: Verify usage support and keep signed-in Antigravity credentials outside usage polling.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import { PROVIDER_USAGE_PROVIDERS } from "@synara/shared/providerUsage";

import { collectProviderUsageSnapshots } from "./index";
import { PROVIDER_USAGE_FETCHERS } from "./registry";

describe("provider usage registry", () => {
  it("registers a fetcher for every usage-capable provider", () => {
    expect(PROVIDER_USAGE_PROVIDERS.every((provider) => PROVIDER_USAGE_FETCHERS[provider])).toBe(
      true,
    );
  });

  it("does not fetch usage for a signed-in Antigravity profile", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "synara-agy-usage-"));
    const request = vi.spyOn(outboundHttp, "request").mockRejectedValue(new Error("Offline test"));
    try {
      const credentialDir = path.join(homeDir, ".gemini", "antigravity-cli");
      await mkdir(credentialDir, { recursive: true });
      await writeFile(
        path.join(credentialDir, "antigravity-oauth-token"),
        JSON.stringify({
          auth_method: "consumer",
          token: { access_token: "test-access", expiry: "2026-12-01T00:00:00.000Z" },
        }),
      );

      const result = await collectProviderUsageSnapshots(
        { homeDir, env: {}, platform: process.platform, nowMs: Date.parse("2026-11-23") },
        { provider: "antigravity", forceRefresh: true },
      );

      expect(request).not.toHaveBeenCalled();
      expect(result).toEqual([]);
    } finally {
      request.mockRestore();
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});
