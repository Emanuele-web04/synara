// FILE: AntigravityInstaller.test.ts
// Purpose: Verifies pinned-source install, SHA-512 checks, and no-source failures.
// Layer: Server provider maintenance tests

import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ANTIGRAVITY_ACP_DOWNLOAD_URL_ENV,
  ANTIGRAVITY_ACP_PINNED_VERSION,
  ANTIGRAVITY_ACP_SHA512_ENV,
  installAntigravityAcpServer,
  resolveAntigravityAcpInstallSource,
} from "./AntigravityInstaller.ts";

const createdDirs: string[] = [];

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(nodePath.join(tmpdir(), "synara-agy-acp-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function sha512Hex(content: string | Uint8Array): string {
  return createHash("sha512").update(content).digest("hex");
}

describe("resolveAntigravityAcpInstallSource", () => {
  it("returns null when the download source is incomplete", () => {
    expect(resolveAntigravityAcpInstallSource({})).toBeNull();
    expect(
      resolveAntigravityAcpInstallSource({ [ANTIGRAVITY_ACP_DOWNLOAD_URL_ENV]: "https://x/y" }),
    ).toBeNull();
    expect(resolveAntigravityAcpInstallSource({ [ANTIGRAVITY_ACP_SHA512_ENV]: "abc" })).toBeNull();
  });

  it("requires both URL and SHA-512", () => {
    const source = resolveAntigravityAcpInstallSource(
      {
        [ANTIGRAVITY_ACP_DOWNLOAD_URL_ENV]: "https://example.invalid/agy.par",
        [ANTIGRAVITY_ACP_SHA512_ENV]: "A".repeat(128),
      },
      "linux",
    );
    expect(source).toMatchObject({
      version: ANTIGRAVITY_ACP_PINNED_VERSION,
      kind: "par",
      downloadUrl: "https://example.invalid/agy.par",
    });
    expect(source?.sha512).toBe("a".repeat(128));
  });
});

describe("installAntigravityAcpServer", () => {
  it("fails with an actionable error when no source is configured", async () => {
    const home = await makeHome();
    const result = await installAntigravityAcpServer({
      env: {},
      platform: "linux",
      homeDir: home,
    });
    expect(result.outcome).toBe("source-unconfigured");
    expect(result.detail).toContain(ANTIGRAVITY_ACP_DOWNLOAD_URL_ENV);
    expect(result.detail).toContain(ANTIGRAVITY_ACP_SHA512_ENV);
    expect(result.detail).toContain(ANTIGRAVITY_ACP_PINNED_VERSION);
  });

  it("downloads, verifies SHA-512, and installs the executable", async () => {
    const home = await makeHome();
    const payload = "#!/bin/sh\necho agy_acp_server\n";
    const sha512 = sha512Hex(payload);
    const result = await installAntigravityAcpServer({
      env: {
        [ANTIGRAVITY_ACP_DOWNLOAD_URL_ENV]: "https://example.invalid/agy_acp_server",
        [ANTIGRAVITY_ACP_SHA512_ENV]: sha512,
      },
      platform: "linux",
      homeDir: home,
      fetchImpl: async () =>
        new Response(payload, {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
    });
    expect(result.outcome).toBe("installed");
    expect(result.version).toBe(ANTIGRAVITY_ACP_PINNED_VERSION);
    expect(result.executablePath).toContain(nodePath.join(".synara", "acp-servers", "antigravity"));
    const installed = await readFile(result.executablePath!, "utf8");
    expect(installed).toBe(payload);
  });

  it("rejects a SHA-512 mismatch and leaves no executable", async () => {
    const home = await makeHome();
    const result = await installAntigravityAcpServer({
      env: {
        [ANTIGRAVITY_ACP_DOWNLOAD_URL_ENV]: "https://example.invalid/agy_acp_server",
        [ANTIGRAVITY_ACP_SHA512_ENV]: "b".repeat(128),
      },
      platform: "linux",
      homeDir: home,
      fetchImpl: async () => new Response("tampered", { status: 200 }),
    });
    expect(result.outcome).toBe("failed");
    expect(result.detail).toContain("SHA-512 mismatch");
    await expect(
      readFile(
        nodePath.join(home, ".synara", "acp-servers", "antigravity", "agy_acp_server"),
        "utf8",
      ),
    ).rejects.toThrow();
  });

  it("treats a matching existing install as already-installed", async () => {
    const home = await makeHome();
    const payload = "existing";
    const sha512 = sha512Hex(payload);
    const installDir = nodePath.join(home, ".synara", "acp-servers", "antigravity");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(installDir, { recursive: true });
    await writeFile(nodePath.join(installDir, "agy_acp_server"), payload);

    let fetchCount = 0;
    const result = await installAntigravityAcpServer({
      env: {
        [ANTIGRAVITY_ACP_DOWNLOAD_URL_ENV]: "https://example.invalid/agy_acp_server",
        [ANTIGRAVITY_ACP_SHA512_ENV]: sha512,
      },
      platform: "linux",
      homeDir: home,
      fetchImpl: async () => {
        fetchCount += 1;
        return new Response(payload, { status: 200 });
      },
    });
    expect(result.outcome).toBe("already-installed");
    expect(fetchCount).toBe(0);
  });
});
