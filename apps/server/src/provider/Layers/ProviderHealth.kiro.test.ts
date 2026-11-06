import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as OS from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { makeCheckKiroProviderStatus, parseKiroWhoamiResult } from "./ProviderHealth.ts";

describe("parseKiroWhoamiResult", () => {
  it("reports the login type without the account identity", () => {
    expect(
      parseKiroWhoamiResult({
        code: 0,
        stdout: "Logged in with Builder ID\nEmail: person@example.com\n",
        stderr: "",
      }),
    ).toEqual({ status: "ready", authStatus: "authenticated", authLabel: "AWS Builder ID" });
    expect(
      parseKiroWhoamiResult({
        code: 0,
        stdout: "Logged in with IAM Identity Center (https://example.awsapps.com/start)",
        stderr: "",
      }).authLabel,
    ).toBe("IAM Identity Center");
  });

  it("detects a missing login", () => {
    expect(
      parseKiroWhoamiResult({ code: 1, stdout: "", stderr: "error: Not logged in" }),
    ).toMatchObject({ status: "error", authStatus: "unauthenticated" });
  });

  it("keeps unknown failures as a warning", () => {
    expect(
      parseKiroWhoamiResult({ code: 2, stdout: "", stderr: "network unreachable" }),
    ).toMatchObject({ status: "warning", authStatus: "unknown" });
  });
});

describe.skipIf(process.platform === "win32")("makeCheckKiroProviderStatus", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const fakeKiro = (whoami: { readonly stdout: string; readonly exitCode: number }) => {
    const dir = mkdtempSync(join(OS.tmpdir(), "kiro-health-"));
    tempDirs.push(dir);
    const binary = join(dir, "kiro-cli");
    writeFileSync(
      binary,
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "kiro-cli 3.0.0"; exit 0; fi',
        `if [ "$1" = "whoami" ]; then echo ${JSON.stringify(whoami.stdout)}; exit ${whoami.exitCode}; fi`,
        "exit 64",
        "",
      ].join("\n"),
    );
    chmodSync(binary, 0o755);
    return binary;
  };

  const check = (binary: string) =>
    Effect.runPromise(makeCheckKiroProviderStatus(binary).pipe(Effect.provide(NodeServices.layer)));

  it("reports a signed-in Kiro CLI as ready", async () => {
    const status = await check(fakeKiro({ stdout: "Logged in with Builder ID", exitCode: 0 }));
    expect(status).toMatchObject({
      provider: "kiro",
      status: "ready",
      available: true,
      authStatus: "authenticated",
      authLabel: "AWS Builder ID",
      version: "3.0.0",
    });
  });

  it("asks for `kiro-cli login` when the CLI is not signed in", async () => {
    const status = await check(fakeKiro({ stdout: "Not logged in", exitCode: 1 }));
    expect(status).toMatchObject({
      status: "error",
      available: true,
      authStatus: "unauthenticated",
    });
    expect(status.message).toContain("kiro-cli login");
  });

  it("reports a missing binary", async () => {
    const status = await check(join(OS.tmpdir(), "definitely-missing-kiro-cli"));
    expect(status).toMatchObject({ status: "error", available: false });
  });
});
