// FILE: codexTextGenerationIsolation.test.ts
// Purpose: Verifies structural config isolation, direct auth mirroring, recovery, and cleanup.
// Layer: Server text-generation isolation tests.

import {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { parse as parseToml } from "smol-toml";
import { expect } from "vitest";

import {
  acquireSecureTempDirectory,
  acquireSecureTempFile,
  buildCodexTextGenerationConfig,
  CodexTextGenerationAuthError,
  CodexTextGenerationConfigError,
  prepareCodexTextGenerationAuthMirror,
  validateCodexTextGenerationAuthAfterRun,
} from "./codexTextGenerationIsolation.ts";

const failSymlink = (() => {
  throw Object.assign(new Error("symlinks unavailable"), { code: "EPERM" });
}) as typeof symlinkSync;

const failHardlink = (() => {
  throw Object.assign(new Error("hard links unavailable"), { code: "EPERM" });
}) as typeof linkSync;

function expectAuthValidationError(run: () => void): CodexTextGenerationAuthError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(CodexTextGenerationAuthError);
    return error as CodexTextGenerationAuthError;
  }
  throw new Error("Expected auth validation to fail.");
}

function privateMode(path: string): number {
  return statSync(path).mode & 0o777;
}

it.layer(NodeServices.layer)("Codex text-generation isolation", (it) => {
  it.effect("rebuilds only selected profile, model, provider, and file auth routing", () =>
    Effect.sync(() => {
      const result = buildCodexTextGenerationConfig(
        [
          'profile = "work profile"',
          'model = "root-model"',
          'model_provider = "unused"',
          'cli_auth_credentials_store = "ephemeral"',
          'sqlite_home = "/private/shared.sqlite"',
          'notify = ["/bin/sh", "-c", "unsafe"]',
          'instructions = "run arbitrary instructions"',
          '"profiles"."work profile"."model" = "profile-model"',
          '"profiles"."work profile"."model_provider" = "azure.prod"',
          '"profiles"."work profile"."chatgpt_base_url" = "https://chat.example.test"',
          "",
          '[model_providers."azure.prod"]',
          'name = "Azure production"',
          'base_url = """',
          'https://azure.example.test/openai"""',
          'env_key = "AZURE_OPENAI_API_KEY"',
          'wire_api = "responses"',
          'query_params = { "api-version" = "2025-04-01" }',
          'unknown_future_command = ["sh", "-c", "unsafe"]',
          "",
          '[model_providers."azure.prod".aws]',
          'profile = "prod"',
          'region = "eu-west-1"',
          'credential_process = "unsafe"',
          "",
          "[model_providers.unused.auth]",
          'command = "unsafe-provider-auth"',
          "",
          "[mcp_servers.unsafe]",
          'command = "unsafe-mcp"',
          "",
          "[[skills.config]]",
          'path = "/unsafe/SKILL.md"',
          "",
          '[plugins."unsafe@local"]',
          "enabled = true",
          "",
          '[projects."/repo"]',
          'trust_level = "trusted"',
          "",
          "[shell_environment_policy]",
          'include_only = ["SECRET"]',
          "",
          "[features]",
          "fast_mode = true",
        ].join("\n"),
      );
      const parsed = parseToml(result.content) as Record<string, unknown>;
      const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
      const selected = providers["azure.prod"];

      expect(selected).toBeDefined();
      if (!selected) throw new Error("Selected provider was not preserved.");

      expect(result.selectedProviderId).toBe("azure.prod");
      expect(result.providerEnvKey).toBe("AZURE_OPENAI_API_KEY");
      expect(parsed.model).toBe("profile-model");
      expect(parsed.model_provider).toBe("azure.prod");
      expect(parsed.chatgpt_base_url).toBe("https://chat.example.test");
      expect(parsed.cli_auth_credentials_store).toBe("file");
      expect(Object.keys(providers)).toEqual(["azure.prod"]);
      expect(selected).toMatchObject({
        name: "Azure production",
        base_url: "https://azure.example.test/openai",
        env_key: "AZURE_OPENAI_API_KEY",
        wire_api: "responses",
        query_params: { "api-version": "2025-04-01" },
        aws: { profile: "prod", region: "eu-west-1" },
      });
      for (const forbidden of [
        "profile",
        "profiles",
        "sqlite_home",
        "notify",
        "instructions",
        "mcp_servers",
        "skills",
        "plugins",
        "projects",
        "shell_environment_policy",
        "features",
      ]) {
        expect(parsed).not.toHaveProperty(forbidden);
      }
      expect(selected).not.toHaveProperty("unknown_future_command");
      expect(selected.aws).not.toHaveProperty("credential_process");
    }),
  );

  it.effect("fails typed and closed for malformed TOML or selected command-backed auth", () =>
    Effect.sync(() => {
      expect(() => buildCodexTextGenerationConfig('model = "unterminated')).toThrowError(
        CodexTextGenerationConfigError,
      );
      expect(() =>
        buildCodexTextGenerationConfig(
          [
            'model_provider = "unsafe"',
            "[model_providers.unsafe]",
            'base_url = "https://example.test"',
            "[model_providers.unsafe.auth]",
            'command = "credential-helper"',
          ].join("\n"),
        ),
      ).toThrowError(/command-backed/);
      expect(() => buildCodexTextGenerationConfig('profile = "missing"')).toThrowError(
        CodexTextGenerationConfigError,
      );
      expect(() => buildCodexTextGenerationConfig('model_provider = "missing"')).toThrowError(
        /selects missing provider/,
      );
    }),
  );

  it.effect("uses a verified same-inode hard link when symlinks are unavailable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const accountHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(accountHome, "auth.json");
      yield* fileSystem.writeFileString(authPath, '{"access_token":"before"}');

      const mirror = prepareCodexTextGenerationAuthMirror(authPath, isolatedHome, {
        symlink: failSymlink,
        link: linkSync,
      });
      expect(mirror?.mode).toBe("hardlink");
      expect(statSync(authPath).dev).toBe(statSync(mirror!.effectiveAuthFilePath).dev);
      expect(statSync(authPath).ino).toBe(statSync(mirror!.effectiveAuthFilePath).ino);

      writeFileSync(mirror!.effectiveAuthFilePath, '{"access_token":"after"}');
      expect(readFileSync(authPath, "utf8")).toBe('{"access_token":"after"}');
    }),
  );

  it.effect("fails closed when neither a symlink nor a hard link is available", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const accountHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(accountHome, "auth.json");
      yield* fileSystem.writeFileString(authPath, '{"access_token":"before"}');

      expect(() =>
        prepareCodexTextGenerationAuthMirror(authPath, isolatedHome, {
          symlink: failSymlink,
          link: failHardlink,
        }),
      ).toThrowError(CodexTextGenerationAuthError);
      expect(existsSync(join(isolatedHome, "auth.json"))).toBe(false);
    }),
  );

  it.effect("accepts a successful same-account ChatGPT token rotation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const accountHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(accountHome, "auth.json");
      yield* fileSystem.writeFileString(
        authPath,
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { account_id: "workspace-1", access_token: "before" },
        }),
      );
      const mirror = prepareCodexTextGenerationAuthMirror(authPath, isolatedHome);

      writeFileSync(
        authPath,
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { account_id: "workspace-1", access_token: "after" },
        }),
      );
      expect(() => validateCodexTextGenerationAuthAfterRun(mirror, true)).not.toThrow();
      expect(lstatSync(mirror!.effectiveAuthFilePath).isSymbolicLink()).toBe(true);
    }),
  );

  it.effect("preserves a detached atomic-replacement candidate instead of losing rotation", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const accountHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(accountHome, "auth.json");
      const baseline = JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { account_id: "workspace-1", access_token: "before" },
      });
      const candidate = JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { account_id: "workspace-1", access_token: "after" },
      });
      yield* fileSystem.writeFileString(authPath, baseline);
      const mirror = prepareCodexTextGenerationAuthMirror(authPath, isolatedHome);

      const replacementPath = join(isolatedHome, "replacement-auth.json");
      writeFileSync(replacementPath, candidate);
      renameSync(replacementPath, mirror!.effectiveAuthFilePath);

      const error = expectAuthValidationError(() =>
        validateCodexTextGenerationAuthAfterRun(mirror, true),
      );
      expect(readFileSync(authPath, "utf8")).toBe(baseline);
      expect(readFileSync(error.recoveryPath!, "utf8")).toBe(baseline);
      expect(readFileSync(error.candidatePath!, "utf8")).toBe(candidate);
      expect(privateMode(error.recoveryPath!)).toBe(0o600);
      expect(privateMode(error.candidatePath!)).toBe(0o600);
      expect(error.message).toContain("Inspect the candidate");
    }),
  );

  it.effect("preserves a recovery baseline without overwriting a racing API-key update", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const accountHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(accountHome, "auth.json");
      const baseline = '{"auth_mode":"apikey","OPENAI_API_KEY":"baseline-secret"}';
      const concurrent = '{"auth_mode":"apikey","OPENAI_API_KEY":"concurrent-secret"}';
      yield* fileSystem.writeFileString(authPath, baseline);
      const mirror = prepareCodexTextGenerationAuthMirror(authPath, isolatedHome, {
        symlink: failSymlink,
        link: linkSync,
      });

      const replacementPath = join(accountHome, "replacement-auth.json");
      writeFileSync(replacementPath, concurrent);
      renameSync(replacementPath, authPath);
      writeFileSync(
        mirror!.effectiveAuthFilePath,
        '{"auth_mode":"apikey","OPENAI_API_KEY":"child-secret"}',
      );

      const error = expectAuthValidationError(() =>
        validateCodexTextGenerationAuthAfterRun(mirror, true),
      );
      expect(readFileSync(authPath, "utf8")).toBe(concurrent);
      expect(error.message).not.toContain("baseline-secret");
      expect(error.message).not.toContain("concurrent-secret");
      expect(error.recoveryPath).toBeTruthy();
      expect(readFileSync(error.recoveryPath!, "utf8")).toBe(baseline);
      expect(privateMode(error.recoveryPath!)).toBe(0o600);
      expect(readFileSync(error.candidatePath!, "utf8")).toContain("child-secret");
      expect(privateMode(error.candidatePath!)).toBe(0o600);
    }),
  );

  it.effect(
    "fails closed for claim-less ChatGPT changes, corruption, and failed-child rotation",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;

        for (const scenario of ["claimless", "corrupt", "failed"] as const) {
          const accountHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: `auth-${scenario}-source-`,
          });
          const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: `auth-${scenario}-target-`,
          });
          const authPath = join(accountHome, "auth.json");
          const baseline =
            scenario === "claimless"
              ? JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "opaque-before" } })
              : JSON.stringify({
                  auth_mode: "chatgpt",
                  tokens: { account_id: "workspace-1", access_token: "before" },
                });
          yield* fileSystem.writeFileString(authPath, baseline);
          const mirror = prepareCodexTextGenerationAuthMirror(authPath, isolatedHome);
          const authoritative =
            scenario === "claimless"
              ? JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "opaque-after" } })
              : scenario === "corrupt"
                ? "{"
                : JSON.stringify({
                    auth_mode: "chatgpt",
                    tokens: { account_id: "workspace-1", access_token: "after" },
                  });
          writeFileSync(authPath, authoritative);

          const error = expectAuthValidationError(() =>
            validateCodexTextGenerationAuthAfterRun(mirror, scenario !== "failed"),
          );
          expect(readFileSync(authPath, "utf8")).toBe(authoritative);
          expect(readFileSync(error.recoveryPath!, "utf8")).toBe(baseline);
          expect(privateMode(error.recoveryPath!)).toBe(0o600);
        }
      }),
  );

  it.effect("creates private resources even under a permissive umask", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => process.umask(0)),
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "secure-parent-" });
          const directoryPath = yield* acquireSecureTempDirectory({
            directory: parent,
            prefix: "private-dir-",
          });
          const filePath = yield* acquireSecureTempFile({
            directory: parent,
            prefix: "private-file-",
            content: "private",
          });

          expect(privateMode(directoryPath)).toBe(0o700);
          expect(privateMode(filePath)).toBe(0o600);
        }).pipe(Effect.scoped),
      (previousUmask) => Effect.sync(() => void process.umask(previousUmask)),
    ),
  );

  it.effect("removes every acquired resource after staged failure and interruption", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cleanup-parent-" });
      let failedFile = "";
      let failedDirectory = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          failedFile = yield* acquireSecureTempFile({
            directory: parent,
            prefix: "failed-file-",
            content: "private",
          });
          failedDirectory = yield* acquireSecureTempDirectory({
            directory: parent,
            prefix: "failed-dir-",
          });
          return yield* Effect.fail(new Error("staged failure"));
        }),
      ).pipe(Effect.exit);
      expect(existsSync(failedFile)).toBe(false);
      expect(existsSync(failedDirectory)).toBe(false);

      let interruptedFile = "";
      let interruptedDirectory = "";
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          interruptedFile = yield* acquireSecureTempFile({
            directory: parent,
            prefix: "interrupted-file-",
            content: "private",
          });
          interruptedDirectory = yield* acquireSecureTempDirectory({
            directory: parent,
            prefix: "interrupted-dir-",
          });
          yield* Deferred.succeed(ready, undefined);
          return yield* Effect.never;
        }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);
      expect(existsSync(interruptedFile)).toBe(false);
      expect(existsSync(interruptedDirectory)).toBe(false);
    }),
  );
});
