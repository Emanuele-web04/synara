import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  accountAgentHome,
  accountDir,
  accountSecretPath,
  pendingPath,
} from "@synara/shared/providerAccounts/accountPaths";
import {
  makeAccountStorage,
  ProviderAccountStorageError,
  FINALIZE_MARKER_FILE,
} from "./accountStorage";
import { makeAccountConnect } from "./accountConnect";
import { makeAccountResolver } from "./accountResolver";

describe("account transaction commit boundaries", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "synara-account-transactions-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("does not erase a key after the record rename committed but durability reporting failed", async () => {
    const storage = makeAccountStorage({ root });
    const connect = makeAccountConnect({
      storage: {
        ...storage,
        writeAccount: (record) =>
          storage.writeAccount(record).pipe(
            Effect.andThen(
              Effect.fail(
                new ProviderAccountStorageError({
                  operation: "test",
                  detail: "post-rename durability failure",
                }),
              ),
            ),
          ),
      },
    });
    await expect(
      Effect.runPromise(
        connect.beginConnect({ kind: "agent-api-key", provider: "grok", apiKey: "fixture-key" }),
      ),
    ).rejects.toMatchObject({ detail: "post-rename durability failure" });
    expect((await Effect.runPromise(storage.readAccount("grok", 1)))?.agent?.secretVersion).toBe(1);
    await expect(Effect.runPromise(storage.readSecret("grok", 1, "agent"))).resolves.toBe(
      "fixture-key",
    );
  });

  it("serializes reconnect generations across independent storage instances", async () => {
    const first = makeAccountStorage({ root });
    const second = makeAccountStorage({ root });
    const connectA = makeAccountConnect({ storage: first });
    const connectB = makeAccountConnect({ storage: second });
    await Effect.runPromise(
      connectA.beginConnect({ kind: "agent-api-key", provider: "grok", apiKey: "initial" }),
    );
    await Promise.all([
      Effect.runPromise(
        connectA.beginConnect({
          kind: "agent-api-key",
          provider: "grok",
          ordinal: 1,
          apiKey: "key-A",
        }),
      ),
      Effect.runPromise(
        connectB.beginConnect({
          kind: "agent-api-key",
          provider: "grok",
          ordinal: 1,
          apiKey: "key-B",
        }),
      ),
    ]);
    expect((await Effect.runPromise(first.readAccount("grok", 1)))?.agent?.generation).toBe(3);
    expect(["key-A", "key-B"]).toContain(
      await Effect.runPromise(first.readSecret("grok", 1, "agent")),
    );
  });

  it("reclaims a crashed new-account reservation and its out-of-directory secret", async () => {
    const storage = makeAccountStorage({ root });
    const ordinal = await Effect.runPromise(storage.reserveOrdinalDirectory("grok"));
    await Effect.runPromise(storage.writeSecret("grok", ordinal, "agent", "uncommitted", 1));
    writeFileSync(
      join(accountDir(root, "grok", ordinal), FINALIZE_MARKER_FILE),
      JSON.stringify({ pid: 2147483647 }),
    );
    await Effect.runPromise(storage.recoverIncompleteFinalizations("grok"));
    expect(existsSync(accountDir(root, "grok", ordinal))).toBe(false);
    expect(existsSync(accountSecretPath(root, "grok", ordinal, "agent", 1))).toBe(false);
  });

  it("keeps OAuth credentials selected by the old record until the new record commits", async () => {
    const storage = makeAccountStorage({ root });
    await Effect.runPromise(storage.ensureRoot);
    const oldHome = accountAgentHome(root, "codex", 1);
    mkdirSync(oldHome, { recursive: true });
    writeFileSync(join(oldHome, "auth.json"), "old fixture");
    const record = {
      schemaVersion: 1 as const,
      provider: "codex" as const,
      ordinal: 1,
      createdAt: "2026-10-10T00:00:00.000Z",
      agent: { generation: 1, state: "connected" as const, authMethod: "oauth" as const },
    };
    await Effect.runPromise(storage.writeAccount(record));
    await Effect.runPromise(storage.createPendingDirectory("codex", "operation"));
    writeFileSync(
      join(pendingPath(root, "codex", "operation"), "agent", "home", "auth.json"),
      "new fixture",
    );
    const version = await Effect.runPromise(storage.commitReconnectHome("codex", "operation", 1));
    // Simulate a restart before account.json changes.
    const reopened = makeAccountStorage({ root });
    const resolver = makeAccountResolver({ storage: reopened });
    const oldLaunch = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 1 }),
    );
    expect(readFileSync(join(oldLaunch.profilePath!, "auth.json"), "utf8")).toBe("old fixture");
    await Effect.runPromise(
      reopened.writeAccount({
        ...record,
        agent: { ...record.agent, generation: version, homeVersion: version },
      }),
    );
    const newLaunch = await Effect.runPromise(
      resolver.resolveAccountLaunch({ provider: "codex", surface: "agent", explicitOrdinal: 1 }),
    );
    expect(readFileSync(join(newLaunch.profilePath!, "auth.json"), "utf8")).toBe("new fixture");
  });
});
