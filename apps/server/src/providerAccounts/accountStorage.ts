// FILE: accountStorage.ts
// Purpose: Filesystem storage for the machine-global provider account root.
// Layer: Server service internals (plan sections 9-11)
// Exports: makeAccountStorage, AccountStorageShape, ProviderAccountStorageError.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  AppProcessLease,
  ProviderAccountRecord,
  type AccountSurface,
  type SupportedAccountProvider,
} from "@synara/contracts";
import { secretName } from "@synara/shared/providerAccounts/accountIds";
import {
  accountDir,
  accountJsonPath,
  accountsDir,
  activePointerDir,
  activePointerPath,
  appLeasesDir,
  launcherDiagnosticsDir,
  pendingDir,
  pendingPath,
  versionFilePath,
} from "@synara/shared/providerAccounts/accountPaths";
import { Data, Effect, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite";
import { ensurePrivateDirectorySync, PRIVATE_DIRECTORY_MODE } from "../privatePathPermissions";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore";

export const ACCOUNT_ROOT_SCHEMA_VERSION = "1";

export class ProviderAccountStorageError extends Data.TaggedError("ProviderAccountStorageError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const storageError =
  (operation: string, detail: string) =>
  (cause: unknown): ProviderAccountStorageError =>
    new ProviderAccountStorageError({ operation, detail, cause });

const tryFs = <A>(operation: string, detail: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: storageError(operation, detail) });

const decodeAccountRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ProviderAccountRecord),
);
const encodeAccountRecord = Schema.encodeEffect(Schema.fromJsonString(ProviderAccountRecord));
const decodeAppLease = Schema.decodeUnknownEffect(Schema.fromJsonString(AppProcessLease));
const encodeAppLease = Schema.encodeEffect(Schema.fromJsonString(AppProcessLease));

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

export interface AccountStorageInput {
  readonly root: string;
  readonly secretStore: ServerSecretStoreShape;
}

export type AccountStorageShape = ReturnType<typeof makeAccountStorage>;

