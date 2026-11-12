import { beforeEach, describe, expect, it } from "vitest";
import { IdentityProviderError, type IdentityUser } from "./interfaces";
import {
  clearUserCache,
  getCachedUser,
  invalidateUserCache,
  type UserCacheDeps,
} from "./userCache";

/**
 * A provider stand-in that answers from a mutable user table and counts the
 * lookups, so each test can say exactly when the provider was asked.
 */
function makeDeps(start = 1_000_000) {
  const users = new Map<string, IdentityUser>();
  let failure: Error | undefined;
  const clock = { now: start };
  const lookups: string[] = [];
  const deps: UserCacheDeps = {
    async getUser(userId) {
      lookups.push(userId);
      if (failure) throw failure;
      const user = users.get(userId);
      if (!user) throw new IdentityProviderError(404, "User not found");
      return { ...user };
    },
    now: () => clock.now,
  };
  return {
    deps,
    users,
    clock,
    lookups,
    failNext(error: Error | undefined) {
      failure = error;
    },
  };
}

beforeEach(() => {
  clearUserCache();
});

describe("user cache", () => {
  it("serves a repeat lookup from cache until the entry ages past its TTL", async () => {
    const provider = makeDeps();
    provider.users.set("user_1", { id: "user_1", email: "ada@example.com" });

    await getCachedUser(provider.deps, "user_1");
    provider.users.set("user_1", { id: "user_1", email: "renamed@example.com" });
    provider.clock.now += 59_999;
    await expect(getCachedUser(provider.deps, "user_1")).resolves.toMatchObject({
      email: "ada@example.com",
    });
    expect(provider.lookups).toEqual(["user_1"]);

    provider.clock.now += 1;
    await expect(getCachedUser(provider.deps, "user_1")).resolves.toMatchObject({
      email: "renamed@example.com",
    });
    expect(provider.lookups).toEqual(["user_1", "user_1"]);
  });

  it("does not trust an entry the clock has moved behind", async () => {
    const provider = makeDeps();
    provider.users.set("user_1", { id: "user_1", email: "ada@example.com" });

    await getCachedUser(provider.deps, "user_1");
    provider.clock.now -= 1;
    await getCachedUser(provider.deps, "user_1");

    expect(provider.lookups).toHaveLength(2);
  });

  it("caches per user rather than globally", async () => {
    const provider = makeDeps();
    provider.users.set("user_1", { id: "user_1", email: "a@example.com" });
    provider.users.set("user_2", { id: "user_2", email: "b@example.com" });

    await expect(getCachedUser(provider.deps, "user_1")).resolves.toMatchObject({
      email: "a@example.com",
    });
    await expect(getCachedUser(provider.deps, "user_2")).resolves.toMatchObject({
      email: "b@example.com",
    });
    expect(provider.lookups).toEqual(["user_1", "user_2"]);
  });

  it("a fresh read bypasses the cached entry and refills it", async () => {
    const provider = makeDeps();
    provider.users.set("user_1", { id: "user_1", email: "ada@example.com" });
    await getCachedUser(provider.deps, "user_1");
    provider.users.set("user_1", { id: "user_1", email: "renamed@example.com" });

    await expect(getCachedUser(provider.deps, "user_1", { fresh: true })).resolves.toMatchObject({
      email: "renamed@example.com",
    });
    // The fresh answer is what later plain reads see, with no further lookup.
    await expect(getCachedUser(provider.deps, "user_1")).resolves.toMatchObject({
      email: "renamed@example.com",
    });
    expect(provider.lookups).toHaveLength(2);
  });

  it("propagates a 404 unchanged, caches nothing, and evicts the existing entry", async () => {
    const provider = makeDeps();
    await expect(getCachedUser(provider.deps, "user_gone")).rejects.toMatchObject({
      status: 404,
    });
    // Not cached: the next read asks again.
    await expect(getCachedUser(provider.deps, "user_gone")).rejects.toBeInstanceOf(
      IdentityProviderError,
    );
    expect(provider.lookups).toEqual(["user_gone", "user_gone"]);

    provider.users.set("user_1", { id: "user_1", email: "ada@example.com" });
    await getCachedUser(provider.deps, "user_1");
    provider.users.delete("user_1");
    const deleted = await getCachedUser(provider.deps, "user_1", { fresh: true }).catch(
      (error: unknown) => error,
    );
    expect(deleted).toBeInstanceOf(IdentityProviderError);
    expect(deleted).toMatchObject({ status: 404 });
    // Evicted: a plain read inside the TTL goes back to the provider instead of
    // describing the deleted user.
    await expect(getCachedUser(provider.deps, "user_1")).rejects.toMatchObject({ status: 404 });
    expect(provider.lookups.filter((id) => id === "user_1")).toHaveLength(3);
  });

  it("caches nothing on a non-404 failure and keeps an existing entry", async () => {
    const provider = makeDeps();
    provider.users.set("user_1", { id: "user_1", email: "ada@example.com" });
    provider.failNext(new IdentityProviderError(503, "Provider outage"));
    await expect(getCachedUser(provider.deps, "user_1")).rejects.toMatchObject({ status: 503 });
    provider.failNext(undefined);
    await getCachedUser(provider.deps, "user_1");
    expect(provider.lookups).toHaveLength(2);

    // An outage on a fresh read neither evicts nor replaces what is cached.
    provider.failNext(new Error("socket hang up"));
    await expect(getCachedUser(provider.deps, "user_1", { fresh: true })).rejects.toThrow(
      "socket hang up",
    );
    provider.failNext(undefined);
    await expect(getCachedUser(provider.deps, "user_1")).resolves.toMatchObject({
      email: "ada@example.com",
    });
    expect(provider.lookups).toHaveLength(3);
  });

  it("invalidateUserCache forces only that user's next lookup back to the provider", async () => {
    const provider = makeDeps();
    provider.users.set("user_1", { id: "user_1", email: "a@example.com" });
    provider.users.set("user_2", { id: "user_2", email: "b@example.com" });
    await getCachedUser(provider.deps, "user_1");
    await getCachedUser(provider.deps, "user_2");

    invalidateUserCache("user_1");
    await getCachedUser(provider.deps, "user_1");
    await getCachedUser(provider.deps, "user_2");

    expect(provider.lookups).toEqual(["user_1", "user_2", "user_1"]);
  });
});
