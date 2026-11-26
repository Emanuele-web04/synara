import { Deferred, Effect, Option } from "effect";
import { expect, it } from "vitest";
import { withWorktreeLifecycle, withWorktreeRemoval } from "./worktreeLifecycle";

it("keeps normal lifecycle work concurrent and skips cleanup while any actor is active", async () => {
  const home = "/tmp/worktree-lifecycle-concurrency";
  const entered = await Effect.runPromise(Deferred.make<void>());
  const release = await Effect.runPromise(Deferred.make<void>());
  const active = Effect.runPromise(
    withWorktreeLifecycle(
      home,
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ),
  );
  try {
    await Effect.runPromise(Deferred.await(entered));
    expect(
      await Effect.runPromise(withWorktreeLifecycle(home, Effect.succeed("second actor"))),
    ).toBe("second actor");
    expect(
      Option.isNone(await Effect.runPromise(withWorktreeRemoval(home, Effect.succeed("remove")))),
    ).toBe(true);
  } finally {
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await active;
  }
  expect(
    Option.getOrThrow(await Effect.runPromise(withWorktreeRemoval(home, Effect.succeed("remove")))),
  ).toBe("remove");
});

it("releases cleanup's exclusive lease on failure", async () => {
  const home = "/tmp/worktree-lifecycle-failure";
  await expect(
    Effect.runPromise(withWorktreeRemoval(home, Effect.fail(new Error("remove failed")))),
  ).rejects.toThrow("remove failed");
  expect(await Effect.runPromise(withWorktreeLifecycle(home, Effect.succeed("restored")))).toBe(
    "restored",
  );
});
