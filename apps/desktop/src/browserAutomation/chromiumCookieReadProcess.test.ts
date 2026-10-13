import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawnProcess: vi.fn() }));
vi.mock("@synara/shared/processRuntime", () => ({ spawnProcess: mocks.spawnProcess }));
import { readChromiumCookieSnapshotProcess } from "./chromiumCookieReadProcess";

class SyntheticChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  readonly input: Buffer[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.input.push(Buffer.from(chunk)));
  }
}

describe("Chromium cookie read process", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends bounded SQLite work to the shared process boundary with the key over stdin", async () => {
    const child = new SyntheticChild();
    mocks.spawnProcess.mockImplementation((_executable, args, launch) => {
      child.stdin.once("finish", () => {
        const payload = JSON.parse(Buffer.concat(child.input).toString("utf8"));
        expect(payload.password).toBe("synthetic-keychain-secret");
        queueMicrotask(() => {
          child.stdout.end(JSON.stringify({ ok: true, result: { detailedCookies: [] } }));
          child.emit("close", 0);
        });
      });
      expect(args).toEqual(["--input-type=module", "-e", expect.any(String)]);
      expect(launch).toMatchObject({
        env: { ELECTRON_RUN_AS_NODE: "1" },
        signal: expect.any(AbortSignal),
        stdio: ["pipe", "pipe", "pipe"],
      });
      return child;
    });
    const keychainPassword = vi.fn(async () => "synthetic-keychain-secret");
    const signal = new AbortController().signal;

    await expect(
      readChromiumCookieSnapshotProcess(
        { browser: "helium", profile: "Default" },
        30_000,
        keychainPassword,
        signal,
        "/synthetic-home",
      ),
    ).resolves.toEqual({ detailedCookies: [] });

    expect(keychainPassword).toHaveBeenCalledExactlyOnceWith("helium", 15_000);
    expect(mocks.spawnProcess).toHaveBeenCalledOnce();
  });

  it("stops the SQLite child when the import signal aborts", async () => {
    const child = new SyntheticChild();
    mocks.spawnProcess.mockImplementation((_executable, _args, launch) => {
      const signal = launch.signal as AbortSignal;
      signal.addEventListener("abort", () => {
        child.emit("close", null);
      });
      return child;
    });
    const controller = new AbortController();
    const pending = readChromiumCookieSnapshotProcess(
      { browser: "helium", profile: "Default" },
      30_000,
      async () => "synthetic-key",
      controller.signal,
      "/synthetic-home",
    );
    await vi.waitFor(() => expect(mocks.spawnProcess).toHaveBeenCalledOnce());

    controller.abort(new Error("synthetic-cancel"));
    await expect(pending).rejects.toThrow("synthetic-cancel");
  });

  it("does not prompt or spawn when the import is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already-cancelled"));
    const keychainPassword = vi.fn(async () => "synthetic-key");

    await expect(
      readChromiumCookieSnapshotProcess(
        { browser: "helium", profile: "Default" },
        30_000,
        keychainPassword,
        controller.signal,
        "/synthetic-home",
      ),
    ).rejects.toThrow("already-cancelled");

    expect(keychainPassword).not.toHaveBeenCalled();
    expect(mocks.spawnProcess).not.toHaveBeenCalled();
  });

  it("does not spawn when cancellation arrives during Keychain acquisition", async () => {
    const controller = new AbortController();
    const keychainPassword = vi.fn(async () => {
      controller.abort(new Error("cancelled-during-keychain"));
      return "synthetic-key";
    });

    await expect(
      readChromiumCookieSnapshotProcess(
        { browser: "helium", profile: "Default" },
        30_000,
        keychainPassword,
        controller.signal,
        "/synthetic-home",
      ),
    ).rejects.toThrow("cancelled-during-keychain");

    expect(keychainPassword).toHaveBeenCalledOnce();
    expect(mocks.spawnProcess).not.toHaveBeenCalled();
  });

  it("counts Keychain acquisition against the total deadline", async () => {
    await expect(
      readChromiumCookieSnapshotProcess(
        { browser: "helium", profile: "Default" },
        5,
        async (_browser, timeoutMs) => {
          expect(timeoutMs).toBe(5);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return "synthetic-key";
        },
        new AbortController().signal,
        "/synthetic-home",
      ),
    ).rejects.toMatchObject({ cookieReaderCode: "timed_out" });

    expect(mocks.spawnProcess).not.toHaveBeenCalled();
  });

  it("waits for the child close after a spawn error", async () => {
    const child = new SyntheticChild();
    mocks.spawnProcess.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit("error", new Error("private executable detail"));
        child.emit("close", null);
      });
      return child;
    });

    await expect(
      readChromiumCookieSnapshotProcess(
        { browser: "helium", profile: "Default" },
        30_000,
        async () => "synthetic-key",
        new AbortController().signal,
        "/synthetic-home",
      ),
    ).rejects.toMatchObject({ cookieReaderCode: "source_extraction_failed" });
  });

  it("handles a child stdin EPIPE without leaking an unhandled stream error", async () => {
    const child = new SyntheticChild();
    mocks.spawnProcess.mockImplementation(() => {
      child.stdin.once("finish", () => {
        queueMicrotask(() => {
          child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
          child.emit("close", 1);
        });
      });
      return child;
    });

    await expect(
      readChromiumCookieSnapshotProcess(
        { browser: "helium", profile: "Default" },
        30_000,
        async () => "synthetic-key",
        new AbortController().signal,
        "/synthetic-home",
      ),
    ).rejects.toMatchObject({ cookieReaderCode: "source_extraction_failed" });
  });

  it("snapshots and queries a selected profile outside the caller event loop", async () => {
    const { spawnProcess } = await vi.importActual<typeof import("@synara/shared/processRuntime")>(
      "@synara/shared/processRuntime",
    );
    mocks.spawnProcess.mockImplementation(spawnProcess as never);
    const home = await mkdtemp(join(tmpdir(), "synara-cookie-process-test-"));
    try {
      const profile = join(home, "Library", "Application Support", "net.imput.helium", "Default");
      await mkdir(profile, { recursive: true });
      const database = new DatabaseSync(join(profile, "Cookies"));
      database.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER);
        INSERT INTO meta VALUES ('version', 24);
        CREATE TABLE cookies (
          host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
          is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, expires_utc INTEGER,
          has_expires INTEGER
        );
      `);
      database.close();
      const pending = readChromiumCookieSnapshotProcess(
        { browser: "helium", profile: "Default" },
        30_000,
        async () => "synthetic-keychain-secret",
        new AbortController().signal,
        home,
      );
      await setImmediate();
      await expect(pending).resolves.toEqual({ detailedCookies: [], warnings: [] });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
