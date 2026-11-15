// FILE: piSdkImports.test.ts
// Purpose: Verifies CLI identity and dependency resolution for user-installed Pi SDKs.
// Layer: Provider unit tests

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { resolvePiInstallation } from "./piSdkImports.ts";
import { writePiInstallFixture } from "./testing/piSdkFixture.ts";

const dirs: string[] = [];
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), "synara-pi-install-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("keeps the selected CLI and its nested SDK dependencies together across Pi instances", async () => {
  const first = writePiInstallFixture(directory(), "first");
  const second = writePiInstallFixture(
    directory(),
    "second",
    process.platform === "win32" ? "npm-cmd" : "bun",
  );
  const environment = { PATH: dirname(first) };
  for (const [binaryPath, version] of [
    [undefined, "first"],
    [second, "second"],
    [first, "first"],
  ] as const) {
    const installation = await resolvePiInstallation({ binaryPath, env: environment });
    expect(installation.binaryPath).toBe(binaryPath ?? first);
    const agent = await installation.importPackage<{ version: string }>(
      "@earendil-works/pi-coding-agent",
    );
    const ai = await installation.importPackage<{ version: string }>(
      "@earendil-works/pi-ai/providers/azure",
    );
    expect(agent.version).toBe(version);
    expect(ai.version).toBe(agent.version);
  }
});

it("resolves npm's Windows command shim against the SDK it executes", async () => {
  const binaryPath = writePiInstallFixture(directory(), "windows-shim", "npm-cmd");
  const installation = await resolvePiInstallation({ binaryPath });
  const sdk = await installation.importPackage<{ version: string }>("@earendil-works/pi-ai/compat");
  expect(sdk.version).toBe("windows-shim");
});

it("loads the SDK named by Bun's Windows companion metadata", async () => {
  const binaryPath = writePiInstallFixture(directory(), "bun-windows", "bun-exe");
  const installation = await resolvePiInstallation({ binaryPath });
  const sdk = await installation.importPackage<{ version: string }>(
    "@earendil-works/pi-coding-agent",
  );
  expect(sdk.version).toBe("bun-windows");

  writeFileSync(join(dirname(binaryPath), "pi.bunx"), "invalid");
  await expect(resolvePiInstallation({ binaryPath })).rejects.toThrow("compatible Pi SDK");
});

it("leaves Pi unavailable without a CLI and never falls back from a configured binary", async () => {
  const emptyPath = directory();
  await expect(resolvePiInstallation({ env: { PATH: emptyPath } })).rejects.toThrow(
    "Pi is not installed",
  );
  const available = writePiInstallFixture(directory(), "path-decoy");
  await expect(
    resolvePiInstallation({ binaryPath: join(emptyPath, "pi"), env: { PATH: dirname(available) } }),
  ).rejects.toThrow("configured Pi CLI");
});

it("rejects a different executable even beside a valid Pi SDK", async () => {
  const binaryPath = writePiInstallFixture(directory(), "adjacent", "npm-cmd");
  writeFileSync(binaryPath, "@ECHO This is not Pi\r\n");
  await expect(resolvePiInstallation({ binaryPath })).rejects.toThrow("compatible Pi SDK");
});
