// FILE: codexTextGenerationIsolation.test.ts
// Purpose: Verifies config, environment, tool, credential, and resource isolation.
// Layer: Server text-generation isolation tests.

import { execFileSync } from "node:child_process";
import {
  existsSync,
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
  assertNoExternalCodexConfigLayers,
  buildCodexTextGenerationChildEnv,
  buildCodexTextGenerationCliConfigArgs,
  buildCodexTextGenerationConfig,
  buildCodexTextGenerationModelCatalog,
  buildCodexTextGenerationRuntimeConfig,
  CodexTextGenerationAuthError,
  CodexTextGenerationConfigError,
  prepareCodexTextGenerationAuthSnapshot,
} from "./codexTextGenerationIsolation.ts";

function privateMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function jwt(expirySeconds: number, extra: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: expirySeconds, ...extra })}.signature`;
}

it.layer(NodeServices.layer)("Codex text-generation isolation", (it) => {
  it.effect("rebuilds only 0.105-compatible provider routing and credential env names", () =>
    Effect.sync(() => {
      const result = buildCodexTextGenerationConfig(
        [
          'profile = "work profile"',
          'model = "root-model"',
          'model_provider = "unused"',
          'cli_auth_credentials_store = "ephemeral"',
          'sqlite_home = "/private/shared.sqlite"',
          'notify = ["/bin/sh", "-c", "unsafe"]',
          'instructions = "unsafe"',
          '"profiles"."work profile"."model" = "profile-model"',
          '"profiles"."work profile"."model_provider" = "azure.prod"',
          "",
          '[model_providers."azure.prod"]',
          'base_url = "https://azure.example.test/openai"',
          'env_key = "AZURE_OPENAI_API_KEY"',
          'env_http_headers = { "api-key" = "AZURE_HEADER_KEY" }',
          'wire_api = "responses"',
          "websocket_connect_timeout_ms = 999",
          'unknown_future_command = ["sh", "-c", "unsafe"]',
          "",
          "[mcp_servers.unsafe]",
          'command = "unsafe-mcp"',
          "",
          "[features]",
          "shell_tool = true",
        ].join("\n"),
      );
      const parsed = parseToml(result.content) as Record<string, unknown>;
      const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
      const selected = providers["azure.prod"]!;

      expect(result.selectedProviderId).toBe("azure.prod");
      expect(result.providerEnvKeys).toEqual(["AZURE_HEADER_KEY", "AZURE_OPENAI_API_KEY"]);
      expect(result.usesAwsCredentials).toBe(false);
      expect(parsed.model).toBe("profile-model");
      expect(parsed.cli_auth_credentials_store).toBe("file");
      expect(selected).toMatchObject({
        name: "azure.prod",
        base_url: "https://azure.example.test/openai",
        env_key: "AZURE_OPENAI_API_KEY",
        env_http_headers: { "api-key": "AZURE_HEADER_KEY" },
        wire_api: "responses",
      });
      expect(selected).not.toHaveProperty("websocket_connect_timeout_ms");
      expect(selected).not.toHaveProperty("unknown_future_command");
      for (const forbidden of [
        "profile",
        "profiles",
        "sqlite_home",
        "notify",
        "instructions",
        "mcp_servers",
        "features",
      ]) {
        expect(parsed).not.toHaveProperty(forbidden);
      }
    }),
  );

  it.effect("rejects malformed, command-backed, profile-backed, and invalid header config", () =>
    Effect.sync(() => {
      expect(() => buildCodexTextGenerationConfig('model = "unterminated')).toThrowError(
        CodexTextGenerationConfigError,
      );
      expect(() =>
        buildCodexTextGenerationConfig(
          'model_provider="x"\n[model_providers.x]\nname="x"\n[model_providers.x.auth]\ncommand="helper"',
        ),
      ).toThrowError(/command-backed/);
      expect(() =>
        buildCodexTextGenerationConfig(
          'model_provider="x"\n[model_providers.x]\nname="x"\n[model_providers.x.aws]\nprofile="unsafe"',
        ),
      ).toThrowError(/built-in amazon-bedrock/);
      expect(() =>
        buildCodexTextGenerationConfig(
          'model_provider="amazon-bedrock"\n[model_providers.amazon-bedrock.aws]\nprofile="unsafe"',
        ),
      ).toThrowError(/credential_process/);
      expect(() =>
        buildCodexTextGenerationConfig(
          'model_provider="x"\n[model_providers.x]\nname="x"\nenv_http_headers={ Authorization="bad-name!" }',
        ),
      ).toThrowError(/provider credential environment variable/);
      expect(() =>
        buildCodexTextGenerationConfig(
          'model_provider="x"\n[model_providers.x]\nname="x"\nenv_http_headers={ Authorization="SSH_AUTH_SOCK" }',
        ),
      ).toThrowError(/process-control or application secret/);
      for (const envName of ["PATH", "LD_AUDIT", "DYLD_PRINT_TO_FILE", "OPENSSL_CONF"]) {
        expect(() =>
          buildCodexTextGenerationConfig(
            `model_provider="x"\n[model_providers.x]\nname="x"\nenv_key="${envName}"`,
          ),
        ).toThrowError(/process-control or application secret/);
      }
    }),
  );

  it.effect("fails closed when a higher or additive external config layer exists", () =>
    Effect.sync(() => {
      expect(() =>
        assertNoExternalCodexConfigLayers({
          platform: "linux",
          systemConfigPaths: ["/etc/codex/config.toml"],
          fileExists: () => true,
        }),
      ).toThrowError(/outside Synara's isolated home/);
      expect(() =>
        assertNoExternalCodexConfigLayers({
          platform: "darwin",
          systemConfigPaths: [],
          readMacPreference: (key) => (key === "requirements_toml_base64" ? "forced" : undefined),
        }),
      ).toThrowError(/managed macOS preference/);
      expect(() =>
        assertNoExternalCodexConfigLayers({
          platform: "darwin",
          systemConfigPaths: [],
          readMacPreference: () => undefined,
        }),
      ).not.toThrow();
      expect(() =>
        assertNoExternalCodexConfigLayers({
          platform: "darwin",
          systemConfigPaths: [],
          executeMacDefaultsRead: () => {
            throw Object.assign(new Error("timed out"), { stderr: "" });
          },
        }),
      ).toThrowError(/could not be checked safely/);
      expect(() =>
        assertNoExternalCodexConfigLayers({
          platform: "darwin",
          systemConfigPaths: [],
          executeMacDefaultsRead: () => {
            throw Object.assign(new Error("missing"), {
              stderr: "The domain/default pair does not exist",
            });
          },
        }),
      ).not.toThrow();
    }),
  );

  it.effect("routes built-in Bedrock through direct AWS environment metadata only", () =>
    Effect.sync(() => {
      const config = buildCodexTextGenerationConfig(
        'model_provider="amazon-bedrock"\n[model_providers.amazon-bedrock.aws]\nregion="eu-west-1"',
      );
      const parsed = parseToml(config.content) as Record<string, unknown>;
      expect(config.usesAwsCredentials).toBe(true);
      expect(config.awsRegion).toBe("eu-west-1");
      expect(config.providerEnvKeys).toEqual([]);
      expect(parsed.model_provider).toBe("amazon-bedrock");
      expect(parsed).not.toHaveProperty("model_providers");
    }),
  );

  it.effect("pins a text-only tool-free catalog and highest-precedence disable overrides", () =>
    Effect.sync(() => {
      const catalogPath = "/private/isolated/models.json";
      const args = buildCodexTextGenerationCliConfigArgs(catalogPath);
      const overrides = args.filter((_, index) => index % 2 === 1);
      for (const expected of [
        "features.shell_tool=false",
        "features.unified_exec=false",
        "include_apply_patch_tool=false",
        "features.js_repl=false",
        "features.code_mode=false",
        "features.multi_agent=false",
        "features.apps=false",
        "features.connectors=false",
        "features.plugins=false",
        "features.tool_search=false",
        'web_search="disabled"',
        "tools.view_image=false",
        "features.imagegen=false",
        "features.artifact=false",
        "features.memory_tool=false",
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
      ]) {
        expect(overrides).toContain(expected);
      }
      expect(args.filter((value) => value === "--config")).toHaveLength(overrides.length);

      const catalog = JSON.parse(buildCodexTextGenerationModelCatalog("gpt-test"));
      expect(catalog.models).toHaveLength(1);
      expect(catalog.models[0]).toMatchObject({
        slug: "gpt-test",
        apply_patch_tool_type: null,
        experimental_supported_tools: [],
        input_modalities: ["text"],
      });

      const runtime = parseToml(
        buildCodexTextGenerationRuntimeConfig(
          buildCodexTextGenerationConfig('model="gpt-test"').content,
          catalogPath,
        ),
      ) as Record<string, unknown>;
      expect(runtime.model_catalog_json).toBe(catalogPath);
      expect(runtime).toMatchObject({
        approval_policy: "never",
        sandbox_mode: "read-only",
        web_search: "disabled",
        tools: { web_search: false, view_image: false },
      });
      expect(runtime.features).toMatchObject({
        shell_tool: false,
        unified_exec: false,
        apply_patch_freeform: false,
        js_repl: false,
        multi_agent: false,
        apps: false,
        plugins: false,
        tool_search: false,
        image_generation: false,
        artifact: false,
        memories: false,
      });
    }),
  );

  it.effect("constructs a fresh custom-provider environment and drops ambient secrets", () =>
    Effect.sync(() => {
      const env = buildCodexTextGenerationChildEnv({
        sourceEnv: {
          PATH: "/provider-controlled/bin",
          LANG: "en_US.UTF-8",
          TZ: "Europe/Rome",
          HTTPS_PROXY: "https://proxy.test",
          SSL_CERT_FILE: "/certs/ca.pem",
          OPENAI_API_KEY: "openai-key",
          AZURE_OPENAI_API_KEY: "azure-key",
          AZURE_HEADER_KEY: "header-key",
          SENTINEL_SECRET: "must-not-pass",
          SSH_AUTH_SOCK: "/private/ssh.sock",
          SYNARA_AUTH_TOKEN: "synara-secret",
          BROWSER_WS_ENDPOINT: "ws://browser.test",
          NODE_OPTIONS: "--require=/outside/agent.js",
          AWS_ACCESS_KEY_ID: "ambient-aws-id",
          OPENSSL_CONF: "/outside/openssl.cnf",
        },
        trustedPlatformEnv: { PATH: "/safe/bin" },
        isolatedHomePath: "/isolated/home",
        isolatedTempPath: "/isolated/home/tmp",
        providerEnvKeys: ["AZURE_OPENAI_API_KEY", "AZURE_HEADER_KEY"],
        usesAwsCredentials: false,
      });

      expect(env).toMatchObject({
        PATH: "/safe/bin",
        LANG: "en_US.UTF-8",
        TZ: "Europe/Rome",
        HTTPS_PROXY: "https://proxy.test",
        SSL_CERT_FILE: "/certs/ca.pem",
        OPENAI_API_KEY: "openai-key",
        AZURE_OPENAI_API_KEY: "azure-key",
        AZURE_HEADER_KEY: "header-key",
        HOME: "/isolated/home",
        USERPROFILE: "/isolated/home",
        TMPDIR: "/isolated/home/tmp",
        CODEX_HOME: "/isolated/home",
        CODEX_SQLITE_HOME: "/isolated/home",
      });
      for (const forbidden of [
        "SENTINEL_SECRET",
        "SSH_AUTH_SOCK",
        "SYNARA_AUTH_TOKEN",
        "BROWSER_WS_ENDPOINT",
        "NODE_OPTIONS",
        "AWS_ACCESS_KEY_ID",
        "OPENSSL_CONF",
      ]) {
        expect(env).not.toHaveProperty(forbidden);
      }
    }),
  );

  it.effect("allows only direct AWS credentials when the selected provider requires AWS", () =>
    Effect.sync(() => {
      const env = buildCodexTextGenerationChildEnv({
        sourceEnv: {
          AWS_ACCESS_KEY_ID: "direct-id",
          AWS_SECRET_ACCESS_KEY: "direct-secret",
          AWS_SESSION_TOKEN: "session",
          AWS_PROFILE: "unsafe-profile",
          AWS_CONFIG_FILE: "/outside/config",
          AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://metadata.test",
        },
        trustedPlatformEnv: {},
        isolatedHomePath: "/isolated/home",
        isolatedTempPath: "/isolated/tmp",
        providerEnvKeys: [],
        usesAwsCredentials: true,
        awsRegion: "eu-west-1",
      });
      expect(env).toMatchObject({
        AWS_ACCESS_KEY_ID: "direct-id",
        AWS_SECRET_ACCESS_KEY: "direct-secret",
        AWS_SESSION_TOKEN: "session",
        AWS_REGION: "eu-west-1",
        AWS_EC2_METADATA_DISABLED: "true",
      });
      expect(env).not.toHaveProperty("AWS_PROFILE");
      expect(env).not.toHaveProperty("AWS_CONFIG_FILE");
      expect(env).not.toHaveProperty("AWS_CONTAINER_CREDENTIALS_FULL_URI");
      expect(() =>
        buildCodexTextGenerationChildEnv({
          sourceEnv: { AWS_PROFILE: "only-profile" },
          trustedPlatformEnv: {},
          isolatedHomePath: "/isolated/home",
          isolatedTempPath: "/isolated/tmp",
          providerEnvKeys: [],
          usesAwsCredentials: true,
        }),
      ).toThrowError(/direct environment credentials/);
      expect(
        buildCodexTextGenerationChildEnv({
          sourceEnv: {
            AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer",
            AWS_PROFILE: "must-not-pass",
          },
          trustedPlatformEnv: {},
          isolatedHomePath: "/isolated/home",
          isolatedTempPath: "/isolated/tmp",
          providerEnvKeys: [],
          usesAwsCredentials: true,
        }),
      ).toMatchObject({ AWS_BEARER_TOKEN_BEDROCK: "bedrock-bearer" });
    }),
  );

  it.effect("creates an independent refresh-less ChatGPT snapshot with valid access", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(sourceHome, "auth.json");
      const nowMs = 1_800_000_000_000;
      const accessToken = jwt(Math.floor(nowMs / 1_000) + 3_600, { sub: "user-1" });
      const idToken = jwt(Math.floor(nowMs / 1_000) + 3_600, {
        "https://api.openai.com/auth": { chatgpt_plan_type: "plus" },
      });
      yield* fileSystem.writeFileString(
        authPath,
        JSON.stringify({
          auth_mode: "chatgpt",
          tokens: {
            access_token: accessToken,
            id_token: idToken,
            refresh_token: "single-use-refresh",
            account_id: "workspace-1",
          },
        }),
      );

      const snapshot = prepareCodexTextGenerationAuthSnapshot(authPath, isolatedHome, {
        nowMs,
        minimumValidityMs: 300_000,
      });
      const candidate = JSON.parse(readFileSync(snapshot!.effectiveAuthFilePath, "utf8"));
      expect(snapshot?.mode).toBe("chatgpt");
      expect(candidate.auth_mode).toBe("chatgptAuthTokens");
      expect(candidate.tokens).toMatchObject({
        access_token: accessToken,
        id_token: idToken,
        refresh_token: "",
        account_id: "workspace-1",
      });
      expect(lstatSync(snapshot!.effectiveAuthFilePath).isSymbolicLink()).toBe(false);
      expect(statSync(snapshot!.effectiveAuthFilePath).ino).not.toBe(statSync(authPath).ino);
      expect(privateMode(snapshot!.effectiveAuthFilePath)).toBe(0o600);
    }),
  );

  it.effect("fails closed before snapshotting workspace or unrecognized ChatGPT plans", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(sourceHome, "auth.json");
      const nowMs = 1_800_000_000_000;
      const accessToken = jwt(Math.floor(nowMs / 1_000) + 3_600);

      for (const plan of [
        "team",
        "self_serve_business_usage_based",
        "business",
        "enterprise_cbp_usage_based",
        "enterprise",
        "hc",
        "edu",
        "education",
        "future-workspace-plan",
      ]) {
        const idToken = jwt(Math.floor(nowMs / 1_000) + 3_600, {
          "https://api.openai.com/auth": { chatgpt_plan_type: plan },
        });
        writeFileSync(
          authPath,
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              access_token: accessToken,
              id_token: idToken,
              refresh_token: "must-not-be-shared",
            },
          }),
        );
        expect(() =>
          prepareCodexTextGenerationAuthSnapshot(authPath, isolatedHome, {
            nowMs,
            minimumValidityMs: 300_000,
          }),
        ).toThrowError(/workspace accounts/);
        expect(existsSync(join(isolatedHome, "auth.json"))).toBe(false);
      }
    }),
  );

  it.effect("mirrors Codex auth-mode precedence and strips unrelated credential fields", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(sourceHome, "auth.json");

      writeFileSync(
        authPath,
        JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: "ignored-explicit-key" }),
      );
      expect(() => prepareCodexTextGenerationAuthSnapshot(authPath, isolatedHome)).toThrowError(
        /requires a refresh/,
      );

      writeFileSync(
        authPath,
        JSON.stringify({
          OPENAI_API_KEY: "selected-key",
          tokens: { access_token: "stale-token", refresh_token: "stale-refresh" },
          legacy_secret: "must-not-reach-child",
        }),
      );
      const snapshot = prepareCodexTextGenerationAuthSnapshot(authPath, isolatedHome)!;
      const candidate = JSON.parse(readFileSync(snapshot.effectiveAuthFilePath, "utf8"));
      expect(snapshot.mode).toBe("api-key");
      expect(candidate).toEqual({ auth_mode: "apikey", OPENAI_API_KEY: "selected-key" });
    }),
  );

  it.effect("fails typed before launch when ChatGPT access requires refresh", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(sourceHome, "auth.json");
      const nowMs = 1_800_000_000_000;

      for (const tokens of [
        { refresh_token: "refresh-only" },
        { access_token: "opaque-access", refresh_token: "refresh" },
        {
          access_token: jwt(Math.floor(nowMs / 1_000) + 60),
          refresh_token: "would-be-redeemed",
        },
      ]) {
        writeFileSync(authPath, JSON.stringify({ auth_mode: "chatgpt", tokens }));
        expect(() =>
          prepareCodexTextGenerationAuthSnapshot(authPath, isolatedHome, {
            nowMs,
            minimumValidityMs: 300_000,
          }),
        ).toThrowError(CodexTextGenerationAuthError);
      }
    }),
  );

  it.effect("never writes candidate changes back across atomic or in-place auth updates", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      for (const update of ["atomic", "in-place"] as const) {
        const sourceHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: `auth-${update}-source-`,
        });
        const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: `auth-${update}-target-`,
        });
        const authPath = join(sourceHome, "auth.json");
        const baseline = '{"auth_mode":"apikey","OPENAI_API_KEY":"key-a"}';
        const concurrent = '{"auth_mode":"apikey","OPENAI_API_KEY":"key-b"}';
        writeFileSync(authPath, baseline);
        const snapshot = prepareCodexTextGenerationAuthSnapshot(authPath, isolatedHome)!;

        if (update === "atomic") {
          const replacement = join(sourceHome, "auth.next.json");
          writeFileSync(replacement, concurrent);
          renameSync(replacement, authPath);
        } else {
          writeFileSync(authPath, concurrent);
        }
        writeFileSync(
          snapshot.effectiveAuthFilePath,
          '{"auth_mode":"apikey","OPENAI_API_KEY":"candidate-c"}',
        );
        expect(readFileSync(authPath, "utf8")).toBe(concurrent);
      }
    }),
  );

  it.effect("keeps API-key snapshots isolated and supports missing auth", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(sourceHome, "auth.json");
      expect(prepareCodexTextGenerationAuthSnapshot(authPath, isolatedHome)).toBeUndefined();

      writeFileSync(authPath, '{"auth_mode":"apikey","OPENAI_API_KEY":"api-key"}');
      const snapshot = prepareCodexTextGenerationAuthSnapshot(authPath, isolatedHome)!;
      expect(snapshot.mode).toBe("api-key");
      expect(readFileSync(snapshot.effectiveAuthFilePath, "utf8")).toContain("api-key");
      expect(statSync(snapshot.effectiveAuthFilePath).ino).not.toBe(statSync(authPath).ino);
    }),
  );

  it.effect("fails closed for an existing unrecognized auth format", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(sourceHome, "auth.json");
      writeFileSync(
        authPath,
        JSON.stringify({
          legacy_credentials: {
            refresh_token: "legacy-refresh",
            alternate_secret: "must-not-reach-child",
          },
        }),
      );

      expect(() => prepareCodexTextGenerationAuthSnapshot(authPath, isolatedHome)).toThrowError(
        CodexTextGenerationAuthError,
      );
      expect(existsSync(join(isolatedHome, "auth.json"))).toBe(false);
    }),
  );

  it.effect("rejects auth symlinks rather than following an ambient credential path", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const realPath = join(sourceHome, "real-auth.json");
      const linkPath = join(sourceHome, "auth.json");
      writeFileSync(realPath, '{"auth_mode":"apikey","OPENAI_API_KEY":"api-key"}');
      symlinkSync(realPath, linkPath);
      expect(() => prepareCodexTextGenerationAuthSnapshot(linkPath, isolatedHome)).toThrowError(
        /symbolic link/,
      );
    }),
  );

  it.effect("rejects FIFO auth paths without blocking on open", () => {
    if (process.platform === "win32") return Effect.void;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const sourceHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-source-" });
      const isolatedHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "auth-target-" });
      const authPath = join(sourceHome, "auth.json");
      execFileSync("mkfifo", [authPath]);

      expect(() => prepareCodexTextGenerationAuthSnapshot(authPath, isolatedHome)).toThrowError(
        /regular file/,
      );
    });
  });

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

  it.effect("removes acquired resources after failure and interruption", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cleanup-parent-" });
      let failedFile = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          failedFile = yield* acquireSecureTempFile({
            directory: parent,
            prefix: "failed-file-",
            content: "private",
          });
          return yield* Effect.fail(new Error("staged failure"));
        }),
      ).pipe(Effect.exit);
      expect(existsSync(failedFile)).toBe(false);

      let interruptedDirectory = "";
      const ready = yield* Deferred.make<void>();
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
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
      expect(existsSync(interruptedDirectory)).toBe(false);
    }),
  );
});
