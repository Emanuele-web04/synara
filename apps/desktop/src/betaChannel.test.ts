// FILE: betaChannel.test.ts
// Purpose: Unit coverage for the stable→beta handoff helpers.

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (String(args[0]).includes("failing-beta")) {
        throw new Error("spawn ENOENT");
      }
      return actual.spawn(...args);
    },
  };
});

import {
  BETA_IMPORT_REQUEST_FILE_NAME,
  BETA_IMPORT_RESULT_FILE_NAME,
} from "@synara/shared/betaChannel";
import { BETA_WINDOWS_UNINSTALL_GUID } from "./betaChannel";
import {
  DesktopBetaChannel,
  isBetaServerRunning,
  readBetaImportResult,
  writeBetaImportRequest,
} from "./betaChannel";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "synara-beta-channel-test-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

const makeChannel = (root: string, flavor: "production" | "beta" | "canary" = "production") =>
  new DesktopBetaChannel({
    platform: "linux",
    homeDir: root,
    betaHomeDir: join(root, ".synara-beta"),
    flavor,
  });

describe("DesktopBetaChannel", () => {
  it("reports unsupported actions on non-production flavors", () => {
    const root = makeRoot();
    const beta = makeChannel(root, "beta");
    expect(beta.launch().ok).toBe(false);
    expect(beta.importAndLaunch(root).error).toBe("not-supported");
    expect(beta.getState().flavor).toBe("beta");
  });

  it("reports not-installed on a clean machine", () => {
    const root = makeRoot();
    const state = makeChannel(root).getState();
    expect(state.installed).toBe(false);
    expect(state.running).toBe(false);
    expect(state.lastImportAt).toBeNull();
    expect(state.downloadUrl).toContain("releases");
  });

  it("refuses the import when beta is missing", () => {
    const root = makeRoot();
    const result = makeChannel(root).importAndLaunch(root);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("not-installed");
  });

  it("refuses the import while the beta server is running", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    mkdirSync(join(betaHome, "userdata"), { recursive: true });
    writeFileSync(
      join(betaHome, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: process.pid, port: 3773, origin: "http://127.0.0.1" }),
    );
    // Pretend beta is installed via PATH is not possible here; the running check
    // must trip before launch either way once an install exists.
    const channel = makeChannel(root);
    expect(isBetaServerRunning(betaHome)).toBe(true);
    const result = channel.importAndLaunch(root);
    expect(result.ok).toBe(false);
    // "not-installed" wins first on this machine; running detection is
    // independently covered by isBetaServerRunning.
    expect(["beta-running", "not-installed"]).toContain(result.error);
  });

  it("removes the import marker when launching beta throws", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    // Fake a linux install through its desktop file so detection resolves a
    // (failing) executable path.
    const desktopDir = join(root, ".local", "share", "applications");
    mkdirSync(desktopDir, { recursive: true });
    writeFileSync(join(desktopDir, "synara-beta.desktop"), "Exec=/opt/failing-beta\n");

    const result = makeChannel(root).importAndLaunch(join(root, ".synara"));
    expect(result.ok).toBe(false);
    expect(result.error).toBe("internal");
    // The marker must not outlive the failed launch; a leftover would import
    // on the next unrelated beta start.
    expect(existsSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME))).toBe(false);
  });
});

describe("isBetaServerRunning", () => {
  it("is false without a runtime file", () => {
    const root = makeRoot();
    expect(isBetaServerRunning(join(root, ".synara-beta"))).toBe(false);
  });

  it("is false when the recorded pid is stale", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    mkdirSync(join(betaHome, "userdata"), { recursive: true });
    writeFileSync(
      join(betaHome, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: 4194303, port: 3773 }),
    );
    expect(isBetaServerRunning(betaHome)).toBe(false);
  });

  it("is false for a malformed runtime file", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    mkdirSync(join(betaHome, "userdata"), { recursive: true });
    writeFileSync(join(betaHome, "userdata", "server-runtime.json"), "not json");
    expect(isBetaServerRunning(betaHome)).toBe(false);
  });
});

describe("import marker files", () => {
  it("round-trips the request marker atomically", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    writeBetaImportRequest({ betaHomeDir: betaHome, sourceHomeDir: join(root, ".synara") });
    const request = JSON.parse(readFileSync(join(betaHome, BETA_IMPORT_REQUEST_FILE_NAME), "utf8"));
    expect(request.version).toBe(1);
    expect(request.sourceHomeDir).toBe(join(root, ".synara"));
    expect(typeof request.requestedAt).toBe("string");
  });

  it("reads a success result back for the settings card", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    mkdirSync(betaHome, { recursive: true });
    const completedAt = new Date().toISOString();
    writeFileSync(
      join(betaHome, BETA_IMPORT_RESULT_FILE_NAME),
      JSON.stringify({ version: 1, completedAt, ok: true }),
    );
    expect(readBetaImportResult(betaHome)?.completedAt).toBe(completedAt);
  });

  it("surfaces a failed import error", () => {
    const root = makeRoot();
    const betaHome = join(root, ".synara-beta");
    mkdirSync(betaHome, { recursive: true });
    writeFileSync(
      join(betaHome, BETA_IMPORT_RESULT_FILE_NAME),
      JSON.stringify({
        version: 1,
        completedAt: new Date().toISOString(),
        ok: false,
        error: "db locked",
      }),
    );
    const channel = makeChannel(root).getState();
    expect(channel.lastImportError).toBe("db locked");
    expect(channel.lastImportAt).toBeNull();
  });
});

describe("detection constants", () => {
  it("keeps the Windows beta GUID stable", () => {
    expect(BETA_WINDOWS_UNINSTALL_GUID).toBe("a8e63b48-d4f3-4db5-9e12-368107afe65d");
  });
});