export function makeAccountStorage(input: AccountStorageInput) {
  const { root, secretStore } = input;
  // Serializes ordinal allocation and pointer writes within this process; the
  // filesystem layout keeps cross-process writers safe via atomic renames.
  const providerLocks = new Map<SupportedAccountProvider, Semaphore.Semaphore>();
  const providerLock = (provider: SupportedAccountProvider): Semaphore.Semaphore => {
    let lock = providerLocks.get(provider);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      providerLocks.set(provider, lock);
    }
    return lock;
  };

  const withProviderLock = <A, E, R>(
    provider: SupportedAccountProvider,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> => providerLock(provider).withPermits(1)(effect);

  const ensureRoot = Effect.gen(function* () {
    const existingVersion = yield* tryFs(
      "accountStorage.ensureRoot",
      `Failed to initialize account root ${root}.`,
      async () => {
        for (const dir of [
          root,
          activePointerDir(root),
          path.join(root, "accounts"),
          path.join(root, "pending"),
          path.join(root, "locks"),
          appLeasesDir(root),
          launcherDiagnosticsDir(root),
        ]) {
          ensurePrivateDirectorySync(dir);
        }
        return readFileIfExists(versionFilePath(root));
      },
    );
    if (existingVersion === null) {
      yield* writeFileStringAtomically({
        filePath: versionFilePath(root),
        contents: ACCOUNT_ROOT_SCHEMA_VERSION,
      }).pipe(
        Effect.mapError(
          storageError("accountStorage.ensureRoot", "Failed to write account root version file."),
        ),
      );
    }
  });

  const readVersion = tryFs(
    "accountStorage.readVersion",
    "Failed to read account root version file.",
    async () => (await readFileIfExists(versionFilePath(root)))?.trim() ?? null,
  );

  const readActiveOrdinal = (provider: SupportedAccountProvider) =>
    tryFs(
      "accountStorage.readActiveOrdinal",
      `Failed to read active pointer for '${provider}'.`,
      async () => {
        const contents = await readFileIfExists(activePointerPath(root, provider));
        if (contents === null) return null;
        const ordinal = Number(contents.trim());
        return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : null;
      },
    );

  const writeActiveOrdinal = (provider: SupportedAccountProvider, ordinal: number) =>
    ensureRoot.pipe(
      Effect.andThen(
        writeFileStringAtomically({
          filePath: activePointerPath(root, provider),
          contents: String(ordinal),
        }).pipe(
          Effect.mapError(
            storageError(
              "accountStorage.writeActiveOrdinal",
              `Failed to write active pointer for '${provider}'.`,
            ),
          ),
        ),
      ),
    );

  const readAccount = (provider: SupportedAccountProvider, ordinal: number) =>
    tryFs(
      "accountStorage.readAccount",
      `Failed to read account record for '${provider}' ordinal ${ordinal}.`,
      () => readFileIfExists(accountJsonPath(root, provider, ordinal)),
    ).pipe(
      Effect.flatMap((contents) =>
        contents === null
          ? Effect.succeed(null)
          : decodeAccountRecord(contents).pipe(
              Effect.mapError(
                storageError(
                  "accountStorage.readAccount",
                  `Account record for '${provider}' ordinal ${ordinal} is invalid.`,
                ),
              ),
            ),
      ),
    );

  const writeAccount = (record: ProviderAccountRecord) =>
    encodeAccountRecord(record).pipe(
      Effect.mapError(
        storageError(
          "accountStorage.writeAccount",
          `Failed to encode account record for '${record.provider}' ordinal ${record.ordinal}.`,
        ),
      ),
      Effect.flatMap((contents) =>
        tryFs(
          "accountStorage.writeAccount",
          `Failed to prepare account directory for '${record.provider}' ordinal ${record.ordinal}.`,
          async () => {
            ensurePrivateDirectorySync(accountDir(root, record.provider, record.ordinal));
          },
        ).pipe(
          Effect.andThen(
            writeFileStringAtomically({
              filePath: accountJsonPath(root, record.provider, record.ordinal),
              contents,
            }).pipe(
              Effect.mapError(
                storageError(
                  "accountStorage.writeAccount",
                  `Failed to write account record for '${record.provider}' ordinal ${record.ordinal}.`,
                ),
              ),
            ),
          ),
        ),
      ),
    );

  const listOrdinals = (provider: SupportedAccountProvider) =>
    tryFs(
      "accountStorage.listOrdinals",
      `Failed to list account directories for '${provider}'.`,
      async () => {
        try {
          const entries = await fs.readdir(accountsDir(root, provider), { withFileTypes: true });
          return entries
            .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name))
            .map((entry) => Number(entry.name))
            .toSorted((left, right) => left - right);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw cause;
        }
      },
    );

  const listAccounts = (provider: SupportedAccountProvider) =>
    listOrdinals(provider).pipe(
      Effect.flatMap((ordinals) =>
        Effect.forEach(ordinals, (ordinal) => readAccount(provider, ordinal)),
      ),
      Effect.map((records) => records.filter((record) => record !== null)),
    );

  const nextOrdinal = (provider: SupportedAccountProvider) =>
    listOrdinals(provider).pipe(
      Effect.map((ordinals) => (ordinals.length === 0 ? 1 : Math.max(...ordinals) + 1)),
    );

  const createPendingDirectory = (provider: SupportedAccountProvider, operationId: string) =>
    ensureRoot.pipe(
      Effect.andThen(
        tryFs(
          "accountStorage.createPendingDirectory",
          `Failed to create pending directory for '${provider}' operation '${operationId}'.`,
          async () => {
            const directory = pendingPath(root, provider, operationId);
            ensurePrivateDirectorySync(path.join(directory, "agent", "home"));
            return directory;
          },
        ),
      ),
    );

  // Allocates the ordinal only at finalization so failed or cancelled logins
  // never consume account numbers (plan section 10).
  const finalizePendingDirectory = (provider: SupportedAccountProvider, operationId: string) =>
    withProviderLock(
      provider,
      nextOrdinal(provider).pipe(
        Effect.flatMap((ordinal) =>
          tryFs(
            "accountStorage.finalizePendingDirectory",
            `Failed to finalize pending directory for '${provider}' operation '${operationId}'.`,
            async () => {
              const target = accountDir(root, provider, ordinal);
              ensurePrivateDirectorySync(path.dirname(target));
              await fs.rename(pendingPath(root, provider, operationId), target);
              await fs.chmod(target, PRIVATE_DIRECTORY_MODE).catch(() => undefined);
              return ordinal;
            },
          ),
        ),
      ),
    );

  const cancelPendingDirectory = (provider: SupportedAccountProvider, operationId: string) =>
    tryFs(
      "accountStorage.cancelPendingDirectory",
      `Failed to remove pending directory for '${provider}' operation '${operationId}'.`,
      () => fs.rm(pendingPath(root, provider, operationId), { recursive: true, force: true }),
    );

  const cleanupPendingDirectories = (provider: SupportedAccountProvider) =>
    tryFs(
      "accountStorage.cleanupPendingDirectories",
      `Failed to clean pending directories for '${provider}'.`,
      () => fs.rm(pendingDir(root, provider), { recursive: true, force: true }),
    );

  const secretStoreError = (operation: string, name: string) =>
    storageError(operation, `Secret store operation failed for '${name}'.`);

  const readSecret = (
    provider: SupportedAccountProvider,
    ordinal: number,
    surface: AccountSurface,
  ) => {
    const name = secretName(provider, ordinal, surface);
    return secretStore.get(name).pipe(
      Effect.map((bytes) => (bytes === null ? null : new TextDecoder().decode(bytes))),
      Effect.mapError(secretStoreError("accountStorage.readSecret", name)),
    );
  };

  const writeSecret = (
    provider: SupportedAccountProvider,
    ordinal: number,
    surface: AccountSurface,
    value: string,
  ) => {
    const name = secretName(provider, ordinal, surface);
    return secretStore
      .set(name, new TextEncoder().encode(value))
      .pipe(Effect.mapError(secretStoreError("accountStorage.writeSecret", name)));
  };

  const deleteSecret = (
    provider: SupportedAccountProvider,
    ordinal: number,
    surface: AccountSurface,
  ) => {
    const name = secretName(provider, ordinal, surface);
    return secretStore
      .remove(name)
      .pipe(Effect.mapError(secretStoreError("accountStorage.deleteSecret", name)));
  };

  const appLeasePath = (provider: SupportedAccountProvider, ordinal: number) =>
    path.join(appLeasesDir(root), `${provider}-${ordinal}.json`);

  const readAppLease = (provider: SupportedAccountProvider, ordinal: number) =>
    tryFs(
      "accountStorage.readAppLease",
      `Failed to read app lease for '${provider}' ordinal ${ordinal}.`,
      () => readFileIfExists(appLeasePath(provider, ordinal)),
    ).pipe(
      Effect.flatMap((contents) =>
        contents === null
          ? Effect.succeed(null)
          : decodeAppLease(contents).pipe(Effect.orElseSucceed(() => null)),
      ),
    );

  const writeAppLease = (lease: AppProcessLease) =>
    encodeAppLease(lease).pipe(
      Effect.mapError(
        storageError(
          "accountStorage.writeAppLease",
          `Failed to encode app lease for '${lease.provider}' ordinal ${lease.ordinal}.`,
        ),
      ),
      Effect.flatMap((contents) =>
        writeFileStringAtomically({
          filePath: appLeasePath(lease.provider, lease.ordinal),
          contents,
        }).pipe(
          Effect.mapError(
            storageError(
              "accountStorage.writeAppLease",
              `Failed to write app lease for '${lease.provider}' ordinal ${lease.ordinal}.`,
            ),
          ),
        ),
      ),
    );

  const clearAppLease = (provider: SupportedAccountProvider, ordinal: number) =>
    tryFs(
      "accountStorage.clearAppLease",
      `Failed to clear app lease for '${provider}' ordinal ${ordinal}.`,
      () => fs.rm(appLeasePath(provider, ordinal), { force: true }),
    );

  const hiddenMarkerPath = (provider: SupportedAccountProvider, ordinal: number) =>
    path.join(accountDir(root, provider, ordinal), "hidden");

  const hideAccount = (provider: SupportedAccountProvider, ordinal: number) =>
    writeFileStringAtomically({
      filePath: hiddenMarkerPath(provider, ordinal),
      contents: "",
    }).pipe(
      Effect.mapError(
        storageError(
          "accountStorage.hideAccount",
          `Failed to hide account '${provider}' ordinal ${ordinal}.`,
        ),
      ),
    );

  const isAccountHidden = (provider: SupportedAccountProvider, ordinal: number) =>
    tryFs(
      "accountStorage.isAccountHidden",
      `Failed to inspect hidden marker for '${provider}' ordinal ${ordinal}.`,
      async () => (await readFileIfExists(hiddenMarkerPath(provider, ordinal))) !== null,
    );

  return {
    root,
    ensureRoot,
    readVersion,
    withProviderLock,
    readActiveOrdinal,
    writeActiveOrdinal,
    readAccount,
    writeAccount,
    listOrdinals,
    listAccounts,
    nextOrdinal,
    createPendingDirectory,
    finalizePendingDirectory,
    cancelPendingDirectory,
    cleanupPendingDirectories,
    readSecret,
    writeSecret,
    deleteSecret,
    readAppLease,
    writeAppLease,
    clearAppLease,
    hideAccount,
    isAccountHidden,
  };
}
