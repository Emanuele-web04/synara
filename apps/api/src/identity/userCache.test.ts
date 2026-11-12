import { beforeEach, describe, expect, it } from "vitest";
import { IdentityProviderError, type IdentityUser } from "./interfaces";
import {
  clearUserCache,
  getCachedUser,
  invalidateUserCache,
  userCacheSize,
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

/**
 * A provider stand-in whose every lookup stays pending until the test settles
 * it, so overlapping reads can be staged deterministically.
 */
function deferredLookup(user: IdentityUser) {
  const calls: Array<{ resolve(): void; reject(error: Error): void }> = [];
  const deps: UserCacheDeps = {
    getUser: () =>
      new Promise<IdentityUser>((resolve, reject) => {
        calls.push({ resolve: () => resolve({ ...user }), reject });
      }),
    now: () => 1_000_000,
  };
  return { deps, calls };
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

  it("answers a plain read from the expired entry when the provider fails", async () => {
    const provider = makeDeps();
    provider.users.set("user_1", { id: "user_1", email: "ada@example.com" });
    await getCachedUser(provider.deps, "user_1");

    for (const failure of [
      new IdentityProviderError(503, "Provider outage"),
      new IdentityProviderError(504, "Provider timed out"),
      new Error("The operation was aborted due to timeout"),
    ]) {
      provider.clock.now += 60_000;
      provider.failNext(failure);
      // Expired, so the provider is still asked; its failure is absorbed.
      const asked = provider.lookups.length;
      await expect(getCachedUser(provider.deps, "user_1")).resolves.toMatchObject({
        email: "ada@example.com",
      });
      expect(provider.lookups).toHaveLength(asked + 1);
    }

    // The fallback is not a refill: once the provider answers, its answer wins.
    provider.failNext(undefined);
    provider.users.set("user_1", { id: "user_1", email: "renamed@example.com" });
    await expect(getCachedUser(provider.deps, "user_1")).resolves.toMatchObject({
      email: "renamed@example.com",
    });
  });

  it("stops answering from an expired entry once it is older than the stale window", async () => {
    const provider = makeDeps();
    provider.users.set("user_1", { id: "user_1", email: "ada@example.com" });
    await getCachedUser(provider.deps, "user_1");
    provider.failNext(new IdentityProviderError(503, "Provider outage"));

    provider.clock.now += 10 * 60_000 - 1;
    await expect(getCachedUser(provider.deps, "user_1")).resolves.toMatchObject({
      email: "ada@example.com",
    });
    provider.clock.now += 1;
    await expect(getCachedUser(provider.deps, "user_1")).rejects.toMatchObject({ status: 503 });
  });

  it("never answers a fresh read from an expired or current entry", async () => {
    const provider = makeDeps();
    provider.users.set("user_1", { id: "user_1", email: "ada@example.com" });
    await getCachedUser(provider.deps, "user_1");
    provider.failNext(new IdentityProviderError(503, "Provider outage"));

    await expect(getCachedUser(provider.deps, "user_1", { fresh: true })).rejects.toMatchObject({
      status: 503,
    });
    provider.clock.now += 60_000;
    await expect(getCachedUser(provider.deps, "user_1", { fresh: true })).rejects.toMatchObject({
      status: 503,
    });
  });

  it("does not answer a deleted account from the expired entry", async () => {
    const provider = makeDeps();
    provider.users.set("user_1", { id: "user_1", email: "ada@example.com" });
    await getCachedUser(provider.deps, "user_1");
    provider.users.delete("user_1");
    provider.clock.now += 60_000;

    await expect(getCachedUser(provider.deps, "user_1")).rejects.toMatchObject({ status: 404 });
    // Evicted as well: a later outage has nothing to fall back to.
    provider.failNext(new IdentityProviderError(503, "Provider outage"));
    await expect(getCachedUser(provider.deps, "user_1")).rejects.toMatchObject({ status: 503 });
  });

  it("shares one provider call between concurrent cold reads", async () => {
    const gate = deferredLookup({ id: "user_1", email: "ada@example.com" });
    const reads = [
      getCachedUser(gate.deps, "user_1"),
      getCachedUser(gate.deps, "user_1"),
      getCachedUser(gate.deps, "user_1"),
    ];
    expect(gate.calls).toHaveLength(1);
    gate.calls[0]!.resolve();
    for (const user of await Promise.all(reads))
      expect(user).toMatchObject({ email: "ada@example.com" });
    // Settled: the flight is released and the entry answers from cache.
    await getCachedUser(gate.deps, "user_1");
    expect(gate.calls).toHaveLength(1);
  });

  it("gives every sharer of a failed cold read the failure, and retries afterwards", async () => {
    const gate = deferredLookup({ id: "user_1", email: "ada@example.com" });
    const reads = [getCachedUser(gate.deps, "user_1"), getCachedUser(gate.deps, "user_1")];
    gate.calls[0]!.reject(new IdentityProviderError(503, "Provider outage"));
    for (const result of await Promise.allSettled(reads))
      expect(result).toMatchObject({ status: "rejected", reason: { status: 503 } });

    const retry = getCachedUser(gate.deps, "user_1");
    expect(gate.calls).toHaveLength(2);
    gate.calls[1]!.resolve();
    await expect(retry).resolves.toMatchObject({ email: "ada@example.com" });
  });

  it("makes a fresh read ask the provider itself while a plain read is in flight", async () => {
    const gate = deferredLookup({ id: "user_1", email: "ada@example.com" });
    const plain = getCachedUser(gate.deps, "user_1");
    const fresh = getCachedUser(gate.deps, "user_1", { fresh: true });
    expect(gate.calls).toHaveLength(2);

    // The plain read's provider call fails; the fresh one must not inherit it.
    gate.calls[0]!.reject(new IdentityProviderError(503, "Provider outage"));
    await expect(plain).rejects.toMatchObject({ status: 503 });
    gate.calls[1]!.resolve();
    await expect(fresh).resolves.toMatchObject({ email: "ada@example.com" });

    // Two fresh reads never share a call either.
    const both = [
      getCachedUser(gate.deps, "user_1", { fresh: true }),
      getCachedUser(gate.deps, "user_1", { fresh: true }),
    ];
    expect(gate.calls).toHaveLength(4);
    gate.calls[2]!.resolve();
    gate.calls[3]!.resolve();
    await Promise.all(both);
  });

  it("starts a new lookup after a live 404 even if an older lookup is pending", async () => {
    const gate = deferredLookup({ id: "user_1", email: "ada@example.com" });
    const earlier = getCachedUser(gate.deps, "user_1");
    const fresh = getCachedUser(gate.deps, "user_1", { fresh: true });
    const deleted = new IdentityProviderError(404, "User not found");
    gate.calls[1]!.reject(deleted);
    await expect(fresh).rejects.toBe(deleted);

    const later = getCachedUser(gate.deps, "user_1");
    gate.calls[2]?.reject(deleted);
    gate.calls[0]!.resolve();
    await expect(later).rejects.toBe(deleted);
    await earlier;
  });

  it("lets a plain read share a fresh read already in flight", async () => {
    const gate = deferredLookup({ id: "user_1", email: "ada@example.com" });
    const fresh = getCachedUser(gate.deps, "user_1", { fresh: true });
    const plain = getCachedUser(gate.deps, "user_1");
    expect(gate.calls).toHaveLength(1);
    gate.calls[0]!.resolve();
    await expect(Promise.all([fresh, plain])).resolves.toHaveLength(2);
  });

  it("does not re-cache a user from a lookup that was in flight when the entry was invalidated", async () => {
    const gate = deferredLookup({ id: "user_1", email: "ada@example.com" });
    const racing = getCachedUser(gate.deps, "user_1");
    invalidateUserCache("user_1");
    // A reader arriving after the invalidation does not share the older call.
    const later = getCachedUser(gate.deps, "user_1");
    expect(gate.calls).toHaveLength(2);
    gate.calls[0]!.resolve();
    await racing;
    expect(userCacheSize()).toBe(0);
    gate.calls[1]!.resolve();
    await later;
    expect(userCacheSize()).toBe(1);
  });

  it("evicts entries older than the stale window as later lookups pass by", async () => {
    const provider = makeDeps();
    for (let index = 0; index < 40; index += 1) {
      const id = `user_${index}`;
      provider.users.set(id, { id, email: `${id}@example.com` });
      await getCachedUser(provider.deps, id);
    }
    expect(userCacheSize()).toBe(40);

    // Expired for reads, but still inside the stale window: kept.
    provider.clock.now += 10 * 60_000 - 1;
    for (let pass = 0; pass < 10; pass += 1) await getCachedUser(provider.deps, "user_0");
    expect(userCacheSize()).toBe(40);

    // Past the stale window nothing can use them; each lookup reclaims a few
    // and only the user still being read remains.
    provider.clock.now += 1;
    for (let pass = 0; pass < 10; pass += 1) await getCachedUser(provider.deps, "user_0");
    expect(userCacheSize()).toBe(1);
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
