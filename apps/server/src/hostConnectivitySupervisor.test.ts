// The supervisor follows the credentials file: no link means nothing runs, a
// link starts connectivity, a changed link restarts it, an unlink stops it,
// and rewrites that leave the link alone (token refresh) are ignored.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AccountApiError } from "@synara/shared/account";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeAccountCredentials, type StoredAccountFile } from "./accountAuth";
import { hostLinkKey, superviseHostConnectivity } from "./hostConnectivitySupervisor";

const BASE: StoredAccountFile = {
  accountUrl: "https://api.example.test",
  workosClientId: "client",
  workosApiUrl: "https://workos.example.test",
  organizationId: "org_1",
  userId: "user_1",
  accessToken: "access",
  refreshToken: "refresh",
};

const LINKED: StoredAccountFile = {
  ...BASE,
  hostId: "host_1",
  hostOwnerUserId: "user_1",
  hostKeyGeneration: 1,
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synara-connectivity-"));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Real time for file I/O and watcher events while timers are fake. */
async function realWait(): Promise<void> {
  const until = Date.now() + 100;
  while (Date.now() < until) await new Promise((resolve) => setImmediate(resolve));
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function harness() {
  const stops: Array<ReturnType<typeof vi.fn>> = [];
  const start = vi.fn(async () => {
    const stop = vi.fn();
    stops.push(stop);
    return stop;
  });
  return { start, stops };
}

describe("hostLinkKey", () => {
  it("is undefined until every host field is present", () => {
    expect(hostLinkKey(undefined)).toBeUndefined();
    expect(hostLinkKey(BASE)).toBeUndefined();
    const { hostKeyGeneration: _generation, ...withoutGeneration } = LINKED;
    expect(hostLinkKey(withoutGeneration)).toBeUndefined();
    expect(hostLinkKey(LINKED)).toBeDefined();
  });

  it("ignores session rotation but changes with the key generation", () => {
    expect(hostLinkKey({ ...LINKED, accessToken: "other", refreshToken: "other" })).toBe(
      hostLinkKey(LINKED),
    );
    expect(hostLinkKey({ ...LINKED, hostKeyGeneration: 2 })).not.toBe(hostLinkKey(LINKED));
  });
});

describe("superviseHostConnectivity", () => {
  it("starts nothing without a link and starts once the link is written", async () => {
    const dir = await tempDir();
    const { start, stops } = harness();
    const supervisor = await superviseHostConnectivity({ baseDir: dir, start, debounceMs: 20 });
    cleanups.push(() => supervisor.stop());
    expect(start).not.toHaveBeenCalled();

    await writeAccountCredentials(dir, BASE);
    await supervisor.reconcile();
    expect(start).not.toHaveBeenCalled();

    await writeAccountCredentials(dir, LINKED);
    await until(() => start.mock.calls.length === 1);
    expect(stops[0]).not.toHaveBeenCalled();
  });

  it("restarts on key rotation, ignores token refresh, and stops on owner mismatch or unlink", async () => {
    const dir = await tempDir();
    await writeAccountCredentials(dir, LINKED);
    const { start, stops } = harness();
    const supervisor = await superviseHostConnectivity({ baseDir: dir, start, debounceMs: 20 });
    cleanups.push(() => supervisor.stop());
    expect(start).toHaveBeenCalledTimes(1);

    await writeAccountCredentials(dir, { ...LINKED, accessToken: "rotated" });
    await supervisor.reconcile();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stops[0]).not.toHaveBeenCalled();

    await writeAccountCredentials(dir, { ...LINKED, hostKeyGeneration: 2 });
    await until(() => start.mock.calls.length === 2);
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).not.toHaveBeenCalled();

    await writeAccountCredentials(dir, { ...LINKED, hostKeyGeneration: 2, userId: "user_2" });
    await until(() => stops[1]!.mock.calls.length === 1);
    await supervisor.reconcile();
    expect(start).toHaveBeenCalledTimes(2);

    await writeAccountCredentials(dir, { ...LINKED, hostKeyGeneration: 2 });
    await until(() => start.mock.calls.length === 3);
    expect(stops[2]).not.toHaveBeenCalled();
    const { hostId: _h, hostOwnerUserId: _o, hostKeyGeneration: _g, ...unlinked } = LINKED;
    await writeAccountCredentials(dir, unlinked);
    await until(() => stops[2]!.mock.calls.length === 1);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it("does not replace an instance whose asynchronous teardown failed", async () => {
    const dir = await tempDir();
    await writeAccountCredentials(dir, LINKED);
    const stop = vi.fn(async (): Promise<void> => {
      throw new Error("unproven child cleanup");
    });
    const start = vi.fn(async () => stop);
    const supervisor = await superviseHostConnectivity({ baseDir: dir, start, debounceMs: 60_000 });
    await writeAccountCredentials(dir, { ...LINKED, hostKeyGeneration: 2 });
    await expect(supervisor.reconcile()).rejects.toThrow("unproven child cleanup");
    expect(start).toHaveBeenCalledTimes(1);
    stop.mockImplementation(async () => {});
    await supervisor.reconcile();
    expect(start).toHaveBeenCalledTimes(2);
    await supervisor.stop();
  });

  it("retries a failed start on the next reconcile and stops the active one on stop()", async () => {
    const dir = await tempDir();
    await writeAccountCredentials(dir, LINKED);
    const stop = vi.fn();
    const start = vi
      .fn<() => Promise<() => void>>()
      .mockRejectedValueOnce(new Error("api down"))
      .mockResolvedValue(stop);
    const supervisor = await superviseHostConnectivity({ baseDir: dir, start, debounceMs: 20 });
    expect(start).toHaveBeenCalledTimes(1);

    await supervisor.reconcile();
    expect(start).toHaveBeenCalledTimes(2);

    await supervisor.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    // Stopped supervisors ignore later changes.
    await writeAccountCredentials(dir, { ...LINKED, hostKeyGeneration: 3 });
    await supervisor.reconcile();
    expect(start).toHaveBeenCalledTimes(2);
  });

  /** Fake timers for the supervisor, real time for its file I/O and watcher. */
  async function refusedSupervisor(code: "not_host_owner" | "subscription_required") {
    vi.useFakeTimers({
      toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance"],
    });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    cleanups.push(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });
    const dir = await tempDir();
    await writeAccountCredentials(dir, LINKED);
    const start = vi.fn<() => Promise<() => void>>(async () => {
      throw new AccountApiError({
        status: 403,
        code,
        message:
          code === "subscription_required"
            ? "Remote access requires an active Synara Alto subscription"
            : "Remote test access is not enabled for this account",
      });
    });
    const supervisor = await superviseHostConnectivity({
      baseDir: dir,
      start,
      debounceMs: 20,
      pollIntervalMs: 1_000,
    });
    cleanups.push(() => supervisor.stop());
    // Real time first so watcher events can schedule their (fake) debounce.
    const step = async (ms: number) => {
      await realWait();
      await vi.advanceTimersByTimeAsync(ms);
      await realWait();
    };
    // Late watcher events from the initial write land inside the backoff.
    await step(0);
    expect(start).toHaveBeenCalledTimes(1);
    return { dir, start, supervisor, step };
  }

  it("spaces refused starts out, ignores token renewals, and retries a changed link at once", async () => {
    const { dir, start, step } = await refusedSupervisor("not_host_owner");
    // A token renewal rewrites the file without changing the link: no retry.
    await writeAccountCredentials(dir, { ...LINKED, accessToken: "renewed" });
    await step(50);
    expect(start).toHaveBeenCalledTimes(1);
    // Retries one, two, four… poll intervals apart, polls in between included.
    await step(950);
    expect(start).toHaveBeenCalledTimes(2);
    await step(1_000);
    expect(start).toHaveBeenCalledTimes(2);
    await step(1_000);
    expect(start).toHaveBeenCalledTimes(3);
    await step(3_000);
    expect(start).toHaveBeenCalledTimes(3);
    await step(1_000);
    expect(start).toHaveBeenCalledTimes(4);
    // A changed link is a different answer to wait for.
    await writeAccountCredentials(dir, { ...LINKED, hostKeyGeneration: 2 });
    await step(50);
    expect(start).toHaveBeenCalledTimes(5);
  });

  it("retries a refused start once per interval when billing shows access, then keeps backing off", async () => {
    const { start, supervisor, step } = await refusedSupervisor("subscription_required");
    supervisor.wakeAfterRefusal();
    await step(0);
    expect(start).toHaveBeenCalledTimes(2);
    // More granted reads in the same interval are not a retry each.
    supervisor.wakeAfterRefusal();
    supervisor.wakeAfterRefusal();
    await step(0);
    expect(start).toHaveBeenCalledTimes(2);
    // Still refused: the backoff resumes (two intervals now) through the next poll.
    await step(1_000);
    expect(start).toHaveBeenCalledTimes(2);
    // A later granted read may wake it once more.
    supervisor.wakeAfterRefusal();
    await step(0);
    expect(start).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["running", async () => vi.fn()],
    [
      "failing for another reason",
      async (): Promise<() => void> => {
        throw new Error("api down");
      },
    ],
  ])("ignores a granted billing read while connectivity is %s", async (_state, startImpl) => {
    const dir = await tempDir();
    await writeAccountCredentials(dir, LINKED);
    const start = vi.fn<() => Promise<() => void>>(startImpl);
    const supervisor = await superviseHostConnectivity({ baseDir: dir, start, debounceMs: 20 });
    cleanups.push(() => supervisor.stop());
    await new Promise((resolve) => setTimeout(resolve, 300));
    const before = start.mock.calls.length;
    supervisor.wakeAfterRefusal();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(start).toHaveBeenCalledTimes(before);
  });
});
