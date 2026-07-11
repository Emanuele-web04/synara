import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { it, assert } from "@effect/vitest";
import { assertFailure, assertSome } from "@effect/vitest/utils";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError } from "../Errors.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

function makeDirectoryLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(persistenceLayer),
  );
  return Layer.mergeAll(
    runtimeRepositoryLayer,
    ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer)),
    NodeServices.layer,
  );
}

it.layer(makeDirectoryLayer(SqlitePersistenceMemory))("ProviderSessionDirectoryLive", (it) => {
  it("upserts, reads, and removes thread bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const initialThreadId = ThreadId.makeUnsafe("thread-1");

      yield* directory.upsert({
        provider: "codex",
        providerInstanceId: "codex",
        threadId: initialThreadId,
      });

      const provider = yield* directory.getProvider(initialThreadId);
      assert.equal(provider, "codex");
      const resolvedBinding = yield* directory.getBinding(initialThreadId);
      assertSome(resolvedBinding, {
        threadId: initialThreadId,
        provider: "codex",
        providerInstanceId: "codex",
      });
      if (Option.isSome(resolvedBinding)) {
        assert.equal(resolvedBinding.value.threadId, initialThreadId);
      }

      const nextThreadId = ThreadId.makeUnsafe("thread-2");

      yield* directory.upsert({
        provider: "codex",
        providerInstanceId: "codex",
        threadId: nextThreadId,
      });
      const updatedBinding = yield* directory.getBinding(nextThreadId);
      assert.equal(Option.isSome(updatedBinding), true);
      if (Option.isSome(updatedBinding)) {
        assert.equal(updatedBinding.value.threadId, nextThreadId);
      }

      const runtime = yield* runtimeRepository.getByThreadId({ threadId: nextThreadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, nextThreadId);
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.providerName, "codex");
        assert.equal(runtime.value.providerInstanceId, "codex");
      }

      const threadIds = yield* directory.listThreadIds();
      assert.deepEqual(threadIds, [nextThreadId]);

      yield* directory.remove(nextThreadId);
      const missingProvider = yield* directory.getProvider(nextThreadId).pipe(Effect.result);
      assertFailure(
        missingProvider,
        new ProviderSessionDirectoryPersistenceError({
          operation: "ProviderSessionDirectory.getProvider",
          detail: `No persisted provider binding found for thread '${nextThreadId}'.`,
        }),
      );
    }));

  it("persists runtime fields and merges payload updates", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const threadId = ThreadId.makeUnsafe("thread-runtime");

      yield* directory.upsert({
        provider: "codex",
        providerInstanceId: "codex",
        threadId,
        status: "starting",
        resumeCursor: {
          threadId: "provider-thread-runtime",
        },
        runtimePayload: {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
        },
      });

      yield* directory.upsert({
        provider: "codex",
        providerInstanceId: "codex",
        threadId,
        status: "running",
        runtimePayload: {
          activeTurnId: "turn-1",
        },
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, threadId);
        assert.equal(runtime.value.status, "running");
        assert.deepEqual(runtime.value.resumeCursor, {
          threadId: "provider-thread-runtime",
        });
        assert.deepEqual(runtime.value.runtimePayload, {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
          providerInstanceId: "codex",
          activeTurnId: "turn-1",
        });
      }
    }));

  it("clears persisted launch options when a new authoritative payload omits them", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = ThreadId.makeUnsafe("thread-runtime-clear-provider-options");

      yield* directory.upsert({
        provider: "codex",
        providerInstanceId: "codex_work",
        threadId,
        runtimePayload: {
          cwd: "/tmp/project",
          providerOptions: {
            codex: { homePath: "/tmp/codex-work", accountId: "codex_work" },
          },
          providerOptionsCredentialsFingerprint: "old-fingerprint",
        },
      });

      yield* directory.upsert({
        provider: "codex",
        providerInstanceId: "codex_work",
        threadId,
        runtimePayload: {
          model: "gpt-5.5",
          providerOptions: null,
          providerOptionsCredentialsFingerprint: null,
        },
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.deepEqual(runtime.value.runtimePayload, {
          cwd: "/tmp/project",
          providerInstanceId: "codex_work",
          model: "gpt-5.5",
        });
      }
    }));

  it("clears persisted resume cursors when the provider instance changes", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const threadId = ThreadId.makeUnsafe("thread-instance-change");

      yield* directory.upsert({
        provider: "codex",
        providerInstanceId: "codex_personal",
        threadId,
        resumeCursor: {
          threadId: "provider-thread-personal",
        },
      });

      yield* directory.upsert({
        provider: "codex",
        providerInstanceId: "codex_work",
        threadId,
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.resumeCursor, null);
        assert.deepEqual(runtime.value.runtimePayload, {
          providerInstanceId: "codex_work",
        });
      }
    }));

  it("resets adapterKey to the new provider when provider changes without an explicit adapter key", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = ThreadId.makeUnsafe("thread-provider-change");

      yield* runtimeRepository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: "claudeAgent",
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: new Date().toISOString(),
        resumeCursor: null,
        runtimePayload: null,
      });

      yield* directory.upsert({
        provider: "codex",
        providerInstanceId: "codex",
        threadId,
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.providerName, "codex");
        assert.equal(runtime.value.adapterKey, "codex");
      }
    }));

  it("materializes the default provider instance for legacy runtime rows", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = ThreadId.makeUnsafe("thread-legacy-runtime-null-instance");

      yield* runtimeRepository.upsert({
        threadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: new Date().toISOString(),
        resumeCursor: null,
        runtimePayload: null,
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.providerInstanceId, null);
      }

      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.isSome(binding), true);
      if (Option.isSome(binding)) {
        assert.equal(binding.value.provider, "codex");
        assert.equal(binding.value.providerInstanceId, "codex");
      }
    }));

  it("materializes a custom driver id as the default instance for legacy runtime rows", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = ThreadId.makeUnsafe("thread-custom-driver-null-instance");

      yield* runtimeRepository.upsert({
        threadId,
        providerName: "customFork",
        providerInstanceId: null,
        adapterKey: "customFork",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: new Date().toISOString(),
        resumeCursor: null,
        runtimePayload: null,
      });

      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.isSome(binding), true);
      if (Option.isSome(binding)) {
        assert.equal(binding.value.provider, "customFork");
        assert.equal(binding.value.providerInstanceId, "customFork");
      }
    }));

  it("rehydrates persisted mappings across layer restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-directory-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      const threadId = ThreadId.makeUnsafe("thread-restart");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          provider: "codex",
          providerInstanceId: "codex",
          threadId,
        });
      }).pipe(Effect.provide(directoryLayer));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        const provider = yield* directory.getProvider(threadId);
        assert.equal(provider, "codex");

        const resolvedBinding = yield* directory.getBinding(threadId);
        assertSome(resolvedBinding, {
          threadId,
          provider: "codex",
          providerInstanceId: "codex",
        });
        if (Option.isSome(resolvedBinding)) {
          assert.equal(resolvedBinding.value.threadId, threadId);
        }

        const legacyTableRows = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'provider_sessions'
        `;
        assert.equal(legacyTableRows.length, 0);
      }).pipe(Effect.provide(directoryLayer));

      fs.rmSync(tempDir, { recursive: true, force: true });
    }));

  it("rehydrates persisted OpenCode bindings across layer restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-directory-opencode-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      const threadId = ThreadId.makeUnsafe("thread-opencode-restart");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          provider: "opencode",
          providerInstanceId: "opencode",
          threadId,
        });
      }).pipe(Effect.provide(directoryLayer));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;

        const provider = yield* directory.getProvider(threadId);
        assert.equal(provider, "opencode");

        const resolvedBinding = yield* directory.getBinding(threadId);
        assertSome(resolvedBinding, {
          threadId,
          provider: "opencode",
          providerInstanceId: "opencode",
        });
      }).pipe(Effect.provide(directoryLayer));

      fs.rmSync(tempDir, { recursive: true, force: true });
    }));

  it("keeps custom driver names and skips invalid provider driver names when listing bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const invalidThreadId = ThreadId.makeUnsafe("thread-invalid-provider");
      const customThreadId = ThreadId.makeUnsafe("thread-custom-driver");
      const codexThreadId = ThreadId.makeUnsafe("thread-known-provider");

      yield* runtimeRepository.upsert({
        threadId: invalidThreadId,
        providerName: "bad provider",
        providerInstanceId: "bad_provider",
        adapterKey: "bad provider",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: new Date().toISOString(),
        resumeCursor: null,
        runtimePayload: null,
      });
      yield* runtimeRepository.upsert({
        threadId: customThreadId,
        providerName: "customFork",
        providerInstanceId: null,
        adapterKey: "customFork",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: new Date().toISOString(),
        resumeCursor: null,
        runtimePayload: null,
      });
      yield* directory.upsert({
        provider: "codex",
        providerInstanceId: "codex",
        threadId: codexThreadId,
      });

      const bindings = yield* directory.listBindings();
      assert.deepEqual(
        bindings.map((binding) => binding.threadId),
        [customThreadId, codexThreadId],
      );
      const customBinding = bindings.find((binding) => binding.threadId === customThreadId);
      assert.equal(customBinding?.provider, "customFork");
      assert.equal(customBinding?.providerInstanceId, "customFork");
    }));
});
