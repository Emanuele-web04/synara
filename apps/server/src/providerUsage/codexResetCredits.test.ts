import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  canUseCodexResetCredit,
  consumeCodexResetCredit,
  fetchCodexResetCredits,
  parseCodexResetCredits,
} from "./codexResetCredits";

const { spawn, signal } = vi.hoisted(() => ({ spawn: vi.fn(), signal: vi.fn() }));
vi.mock("@synara/shared/processRuntime", () => ({ spawnProcess: spawn }));
vi.mock("../platform/processTreeController", () => ({
  noteSpawnedProcess: () => undefined,
  signalOwnedChildProcess: signal,
}));
const input = {
  binaryPath: "codex.cmd",
  cwd: "/isolated",
  env: {},
  expectedAccountId: "account-a",
};
const attempt = {
  ...input,
  accountId: "account-a",
  creditId: "credit-a",
  idempotencyKey: "attempt-a",
};
const usage = (usedPercent = 95, accountId = "account-a") => ({
  accountId,
  rateLimits: { primary: { usedPercent } },
  rateLimitResetCredits: {
    availableCount: 1,
    credits: [{ id: "credit-a", status: "available", expiresAt: null, grantedAt: 1_787_357_419 }],
  },
});
type Message = { id: number; method: string; params?: Record<string, unknown> };
function fakeServer(
  reply: (message: Message) => unknown = (message) => ({
    result:
      message.method === "account/rateLimits/read"
        ? usage()
        : message.method === "account/rateLimitResetCredit/consume"
          ? { outcome: "reset" }
          : {},
  }),
) {
  const calls: Message[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: undefined as unknown as Writable,
    exitCode: null as number | null,
    signalCode: null as string | null,
  });
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(String(chunk)) as Message;
      calls.push(message);
      queueMicrotask(() => {
        const response = reply(message);
        if (message.id && response !== undefined)
          child.stdout.write(JSON.stringify({ id: message.id, ...(response as object) }) + "\n");
      });
      callback();
    },
  });
  spawn.mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  signal.mockImplementation((_child, sig) => {
    child.signalCode = sig;
    child.emit("exit");
  });
  return { child, calls };
}
beforeEach(() => {
  spawn.mockReset();
  signal.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("reset-credit parsing and eligibility", () => {
  it("maps timestamps and preserves count-only reports", () => {
    expect(parseCodexResetCredits(usage())).toEqual({
      availableCount: 1,
      credits: [
        {
          id: "credit-a",
          status: "available",
          grantedAt: new Date(1_787_357_419_000).toISOString(),
        },
      ],
    });
    expect(
      parseCodexResetCredits({ rateLimitResetCredits: { availableCount: 2, credits: null } }),
    ).toEqual({ availableCount: 2 });
    expect(parseCodexResetCredits({ rateLimits: {} })).toBeUndefined();
    expect(parseCodexResetCredits(null)).toBeUndefined();
  });
  it("accepts snake-case fields and drops missing credit ids", () => {
    expect(
      parseCodexResetCredits({
        rate_limit_reset_credits: {
          available_count: 2,
          credits: [{ id: " " }, { id: "keep", status: "future" }],
        },
      }),
    ).toEqual({ availableCount: 2, credits: [{ id: "keep", status: "unknown" }] });
  });
  it("requires a core quota at 90% used, excluding unavailable or unrelated buckets", () => {
    expect(canUseCodexResetCredit(usage(90))).toBe(true);
    expect(canUseCodexResetCredit(usage(89))).toBe(false);
    expect(canUseCodexResetCredit({ rateLimits: { secondary: { usedPercent: 99 } } })).toBe(true);
    expect(
      canUseCodexResetCredit({ rateLimits: { primary: { usedPercent: null } } }),
    ).toBeUndefined();
    expect(
      canUseCodexResetCredit({
        ...usage(99),
        rateLimitsByLimitId: {
          other: { primary: { usedPercent: 100 } },
          codex: { primary: { usedPercent: 20 } },
        },
      }),
    ).toBe(false);
    expect(
      canUseCodexResetCredit({ ...usage(99), rateLimitsByLimitId: { other: {} } }),
    ).toBeUndefined();
  });
});

describe("isolated app-server reset flow", () => {
  it("enriches only the same account through the shared process boundary", async () => {
    const { calls } = fakeServer();
    expect(await fetchCodexResetCredits(input)).toMatchObject({
      availableCount: 1,
      accountId: "account-a",
      canUse: true,
    });
    expect(spawn).toHaveBeenCalledWith(
      "codex.cmd",
      ["app-server"],
      expect.objectContaining({ env: {}, cwd: "/isolated", stdio: "pipe" }),
    );
    expect(calls.map((call) => call.method)).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
    ]);
    expect(signal).toHaveBeenCalledWith(expect.anything(), "SIGTERM");
  });
  it("does not mix credits from another account or an unidentified OAuth source", async () => {
    fakeServer(() => ({ result: usage(95, "account-b") }));
    expect(await fetchCodexResetCredits(input)).toBeUndefined();
    spawn.mockClear();
    expect(
      await fetchCodexResetCredits({ ...input, expectedAccountId: undefined }),
    ).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each(["reset", "alreadyRedeemed", "noCredit", "nothingToReset"])(
    "recognizes %s after fresh usage and preserves the caller's key",
    async (outcome) => {
      const { calls } = fakeServer((message) => ({
        result:
          message.method === "account/rateLimits/read"
            ? usage()
            : message.method === "account/rateLimitResetCredit/consume"
              ? { outcome }
              : {},
      }));
      expect(await consumeCodexResetCredit(attempt)).toBe(outcome);
      expect(calls.at(-1)).toMatchObject({
        method: "account/rateLimitResetCredit/consume",
        params: { creditId: "credit-a", idempotencyKey: "attempt-a" },
      });
    },
  );
  it("blocks stale UI eligibility and account changes before consumption", async () => {
    let fake = fakeServer((message) => ({
      result: message.method === "account/rateLimits/read" ? usage(20) : {},
    }));
    expect(await consumeCodexResetCredit(attempt)).toBe("nothingToReset");
    expect(fake.calls.some((call) => call.method?.includes("/consume"))).toBe(false);
    fake = fakeServer((message) => ({
      result: message.method === "account/rateLimits/read" ? usage(95, "account-b") : {},
    }));
    await expect(consumeCodexResetCredit(attempt)).rejects.toThrow("account changed");
    expect(fake.calls.some((call) => call.method?.includes("/consume"))).toBe(false);
  });
  it("consumes count-only credits without inventing an id", async () => {
    const { calls } = fakeServer();
    await consumeCodexResetCredit({
      ...input,
      accountId: "account-a",
      idempotencyKey: "attempt-a",
    });
    expect(calls.at(-1)?.params).toEqual({ idempotencyKey: "attempt-a" });
  });
  it("does not proceed after initialization rejection", async () => {
    const { calls } = fakeServer(() => ({ error: { code: -1 } }));
    await expect(consumeCodexResetCredit(attempt)).rejects.toThrow("rejected");
    expect(calls.map((call) => call.method)).toEqual(["initialize"]);
  });
  it("preserves uncertain unknown results for a same-key retry", async () => {
    fakeServer((message) => ({
      result: message.method === "account/rateLimits/read" ? usage() : {},
    }));
    await expect(consumeCodexResetCredit(attempt)).rejects.toThrow("unknown reset result");
  });
  it("times out a stalled probe and closes its owned process", async () => {
    vi.useFakeTimers();
    fakeServer(() => undefined);
    const assertion = expect(consumeCodexResetCredit(attempt)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
    expect(signal).toHaveBeenCalledWith(expect.anything(), "SIGTERM");
  });
  it("never acknowledges interactive requests as successful", async () => {
    const { child, calls } = fakeServer();
    const result = fetchCodexResetCredits(input);
    child.stdout.write(JSON.stringify({ id: 99, method: "item/tool/requestUserInput" }) + "\n");
    await result;
    expect(calls).toContainEqual({
      id: 99,
      error: { code: -32601, message: "Interactive requests are unsupported by this usage probe." },
    });
  });
  it("coalesces the same attempt and rejects a simultaneous different reset", async () => {
    fakeServer();
    const first = consumeCodexResetCredit(attempt);
    const retry = consumeCodexResetCredit(attempt);
    await expect(
      consumeCodexResetCredit({ ...attempt, idempotencyKey: "different" }),
    ).rejects.toThrow("already in progress");
    await expect(first).resolves.toBe("reset");
    await expect(retry).resolves.toBe("reset");
    expect(spawn).toHaveBeenCalledTimes(1);
  });
  it("keeps unknown current usage unresolved rather than claiming there is nothing to reset", async () => {
    const { calls } = fakeServer((message) => ({
      result: message.method === "account/rateLimits/read" ? { accountId: "account-a" } : {},
    }));
    await expect(consumeCodexResetCredit(attempt)).rejects.toThrow("usage is unavailable");
    expect(calls.some((call) => call.method?.includes("/consume"))).toBe(false);
  });
  it("handles broken stdin without an unhandled process error", async () => {
    const { child } = fakeServer(() => undefined);
    const result = consumeCodexResetCredit(attempt);
    child.stdin.emit("error", new Error("EPIPE"));
    await expect(result).rejects.toThrow("EPIPE");
    expect(signal).toHaveBeenCalledWith(child, "SIGTERM");
  });
  it("escalates termination for an unresponsive owned child", async () => {
    vi.useFakeTimers();
    fakeServer();
    signal.mockImplementation(() => {});
    await consumeCodexResetCredit(attempt);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signal.mock.calls.map((call) => call[1])).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
