import * as Crypto from "node:crypto";

import { Effect, FileSystem, Layer, Path } from "effect";

import { ServerConfig } from "../../config";
import {
  SecretStoreError,
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../Services/ServerSecretStore";

const secretFileName = (name: string): string => `${name.replace(/[^a-zA-Z0-9_.-]/g, "_")}.bin`;

export const makeServerSecretStore = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  yield* fileSystem.makeDirectory(serverConfig.secretsDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new SecretStoreError({
          message: `Failed to create secrets directory ${serverConfig.secretsDir}.`,
          cause,
        }),
    ),
  );
  yield* fileSystem
    .chmod(serverConfig.secretsDir, 0o700)
    .pipe(Effect.orElseSucceed(() => undefined));

  const resolveSecretPath = (name: string) =>
    path.join(serverConfig.secretsDir, secretFileName(name));

  const get: ServerSecretStoreShape["get"] = (name) =>
    Effect.gen(function* () {
      const secretPath = resolveSecretPath(name);
      const exists = yield* fileSystem.exists(secretPath).pipe(Effect.orElseSucceed(() => false));
      if (!exists) return null;
      return yield* fileSystem
        .readFile(secretPath)
        .pipe(Effect.map((bytes) => Uint8Array.from(bytes)));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreError({
            message: `Failed to read secret ${name}.`,
            cause,
          }),
      ),
    );

  const set: ServerSecretStoreShape["set"] = (name, value) => {
    const secretPath = resolveSecretPath(name);
    const tempPath = `${secretPath}.${process.pid}.${Date.now()}.${Crypto.randomUUID()}.tmp`;
    return Effect.gen(function* () {
      yield* fileSystem.writeFile(tempPath, value);
      yield* fileSystem.chmod(tempPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
      yield* fileSystem.rename(tempPath, secretPath);
      yield* fileSystem.chmod(secretPath, 0o600).pipe(Effect.orElseSucceed(() => undefined));
    }).pipe(
      Effect.catch((cause) =>
        fileSystem.remove(tempPath).pipe(
          Effect.ignore,
          Effect.flatMap(() =>
            Effect.fail(
              new SecretStoreError({
                message: `Failed to persist secret ${name}.`,
                cause,
              }),
            ),
          ),
        ),
      ),
    );
  };

  const getOrCreateRandom: ServerSecretStoreShape["getOrCreateRandom"] = (name, bytes) =>
    get(name).pipe(
      Effect.flatMap((existing) => {
        if (existing) return Effect.succeed(existing);
        const generated = Uint8Array.from(Crypto.randomBytes(bytes));
        return set(name, generated).pipe(Effect.as(generated));
      }),
    );

  const remove: ServerSecretStoreShape["remove"] = (name) =>
    fileSystem.remove(resolveSecretPath(name), { force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new SecretStoreError({
            message: `Failed to remove secret ${name}.`,
            cause,
          }),
      ),
    );

  return { get, set, getOrCreateRandom, remove } satisfies ServerSecretStoreShape;
});

export const ServerSecretStoreLive = Layer.effect(ServerSecretStore, makeServerSecretStore);
