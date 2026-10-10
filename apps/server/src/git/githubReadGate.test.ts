import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";

import { GITHUB_INBOX_RATE_LIMIT_FALLBACK_PAUSE_MS } from "../githubInbox/githubInbox.logic";
import { GitHubCliError } from "./Errors";
import { GITHUB_READ_SLOTS, makeGitHubReadGate } from "./githubReadGate";

const rateLimited = new GitHubCliError({
  operation: "execute",
  detail: "GitHub rate limit reached. Synara will retry after the limit resets.",
  reason: "rate-limited",
});

describe("makeGitHubReadGate", () => {
  it("fails reads fast after a rate-limited read until the pause expires", async () => {
    const clock = { value: 1_000 };
    const gate = makeGitHubReadGate({ now: () => clock.value });
    let reads = 0;
    const read = gate.withRead(Effect.sync(() => ++reads));

    await Effect.runPromise(gate.withRead(Effect.fail(rateLimited)).pipe(Effect.flip));
    const paused = await Effect.runPromise(read.pipe(Effect.flip));
    expect(paused.reason).toBe("rate-limited");
    expect(reads).toBe(0);

    clock.value += GITHUB_INBOX_RATE_LIMIT_FALLBACK_PAUSE_MS - 1;
    await Effect.runPromise(read.pipe(Effect.flip));
    expect(reads).toBe(0);

    // A read refused by the pause must not push the pause further out.
    clock.value += 1;
    expect(await Effect.runPromise(read)).toBe(1);
  });

  it("pauses reads when a command outside the queue reports the limit", async () => {
    const clock = { value: 0 };
    const gate = makeGitHubReadGate({ now: () => clock.value });
    gate.noteFailure(new GitHubCliError({ operation: "execute", detail: "boom", reason: "other" }));
    expect(await Effect.runPromise(gate.withRead(Effect.succeed("ok")))).toBe("ok");

    gate.noteFailure(rateLimited);
    const paused = await Effect.runPromise(gate.withRead(Effect.succeed("ok")).pipe(Effect.flip));
    expect(paused.reason).toBe("rate-limited");
  });

  it("bounds concurrent reads and refuses queued ones once the limit is hit", async () => {
    const clock = { value: 1_000 };
    const gate = makeGitHubReadGate({ now: () => clock.value });
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        let running = 0;
        let peak = 0;
        let started = 0;
        const read = gate.withRead(
          Effect.gen(function* () {
            started += 1;
            running += 1;
            peak = Math.max(peak, running);
            yield* Deferred.await(release);
            running -= 1;
          }),
        );
        const fibers = yield* Effect.forEach(Array.from({ length: GITHUB_READ_SLOTS * 2 }), () =>
          read.pipe(Effect.exit, Effect.forkChild),
        );
        yield* Effect.yieldNow;
        const startedBeforeLimit = started;

        gate.noteFailure(rateLimited);
        // The occupying reads finish later, while their queued peers are still paused.
        clock.value += GITHUB_INBOX_RATE_LIMIT_FALLBACK_PAUSE_MS - 1;
        yield* Deferred.succeed(release, undefined);
        const exits = yield* Effect.forEach(fibers, Fiber.join);
        return {
          startedBeforeLimit,
          started,
          peak,
          failed: exits.filter((exit) => exit._tag === "Failure").length,
        };
      }),
    );
    expect(result).toEqual({
      startedBeforeLimit: GITHUB_READ_SLOTS,
      started: GITHUB_READ_SLOTS,
      peak: GITHUB_READ_SLOTS,
      failed: GITHUB_READ_SLOTS,
    });
    clock.value += 1;
    expect(await Effect.runPromise(gate.withRead(Effect.succeed("resumed")))).toBe("resumed");
  });
});
