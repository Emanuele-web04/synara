import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acpRegistryPlatformKey,
  ACP_REGISTRY_URL,
  clearAcpRegistryCacheForTests,
  installAcpRegistryAgent,
  listAcpRegistryAgents,
  uninstallAcpManagedAgent,
} from "./AcpRegistry.ts";

const scratchDirs: string[] = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "synara-acp-registry-"));
  scratchDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.unstubAllGlobals();
  clearAcpRegistryCacheForTests();
  while (scratchDirs.length > 0) rmSync(scratchDirs.pop()!, { recursive: true, force: true });
});

// Builds a real tar.gz holding one executable file so the binary install path
// runs end to end (download → checksum → extract → chmod → marker).
const makeAgentArchive = () => {
  const dir = scratch();
  const payload = join(dir, "bin-agent");
  writeFileSync(payload, "#!/bin/sh\necho ok\n");
  const archive = join(dir, "bin-agent.tar.gz");
  execFileSync("tar", ["-czf", archive, "-C", dir, "bin-agent"]);
  const bytes = readFileSync(archive);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
};

const registryBody = (archiveUrl: string, sha256: string) =>
  JSON.stringify({
    version: "1",
    agents: [
      {
        id: "pkg-agent",
        name: "Pkg Agent",
        version: "1.2.3",
        description: "agent via npx",
        distribution: { npx: { package: "pkg-agent@1.2.3", args: ["acp"] } },
      },
      {
        id: "bin-agent",
        name: "Bin Agent",
        version: "2.0.0",
        distribution: {
          binary: {
            "darwin-aarch64": {
              archive: archiveUrl,
              cmd: "./bin-agent",
              args: ["acp"],
              sha256,
            },
          },
        },
      },
      {
        id: "linux-only",
        name: "Linux Only",
        version: "1.0.0",
        distribution: {
          binary: {
            "linux-x86_64": {
              archive: "https://example.test/linux.tar.gz",
              cmd: "./agent",
            },
          },
        },
      },
    ],
  });

const stubFetch = (archiveBytes?: Buffer) => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url === ACP_REGISTRY_URL) {
      return new Response(registryBody("https://example.test/bin-agent.tar.gz", ARCHIVE_SHA));
    }
    if (url === "https://example.test/bin-agent.tar.gz" && archiveBytes) {
      return new Response(new Uint8Array(archiveBytes));
    }
    return new Response("not found", { status: 404 });
  });
  return calls;
};

let ARCHIVE_BYTES: Buffer;
let ARCHIVE_SHA: string;

beforeEach(() => {
  const archive = makeAgentArchive();
  ARCHIVE_BYTES = archive.bytes;
  ARCHIVE_SHA = archive.sha256;
});

describe("acpRegistryPlatformKey", () => {
  it("maps node platform/arch onto registry target names", () => {
    expect(acpRegistryPlatformKey("darwin", "arm64")).toBe("darwin-aarch64");
    expect(acpRegistryPlatformKey("linux", "x64")).toBe("linux-x86_64");
    expect(acpRegistryPlatformKey("win32", "x64")).toBe("windows-x86_64");
    expect(acpRegistryPlatformKey("freebsd", "x64")).toBeNull();
  });
});

describe("listAcpRegistryAgents", () => {
  it("resolves npx launches eagerly and marks binary agents installable", async () => {
    stubFetch(ARCHIVE_BYTES);
    const { agents } = await listAcpRegistryAgents();
    const pkg = agents.find((a) => a.id === "pkg-agent")!;
    expect(pkg.launch).toEqual({
      kind: "npx",
      installable: true,
      command: "npx",
      args: ["pkg-agent@1.2.3", "acp"],
    });
    const bin = agents.find((a) => a.id === "bin-agent")!;
    expect(bin.launch.kind).toBe("binary");
    const missing = agents.find((a) => a.id === "linux-only")!;
    expect(missing.launch.installable).toBe(acpRegistryPlatformKey() === "linux-x86_64");
  });
});

describe("installAcpRegistryAgent", () => {
  it("returns the package-runner launch for npx agents without downloading", async () => {
    const calls = stubFetch(ARCHIVE_BYTES);
    const result = await installAcpRegistryAgent("pkg-agent", scratch());
    expect(result).toEqual({ command: "npx", args: ["pkg-agent@1.2.3", "acp"] });
    expect(calls.filter((url) => url !== ACP_REGISTRY_URL)).toEqual([]);
  });

  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
    "downloads, verifies and unpacks a binary agent once",
    async () => {
      const baseDir = scratch();
      const calls = stubFetch(ARCHIVE_BYTES);
      const result = await installAcpRegistryAgent("bin-agent", baseDir);
      expect(result.args).toEqual(["acp"]);
      expect(result.command.endsWith("bin-agent")).toBe(true);
      expect(existsSync(result.command)).toBe(true);
      expect(existsSync(join(result.installDir!, ".synara-install.json"))).toBe(true);
      // Second install reuses the unpacked tree — no second archive download.
      const again = await installAcpRegistryAgent("bin-agent", baseDir);
      expect(again.command).toBe(result.command);
      expect(calls.filter((url) => url !== ACP_REGISTRY_URL)).toHaveLength(1);
    },
  );

  it("rejects unknown agents and agents without a platform build", async () => {
    stubFetch(ARCHIVE_BYTES);
    await expect(installAcpRegistryAgent("nope", scratch())).rejects.toThrow(
      'ACP registry agent "nope" not found',
    );
    if (acpRegistryPlatformKey() !== "linux-x86_64") {
      await expect(installAcpRegistryAgent("linux-only", scratch())).rejects.toThrow(
        /has no build for/u,
      );
    }
  });
});

describe("uninstallAcpManagedAgent", () => {
  it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
    "removes a managed install only when no other instance launches from it",
    async () => {
      const baseDir = scratch();
      stubFetch(ARCHIVE_BYTES);
      const installed = await installAcpRegistryAgent("bin-agent", baseDir);

      const guarded = await uninstallAcpManagedAgent({
        command: installed.command,
        synaraBaseDir: baseDir,
        otherInstances: [{ instanceId: "acp_other", command: installed.command }],
      });
      expect(guarded).toEqual({ removed: false, inUseByInstanceId: "acp_other" });
      expect(existsSync(installed.command)).toBe(true);

      const removed = await uninstallAcpManagedAgent({
        command: installed.command,
        synaraBaseDir: baseDir,
        otherInstances: [{ instanceId: "acp_other", command: "gemini" }],
      });
      expect(removed).toEqual({ removed: true });
      expect(existsSync(installed.command)).toBe(false);
    },
  );

  it("never removes executables outside the managed root", async () => {
    const baseDir = scratch();
    const outside = join(scratch(), "agent");
    writeFileSync(outside, "x");
    const result = await uninstallAcpManagedAgent({
      command: outside,
      synaraBaseDir: baseDir,
      otherInstances: [],
    });
    expect(result).toEqual({ removed: false });
    expect(existsSync(outside)).toBe(true);
  });
});
