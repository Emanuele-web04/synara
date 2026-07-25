// FILE: accountStorage.test.ts
// Purpose: Focused tests for filesystem account storage.
// Layer: Server unit tests

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderAccountRecord } from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";
import {
  ACCOUNT_ROOT_SCHEMA_VERSION,
  makeAccountStorage,
  type AccountStorageShape,
} from "./accountStorage";

function makeInMemorySecretStore(): ServerSecretStoreShape & { readonly names: () => string[] } {
  const secrets = new Map<string, Uint8Array>();
  return {
    get: (name) => Effect.succeed(secrets.get(name) ?? null),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: (name) =>
      Effect.sync(() => {
        const existing = secrets.get(name);
        if (existing) return existing;
        const generated = new Uint8Array([1, 2, 3]);
        secrets.set(name, generated);
        return generated;
      }),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
    names: () => [...secrets.keys()],
  };
}

const record = (ordinal: number): ProviderAccountRecord => ({
  schemaVersion: 1,
  provider: "codex",
  ordinal,
  createdAt: "2026-07-24T00:00:00.000Z",
  agent: { generation: 1, state: "connected", authMethod: "apiKey" },
});

describe("accountStorage", () => {
  let root: string;
  let storage: AccountStorageShape;
  let secretStore: ReturnType<typeof makeInMemorySecretStore>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "synara-accounts-"));
    secretStore = makeInMemorySecretStore();
    storage = makeAccountStorage({ root, secretStore });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("initializes the root with a version file", async () => {
    await Effect.runPromise(storage.ensureRoot);
    await expect(Effect.runPromise(storage.readVersion)).resolves.toBe(ACCOUNT_ROOT_SCHEMA_VERSION);
  });

  it("round-trips account records and active pointers", async () => {
    await Effect.runPromise(storage.ensureRoot);
    await Effect.runPromise(storage.writeAccount(record(1)));
    await Effect.runPromise(storage.writeActiveOrdinal("codex", 1));

    const loaded = await Effect.runPromise(storage.readAccount("codex", 1));
    expect(loaded?.agent?.state).toBe("connected");
    await expect(Effect.runPromise(storage.readActiveOrdinal("codex"))).resolves.toBe(1);
    await expect(Effect.runPromise(storage.readAccount("codex", 2))).resolves.toBeNull();
    await expect(Effect.runPromise(storage.readActiveOrdinal("grok"))).resolves.toBeNull();
  });

  it("allocates ordinals from scanned account directories", async () => {
    await Effect.runPromise(storage.ensureRoot);
    await expect(Effect.runPromise(storage.nextOrdinal("codex"))).resolves.toBe(1);
    await Effect.runPromise(storage.writeAccount(record(1)));
    await Effect.runPromise(storage.writeAccount(record(3)));
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([1, 3]);
    await expect(Effect.runPromise(storage.nextOrdinal("codex"))).resolves.toBe(4);
  });

  it("finalizes pending directories into allocated ordinals", async () => {
    await Effect.runPromise(storage.ensureRoot);
    await Effect.runPromise(storage.createPendingDirectory("codex", "op-1"));
    const ordinal = await Effect.runPromise(storage.finalizePendingDirectory("codex", "op-1"));
    expect(ordinal).toBe(1);
    await expect(Effect.runPromise(storage.listOrdinals("codex"))).resolves.toEqual([1]);
  });

  it("cancels pending directories without consuming ordinals", async () => {
    await Effect.runPromise(storage.ensureRoot);
    await Effect.runPromise(storage.createPendingDirectory("codex", "op-2"));
    await Effect.runPromise(storage.cancelPendingDirectory("codex", "op-2"));
    await expect(Effect.runPromise(storage.nextOrdinal("codex"))).resolves.toBe(1);
  });

  it("stores account secrets under the account secret name", async () => {
    await Effect.runPromise(storage.writeSecret("codex", 2, "agent", "sk-test"));
    expect(secretStore.names()).toEqual(["provider-account-codex-2-agent"]);
    await expect(Effect.runPromise(storage.readSecret("codex", 2, "agent"))).resolves.toBe(
      "sk-test",
    );
    await Effect.runPromise(storage.deleteSecret("codex", 2, "agent"));
    await expect(Effect.runPromise(storage.readSecret("codex", 2, "agent"))).resolves.toBeNull();
  });

  it("hides accounts via a hidden marker", async () => {
    await Effect.runPromise(storage.ensureRoot);
    await Effect.runPromise(storage.writeAccount(record(1)));
    await expect(Effect.runPromise(storage.isAccountHidden("codex", 1))).resolves.toBe(false);
    await Effect.runPromise(storage.hideAccount("codex", 1));
    await expect(Effect.runPromise(storage.isAccountHidden("codex", 1))).resolves.toBe(true);
  });
});
