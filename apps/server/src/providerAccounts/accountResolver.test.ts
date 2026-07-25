// FILE: accountResolver.test.ts
// Purpose: Focused tests for fail-closed account launch resolution.
// Layer: Server unit tests

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAccountRecord } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";
import { makeAccountResolver, ProviderAccountResolutionError } from "./accountResolver";
import { makeAccountStorage, type AccountStorageShape } from "./accountStorage";

function makeInMemorySecretStore(): ServerSecretStoreShape {
  const secrets = new Map<string, Uint8Array>();
  return {
    get: (name) => Effect.succeed(secrets.get(name) ?? null),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name) =>
      Effect.sync(() => {
        const existing = secrets.get(name);
        if (existing) return existing;
        const generated = new Uint8Array([1]);
        secrets.set(name, generated);
        return generated;
      }),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  };
}

const codexAccount = (input: {
  readonly ordinal: number;
  readonly generation?: number;
  readonly state?: "connected" | "needs-auth";
  readonly authMethod?: "oauth" | "apiKey";
}): ProviderAccountRecord => ({
  schemaVersion: 1,
  provider: "codex",
  ordinal: input.ordinal,
  createdAt: "2026-07-24T00:00:00.000Z",
  agent: {
    generation: input.generation ?? 1,
    state: input.state ?? "connected",
    authMethod: input.authMethod ?? "oauth",
  },
});

const expectResolutionFailure = async (
  effect: Effect.Effect<unknown, unknown>,
  code: ProviderAccountResolutionError["code"],
) => {
  const result = await Effect.runPromise(Effect.flip(effect));
  expect(result).toBeInstanceOf(ProviderAccountResolutionError);
  expect((result as ProviderAccountResolutionError).code).toBe(code);
};

describe("accountResolver", () => {
  let root: string;
  let storage: AccountStorageShape;
  let resolver: ReturnType<typeof makeAccountResolver>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "synara-resolver-"));
    storage = makeAccountStorage({ root, secretStore: makeInMemorySecretStore() });
    resolver = makeAccountResolver({ storage });
    await Effect.runPromise(storage.ensureRoot);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns native launch for account 0", async () => {
    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent" }),
    );
    expect(resolved.ordinal).toBe(0);
    expect(resolved.environment).toEqual({});
    expect(resolved.profilePath).toBeUndefined();
  });

  it("prefers the thread binding over explicit ordinal and active pointer", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1 })));
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 2 })));
    await Effect.runPromise(storage.writeActiveOrdinal("codex", 2));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({
        provider: "codex",
        surface: "agent",
        explicitOrdinal: 2,
        threadBinding: { ordinal: 1, agentGeneration: 1 },
      }),
    );
    expect(resolved.ordinal).toBe(1);
  });

  it("uses the explicit ordinal over the active pointer", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1 })));
    await Effect.runPromise(storage.writeActiveOrdinal("codex", 1));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 0 }),
    );
    expect(resolved.ordinal).toBe(0);
  });

  it("falls back to the active pointer when nothing is selected", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1 })));
    await Effect.runPromise(storage.writeActiveOrdinal("codex", 1));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent" }),
    );
    expect(resolved.ordinal).toBe(1);
    expect(resolved.environment.CODEX_HOME).toContain(join("accounts", "codex", "1"));
  });

  it("fails closed when the selected account does not exist", async () => {
    await expectResolutionFailure(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 7 }),
      "account-not-found",
    );
  });

  it("fails closed when the binding is not connected", async () => {
    await Effect.runPromise(
      storage.writeAccount(codexAccount({ ordinal: 1, state: "needs-auth" })),
    );
    await expectResolutionFailure(
      resolver.resolveAccountLaunch({
        provider: "codex",
        surface: "agent",
        threadBinding: { ordinal: 1, agentGeneration: 1 },
      }),
      "binding-unavailable",
    );
  });

  it("fails closed on a generation mismatch", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1, generation: 3 })));
    await expectResolutionFailure(
      resolver.resolveAccountLaunch({
        provider: "codex",
        surface: "agent",
        threadBinding: { ordinal: 1, agentGeneration: 2 },
      }),
      "generation-mismatch",
    );
  });

  it("fails closed when an API-key account is missing its secret", async () => {
    await Effect.runPromise(
      storage.writeAccount(codexAccount({ ordinal: 1, authMethod: "apiKey" })),
    );
    await expectResolutionFailure(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 1 }),
      "binding-unavailable",
    );
  });

  it("injects the stored API key for managed API-key accounts", async () => {
    await Effect.runPromise(
      storage.writeAccount(codexAccount({ ordinal: 1, authMethod: "apiKey" })),
    );
    await Effect.runPromise(storage.writeSecret("codex", 1, "agent", "sk-managed"));

    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 1 }),
    );
    expect(resolved.environment.OPENAI_API_KEY).toBe("sk-managed");
    expect(resolved.environment.CODEX_HOME).toBe(resolved.profilePath);
  });

  it("keeps OAuth launches free of injected API keys", async () => {
    await Effect.runPromise(storage.writeAccount(codexAccount({ ordinal: 1 })));
    const resolved = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 1 }),
    );
    expect(resolved.environment.OPENAI_API_KEY).toBe("");
    expect(resolved.environment.CODEX_HOME).toBe(resolved.profilePath);
  });
});
