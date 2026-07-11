// FILE: codexProcessEnv.test.ts
// Purpose: Covers Codex account home-overlay auth isolation guarantees.
// Layer: Server utility tests.
// Exports: Vitest coverage for apps/server/src/codexProcessEnv.ts.
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  chmodSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import OS from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, assert, describe, it } from "@effect/vitest";
import { expect, vi } from "vitest";

import {
  buildCodexAppServerArgs,
  buildCodexProcessLaunchContext,
  buildCodexProcessEnv,
  hydrateCodexProviderCredentialEnvironment,
  isCodexSharedContinuationStatePrepared,
  linkOrCopyCodexOverlayEntry,
  prepareCodexHomeOverlayFromPreparedContinuationSource,
  prioritizeCodexOverlayEntries,
  readCodexSharedContinuationGeneration,
  readCodexAuthTrackingFingerprint,
  readEffectiveCodexAuthCredentialsStoreMode,
  resolveCodexAuthTracking,
  writeCodexOverlayConfigAtomically,
} from "./codexProcessEnv.ts";
import { resolveActiveCodexHomeWritePath } from "./codexHomePaths.ts";
import { resolveCodexPathIdentity } from "./codexPathIdentity.ts";

describe("hydrateCodexProviderCredentialEnvironment", () => {
  it("hydrates only missing provider credentials without trusting shell PATH", () => {
    const readEnvironment = vi.fn(() => ({
      AZURE_OPENAI_API_KEY: "shell-key",
      PATH: "/untrusted/shell/bin",
    }));

    const hydrated = hydrateCodexProviderCredentialEnvironment({
      env: { PATH: "/trusted/bin" },
      credentialEnvNames: ["AZURE_OPENAI_API_KEY"],
      trustedEnv: { SHELL: "/bin/zsh" },
      platform: "darwin",
      readEnvironment,
    });

    expect(hydrated).toEqual({
      PATH: "/trusted/bin",
      AZURE_OPENAI_API_KEY: "shell-key",
    });
    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", ["AZURE_OPENAI_API_KEY"]);
  });

  it("keeps an inherited provider credential and skips shell probing", () => {
    const readEnvironment = vi.fn();
    const hydrated = hydrateCodexProviderCredentialEnvironment({
      env: { AZURE_OPENAI_API_KEY: "inherited-key" },
      credentialEnvNames: ["AZURE_OPENAI_API_KEY"],
      platform: "linux",
      readEnvironment,
    });

    expect(hydrated.AZURE_OPENAI_API_KEY).toBe("inherited-key");
    expect(readEnvironment).not.toHaveBeenCalled();
  });
});

describe("writeCodexOverlayConfigAtomically", () => {
  it("keeps the old complete config when publication is interrupted", () => {
    const root = mkdtempSync(path.join(OS.tmpdir(), "synara-codex-config-publish-"));
    const targetPath = path.join(root, "config.toml");
    writeFileSync(targetPath, 'model = "old"\n', "utf8");
    let temporaryPath: string | undefined;

    try {
      expect(() =>
        writeCodexOverlayConfigAtomically(targetPath, 'model = "new"\n', {
          beforeRename: (candidatePath) => {
            temporaryPath = candidatePath;
            expect(readFileSync(targetPath, "utf8")).toBe('model = "old"\n');
            expect(readFileSync(candidatePath, "utf8")).toBe('model = "new"\n');
            throw new Error("simulated publication interruption");
          },
        }),
      ).toThrow("simulated publication interruption");

      expect(readFileSync(targetPath, "utf8")).toBe('model = "old"\n');
      if (!temporaryPath) {
        throw new Error("Expected atomic publication to create a temporary config path.");
      }
      expect(existsSync(temporaryPath)).toBe(false);

      writeCodexOverlayConfigAtomically(targetPath, 'model = "new"\n');

      expect(readFileSync(targetPath, "utf8")).toBe('model = "new"\n');
      if (process.platform !== "win32") {
        expect(lstatSync(targetPath).mode & 0o777).toBe(0o600);
      }
      expect(readdirSync(root)).toEqual(["config.toml"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves both publication and cleanup errors", () => {
    const root = mkdtempSync(path.join(OS.tmpdir(), "synara-codex-config-cleanup-"));
    const targetPath = path.join(root, "config.toml");
    writeFileSync(targetPath, 'model = "old"\n', "utf8");

    try {
      let thrown: unknown;
      try {
        writeCodexOverlayConfigAtomically(targetPath, 'model = "new"\n', {
          beforeRename: () => {
            throw new Error("primary publication failure");
          },
          removeTemporaryFile: () => {
            throw new Error("temporary cleanup failure");
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors.map((error) => (error as Error).message)).toEqual([
        "primary publication failure",
        "temporary cleanup failure",
      ]);
      expect(aggregate.cause).toBe(aggregate.errors[0]);
      expect(readFileSync(targetPath, "utf8")).toBe('model = "old"\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("readEffectiveCodexAuthCredentialsStoreMode", () => {
  it("uses only the root auth store and ignores profile lookalikes", () => {
    assert.strictEqual(
      readEffectiveCodexAuthCredentialsStoreMode(
        'profile = "work"\ncli_auth_credentials_store = "file"\n\n[profiles.work]\ncli_auth_credentials_store = "auto"\n',
      ),
      "file",
    );
    assert.strictEqual(
      readEffectiveCodexAuthCredentialsStoreMode(
        '"profile" = "work"\n"cli_auth_credentials_store" = "file"\nprofiles."work"."cli_auth_credentials_store" = "keyring"\n',
      ),
      "file",
    );
    assert.strictEqual(
      readEffectiveCodexAuthCredentialsStoreMode(
        'profile = "work"\nprofiles = { work = { cli_auth_credentials_store = "auto" } }\n',
      ),
      "file",
    );
    assert.strictEqual(
      readEffectiveCodexAuthCredentialsStoreMode(
        'profile = "work"\ncli_auth_credentials_store = "keyring"\n\n[profiles.work]\ncli_auth_credentials_store = "file"\n',
      ),
      "keyring",
    );
  });

  it("defaults to file and ignores unrelated table keys", () => {
    assert.strictEqual(readEffectiveCodexAuthCredentialsStoreMode('model = "gpt-5.4"\n'), "file");
    assert.strictEqual(
      readEffectiveCodexAuthCredentialsStoreMode(
        '[model_providers.local]\ncli_auth_credentials_store = "keyring"\n',
      ),
      "file",
    );
  });
});

describe("buildCodexProcessEnv account overlays", () => {
  const tempRoots: string[] = [];

  function makeTempRoot(): string {
    const root = mkdtempSync(path.join(OS.tmpdir(), "codex-process-env-test-"));
    tempRoots.push(root);
    return root;
  }

  afterEach(() => {
    while (tempRoots.length > 0) {
      const root = tempRoots.pop();
      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  function makeAccountFixture(input: { readonly shadowAuth: "real" | "symlink" | "missing" }) {
    const root = makeTempRoot();
    const homePath = path.join(root, "codex-home");
    const shadowHomePath = path.join(root, "codex-shadow-work");
    mkdirSync(homePath, { recursive: true });
    mkdirSync(shadowHomePath, { recursive: true });
    writeFileSync(path.join(homePath, "auth.json"), '{"account":"default"}', "utf8");
    writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
    if (input.shadowAuth === "real") {
      writeFileSync(path.join(shadowHomePath, "auth.json"), '{"account":"work"}', "utf8");
    }
    if (input.shadowAuth === "symlink") {
      symlinkSync(path.join(homePath, "auth.json"), path.join(shadowHomePath, "auth.json"));
    }
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      SYNARA_HOME: path.join(root, "synara-runtime"),
    };
    return { env, homePath, shadowHomePath };
  }

  function writePreparedLegacyContinuationSource(homePath: string): void {
    mkdirSync(path.join(homePath, "sessions"), { recursive: true });
    mkdirSync(path.join(homePath, "archived_sessions"), { recursive: true });
    writeFileSync(path.join(homePath, "history.jsonl"), "", "utf8");
    writeFileSync(path.join(homePath, "session_index.jsonl"), "", "utf8");
    writeFileSync(
      path.join(homePath, "synara-shared-continuation-v1.json"),
      `${JSON.stringify({
        version: 1,
        sourceHomeIdentity: resolveCodexPathIdentity(homePath),
      })}\n`,
      "utf8",
    );
  }

  function aliasHomeThroughParent(homePath: string): string {
    const aliasRoot = makeTempRoot();
    const parentAlias = path.join(aliasRoot, "parent-alias");
    symlinkSync(path.dirname(homePath), parentAlias, "dir");
    return path.join(parentAlias, path.basename(homePath));
  }

  function makeAuthCopyOnlyLinker() {
    return {
      symlink: vi.fn((sourcePath: string, targetPath: string, type?: string | null) => {
        if (path.basename(targetPath) === "auth.json") {
          throw new Error("auth symlinks unavailable");
        }
        return symlinkSync(sourcePath, targetPath, type as "dir" | "file");
      }) as typeof symlinkSync,
      copyFile: copyFileSync,
    };
  }

  function spawnBunEval(script: string) {
    let child!: ReturnType<typeof spawn>;
    const completed = new Promise<{ readonly code: number | null; readonly stderr: string }>(
      (resolve, reject) => {
        const spawned = spawn("bun", ["-e", script], {
          cwd: import.meta.dirname,
          stdio: ["ignore", "ignore", "pipe"],
        });
        child = spawned;
        let stderr = "";
        spawned.stderr.setEncoding("utf8");
        spawned.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        spawned.once("error", reject);
        spawned.once("exit", (code) => {
          resolve({ code, stderr });
        });
      },
    );
    return { child, completed };
  }

  it("links account-private auth from the shadow home instead of the shared home", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });

    const env = buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
      platform: "win32",
    });

    const overlayHomePath = env.CODEX_HOME;
    assert.ok(overlayHomePath);
    assert.notStrictEqual(path.resolve(overlayHomePath), path.resolve(fixture.homePath));
    const overlayAuthPath = path.join(overlayHomePath, "auth.json");
    assert.ok(lstatSync(overlayAuthPath).isSymbolicLink());
    assert.strictEqual(
      path.resolve(readlinkSync(overlayAuthPath)),
      path.resolve(path.join(fixture.shadowHomePath, "auth.json")),
    );
  });

  it("shares fresh Codex continuation state across account overlays while keeping private state separate", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });
    const personalShadowHomePath = path.join(
      path.dirname(fixture.shadowHomePath),
      "codex-shadow-personal",
    );
    mkdirSync(personalShadowHomePath, { recursive: true });
    writeFileSync(path.join(personalShadowHomePath, "auth.json"), '{"account":"personal"}', "utf8");
    writeFileSync(
      path.join(personalShadowHomePath, "models_cache.json"),
      '{"model":"personal"}',
      "utf8",
    );
    writeFileSync(
      path.join(fixture.shadowHomePath, "models_cache.json"),
      '{"model":"work"}',
      "utf8",
    );

    const personalEnv = buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: personalShadowHomePath,
      accountId: "personal",
      platform: "win32",
    });
    const personalCodexHomePath = personalEnv.CODEX_HOME;
    assert.ok(personalCodexHomePath);
    assert.ok(
      isCodexSharedContinuationStatePrepared({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: personalShadowHomePath,
        accountId: "personal",
      }),
    );
    const personalSessionsPath = path.join(personalCodexHomePath, "sessions");
    const personalSqliteHomePath = personalEnv.CODEX_SQLITE_HOME;
    assert.ok(personalSqliteHomePath);
    assert.ok(lstatSync(personalSessionsPath).isSymbolicLink());
    assert.strictEqual(personalSqliteHomePath, path.resolve(fixture.homePath));
    assert.throws(() => lstatSync(path.join(personalCodexHomePath, "state_6.sqlite")));
    writeFileSync(
      path.join(personalSessionsPath, "thread-personal.jsonl"),
      "personal-thread",
      "utf8",
    );
    writeFileSync(path.join(personalSqliteHomePath, "state_6.sqlite"), "shared-state", "utf8");
    writeFileSync(path.join(personalSqliteHomePath, "state_6.sqlite-wal"), "shared-wal", "utf8");
    writeFileSync(
      path.join(personalSqliteHomePath, "thread_history_1.sqlite"),
      "shared-history",
      "utf8",
    );

    const workEnv = buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
      platform: "win32",
    });
    const workCodexHomePath = workEnv.CODEX_HOME;
    assert.ok(workCodexHomePath);
    assert.notStrictEqual(workCodexHomePath, personalCodexHomePath);
    assert.strictEqual(workEnv.CODEX_SQLITE_HOME, personalSqliteHomePath);
    const workSqliteHomePath = workEnv.CODEX_SQLITE_HOME;
    assert.ok(workSqliteHomePath);
    assert.strictEqual(
      readFileSync(path.join(workCodexHomePath, "sessions", "thread-personal.jsonl"), "utf8"),
      "personal-thread",
    );
    assert.strictEqual(
      readFileSync(path.join(workSqliteHomePath, "state_6.sqlite"), "utf8"),
      "shared-state",
    );
    assert.strictEqual(
      readFileSync(path.join(workSqliteHomePath, "state_6.sqlite-wal"), "utf8"),
      "shared-wal",
    );
    assert.strictEqual(
      readFileSync(path.join(workSqliteHomePath, "thread_history_1.sqlite"), "utf8"),
      "shared-history",
    );
    assert.throws(() => lstatSync(path.join(workCodexHomePath, "state_6.sqlite")));
    assert.strictEqual(
      path.resolve(readlinkSync(path.join(personalCodexHomePath, "models_cache.json"))),
      path.resolve(path.join(personalShadowHomePath, "models_cache.json")),
    );
    assert.strictEqual(
      path.resolve(readlinkSync(path.join(workCodexHomePath, "models_cache.json"))),
      path.resolve(path.join(fixture.shadowHomePath, "models_cache.json")),
    );
  });

  it("overrides inherited SQLite routing and accepts an explicit same-source sqlite_home", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const sourceAlias = aliasHomeThroughParent(fixture.homePath);
    writeFileSync(
      path.join(fixture.homePath, "config.toml"),
      `sqlite_home = ${JSON.stringify(sourceAlias)}\nmodel = "gpt-5.4"\n`,
      "utf8",
    );

    const env = buildCodexProcessEnv({
      env: {
        ...fixture.env,
        CODEX_SQLITE_HOME: path.join(path.dirname(fixture.homePath), "wrong-sqlite-home"),
      },
      homePath: fixture.homePath,
      platform: "win32",
    });
    assert.strictEqual(env.CODEX_SQLITE_HOME, path.resolve(fixture.homePath));
    assert.ok(env.CODEX_HOME);
    assert.match(readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8"), /sqlite_home/);
  });

  it("places enforced app-server config after the subcommand at exact CLI precedence", () => {
    const root = makeTempRoot();
    const sourceHomePath = path.join(root, 'source codex home "primary"');
    mkdirSync(sourceHomePath, { recursive: true });
    writeFileSync(path.join(sourceHomePath, "config.toml"), "", "utf8");

    const launch = buildCodexProcessLaunchContext({
      env: {
        HOME: root,
        SYNARA_HOME: path.join(root, "runtime"),
        CODEX_SQLITE_HOME: path.join(root, "inherited-wrong-sqlite-home"),
      },
      homePath: sourceHomePath,
      platform: "win32",
    });

    assert.deepEqual(launch.appServerArgs, [
      "app-server",
      "--config",
      `sqlite_home=${JSON.stringify(path.resolve(sourceHomePath))}`,
      "--config",
      'cli_auth_credentials_store="file"',
    ]);
    assert.deepEqual(launch.appServerArgs, buildCodexAppServerArgs(sourceHomePath));
    assert.strictEqual(launch.env.CODEX_SQLITE_HOME, path.resolve(sourceHomePath));
  });

  it.runIf(Boolean(process.env.CODEX_BINARY_PATH))(
    "gives enforced CLI config precedence over real Codex user and project layers",
    async () => {
      const binaryPath = process.env.CODEX_BINARY_PATH;
      assert.ok(binaryPath);
      const root = makeTempRoot();
      const userHomePath = path.join(root, "user-home");
      const sourceHomePath = path.join(root, "shared sqlite home");
      const projectPath = path.join(root, "project");
      mkdirSync(userHomePath, { recursive: true });
      mkdirSync(sourceHomePath, { recursive: true });
      mkdirSync(path.join(projectPath, ".codex"), { recursive: true });
      writeFileSync(
        path.join(userHomePath, "config.toml"),
        [
          `sqlite_home = ${JSON.stringify(path.join(root, "wrong-user-sqlite"))}`,
          'cli_auth_credentials_store = "keyring"',
          `[projects.${JSON.stringify(projectPath)}]`,
          'trust_level = "trusted"',
          "",
        ].join("\n"),
        "utf8",
      );
      writeFileSync(
        path.join(projectPath, ".codex", "config.toml"),
        [
          `sqlite_home = ${JSON.stringify(path.join(root, "wrong-project-sqlite"))}`,
          'cli_auth_credentials_store = "keyring"',
          "",
        ].join("\n"),
        "utf8",
      );

      const child = spawn(binaryPath, [...buildCodexAppServerArgs(sourceHomePath)], {
        cwd: projectPath,
        env: { ...process.env, CODEX_HOME: userHomePath },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      try {
        const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
          let settled = false;
          let buffer = "";
          const timeout = setTimeout(() => {
            settled = true;
            reject(new Error(`Timed out waiting for config/read. ${stderr}`));
          }, 10_000);
          const finish = (operation: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            operation();
          };
          child.once("error", (error) => finish(() => reject(error)));
          child.once("exit", (code) => {
            finish(() => reject(new Error(`Codex app-server exited with ${code}. ${stderr}`)));
          });
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            buffer += chunk;
            for (;;) {
              const newlineIndex = buffer.indexOf("\n");
              if (newlineIndex < 0) return;
              const line = buffer.slice(0, newlineIndex);
              buffer = buffer.slice(newlineIndex + 1);
              const message = JSON.parse(line) as { readonly id?: unknown } & Record<
                string,
                unknown
              >;
              if (message.id === 1) {
                child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
                child.stdin.write(
                  `${JSON.stringify({
                    id: 2,
                    method: "config/read",
                    params: { cwd: projectPath, includeLayers: true },
                  })}\n`,
                );
              } else if (message.id === 2) {
                finish(() => resolve(message));
              }
            }
          });
          child.stdin.write(
            `${JSON.stringify({
              id: 1,
              method: "initialize",
              params: {
                clientInfo: { name: "synara-test", version: "1" },
                capabilities: {},
              },
            })}\n`,
          );
        });
        const result = response.result as
          | {
              readonly config?: {
                readonly sqlite_home?: unknown;
                readonly cli_auth_credentials_store?: unknown;
              };
            }
          | undefined;
        assert.strictEqual(result?.config?.sqlite_home, path.resolve(sourceHomePath));
        assert.strictEqual(result?.config?.cli_auth_credentials_store, "file");
      } finally {
        child.kill();
      }
    },
  );

  it("structurally rejects every effective sqlite_home form that overrides source routing", () => {
    const configCases = [
      {
        label: "plain root",
        render: (foreignPath: string) => `sqlite_home = ${JSON.stringify(foreignPath)}\n`,
      },
      {
        label: "quoted root key",
        render: (foreignPath: string) => `"sqlite_home" = ${JSON.stringify(foreignPath)}\n`,
      },
      {
        label: "multiline string",
        render: (foreignPath: string) => `sqlite_home = """${foreignPath}"""\n`,
      },
    ] as const;

    for (const configCase of configCases) {
      const fixture = makeAccountFixture({ shadowAuth: "missing" });
      const foreignSqliteHomePath = path.join(
        path.dirname(fixture.homePath),
        `foreign-sqlite-home-${configCase.label.replaceAll(" ", "-")}`,
      );
      writeFileSync(
        path.join(fixture.homePath, "config.toml"),
        configCase.render(foreignSqliteHomePath),
        "utf8",
      );
      const overlayHomePath = resolveActiveCodexHomeWritePath({
        env: fixture.env,
        homePath: fixture.homePath,
      });

      assert.throws(
        () =>
          buildCodexProcessEnv({
            env: fixture.env,
            homePath: fixture.homePath,
            platform: "win32",
          }),
        /sqlite_home.*must resolve to the source CODEX_HOME/,
        configCase.label,
      );
      assert.strictEqual(existsSync(overlayHomePath), false, configCase.label);
    }
  });

  it("rejects root sqlite_home despite a misleading selected-profile source path", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const foreignPath = path.join(path.dirname(fixture.homePath), "foreign-root-sqlite-home");
    writeFileSync(
      path.join(fixture.homePath, "config.toml"),
      [
        'profile = "work"',
        `sqlite_home = ${JSON.stringify(foreignPath)}`,
        "",
        "[profiles.work]",
        `sqlite_home = ${JSON.stringify(fixture.homePath)}`,
        "",
      ].join("\n"),
      "utf8",
    );

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          platform: "win32",
        }),
      /sqlite_home.*must resolve to the source CODEX_HOME/,
    );
  });

  it("ignores profile sqlite_home lookalikes that Codex does not apply", () => {
    const configCases = [
      (foreignPath: string) =>
        `profile = "work"\n[profiles.work]\nsqlite_home = ${JSON.stringify(foreignPath)}\n`,
      (foreignPath: string) =>
        `profile = "work"\nprofiles."work"."sqlite_home" = ${JSON.stringify(foreignPath)}\n`,
      (foreignPath: string) =>
        `profile = "work"\nprofiles = { work = { sqlite_home = ${JSON.stringify(foreignPath)} } }\n`,
    ] as const;

    for (const [index, render] of configCases.entries()) {
      const fixture = makeAccountFixture({ shadowAuth: "missing" });
      const foreignPath = path.join(path.dirname(fixture.homePath), `ignored-profile-${index}`);
      writeFileSync(path.join(fixture.homePath, "config.toml"), render(foreignPath), "utf8");

      const env = buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        platform: "win32",
      });
      assert.strictEqual(env.CODEX_SQLITE_HOME, path.resolve(fixture.homePath));
    }
  });

  it("invalidates a prepared identity when sqlite_home later drifts away from the source", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      platform: "win32",
    });
    assert.ok(
      isCodexSharedContinuationStatePrepared({
        env: fixture.env,
        homePath: fixture.homePath,
      }),
    );

    writeFileSync(
      path.join(fixture.homePath, "config.toml"),
      `sqlite_home = ${JSON.stringify(path.join(path.dirname(fixture.homePath), "drifted"))}\n`,
      "utf8",
    );
    assert.strictEqual(
      isCodexSharedContinuationStatePrepared({
        env: fixture.env,
        homePath: fixture.homePath,
      }),
      false,
    );
  });

  it("does not treat an unselected backup config as active Codex configuration", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    writeFileSync(
      path.join(fixture.homePath, "backup.config.toml"),
      `sqlite_home = ${JSON.stringify(path.join(path.dirname(fixture.homePath), "backup-db"))}\n`,
      "utf8",
    );

    const env = buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      platform: "win32",
    });
    assert.strictEqual(env.CODEX_SQLITE_HOME, path.resolve(fixture.homePath));
  });

  it("preserves non-empty legacy-only continuation state and requires an explicit migration", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });
    const legacyOverlayHomePath = resolveActiveCodexHomeWritePath({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
    });
    mkdirSync(path.join(legacyOverlayHomePath, "sessions"), { recursive: true });
    writeFileSync(
      path.join(legacyOverlayHomePath, "sessions", "legacy.jsonl"),
      "legacy-thread",
      "utf8",
    );
    writeFileSync(path.join(legacyOverlayHomePath, "state_4.sqlite"), "legacy-state", "utf8");

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
        }),
      /refusing to migrate legacy state automatically/,
    );
    assert.strictEqual(
      readFileSync(path.join(legacyOverlayHomePath, "sessions", "legacy.jsonl"), "utf8"),
      "legacy-thread",
    );
    assert.strictEqual(
      readFileSync(path.join(legacyOverlayHomePath, "state_4.sqlite"), "utf8"),
      "legacy-state",
    );
    assert.throws(() => lstatSync(path.join(fixture.homePath, "sessions")));
    assert.throws(() => lstatSync(path.join(fixture.homePath, "state_4.sqlite")));
  });

  it("fails closed and preserves both copies when legacy continuation state conflicts", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });
    const legacyOverlayHomePath = resolveActiveCodexHomeWritePath({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
    });
    mkdirSync(path.join(fixture.homePath, "sessions"), { recursive: true });
    mkdirSync(path.join(legacyOverlayHomePath, "sessions"), { recursive: true });
    writeFileSync(path.join(fixture.homePath, "sessions", "source.jsonl"), "source", "utf8");
    writeFileSync(path.join(legacyOverlayHomePath, "sessions", "overlay.jsonl"), "overlay", "utf8");

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
        }),
      /refusing to replace either copy/,
    );
    assert.strictEqual(
      readFileSync(path.join(fixture.homePath, "sessions", "source.jsonl"), "utf8"),
      "source",
    );
    assert.strictEqual(
      readFileSync(path.join(legacyOverlayHomePath, "sessions", "overlay.jsonl"), "utf8"),
      "overlay",
    );
    assert.strictEqual(
      isCodexSharedContinuationStatePrepared({ env: fixture.env, homePath: fixture.homePath }),
      false,
    );
  });

  it("fails closed when account continuation state cannot be symlinked on the host platform", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });
    const copyOnlyLinker = {
      symlink: vi.fn(() => {
        throw new Error("symlinks unavailable");
      }),
      copyFile: copyFileSync,
    };

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
          overlayEntryLinker: copyOnlyLinker,
        }),
      /symlinks unavailable/,
    );
    assert.strictEqual(
      isCodexSharedContinuationStatePrepared({ env: fixture.env, homePath: fixture.homePath }),
      false,
    );
  });

  it("fails closed for a default-overlay partial link failure and repairs it on retry", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const overlayHomePath = resolveActiveCodexHomeWritePath({
      env: fixture.env,
      homePath: fixture.homePath,
    });
    let failedSessionsLink = false;
    const failSessionsOnce = {
      symlink: vi.fn((sourcePath: string, targetPath: string, type?: string | null) => {
        if (path.basename(targetPath) === "sessions" && !failedSessionsLink) {
          failedSessionsLink = true;
          throw new Error("injected sessions link failure");
        }
        return symlinkSync(sourcePath, targetPath, type as "dir" | "file");
      }) as typeof symlinkSync,
      copyFile: copyFileSync,
    };

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          platform: "win32",
          overlayEntryLinker: failSessionsOnce,
        }),
      /injected sessions link failure/,
    );
    assert.throws(() => lstatSync(path.join(overlayHomePath, "sessions")));
    assert.ok(lstatSync(path.join(fixture.homePath, "sessions")).isDirectory());

    const retried = buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      platform: "win32",
    });
    assert.strictEqual(retried.CODEX_HOME, overlayHomePath);
    assert.ok(lstatSync(path.join(overlayHomePath, "sessions")).isSymbolicLink());
    assert.ok(
      isCodexSharedContinuationStatePrepared({
        env: fixture.env,
        homePath: fixture.homePath,
      }),
    );
  });

  it("keeps a healthy account marker valid when another overlay fails preparation", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });
    const personalShadowHomePath = path.join(
      path.dirname(fixture.shadowHomePath),
      "codex-shadow-personal-marker",
    );
    mkdirSync(personalShadowHomePath, { recursive: true });
    writeFileSync(path.join(personalShadowHomePath, "auth.json"), "{}", "utf8");
    buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: personalShadowHomePath,
      accountId: "personal",
      platform: "win32",
    });
    const markerPath = path.join(fixture.homePath, "synara-shared-continuation-v2.json");
    const markerBeforeFailure = readFileSync(markerPath, "utf8");
    const workOverlayHomePath = resolveActiveCodexHomeWritePath({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
    });
    mkdirSync(path.join(workOverlayHomePath, "sessions"), { recursive: true });
    writeFileSync(
      path.join(workOverlayHomePath, "sessions", "independent.jsonl"),
      "independent",
      "utf8",
    );

    assert.throws(() =>
      buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath,
        accountId: "work",
        platform: "win32",
      }),
    );
    assert.strictEqual(readFileSync(markerPath, "utf8"), markerBeforeFailure);
    assert.ok(
      isCodexSharedContinuationStatePrepared({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: personalShadowHomePath,
        accountId: "personal",
      }),
    );
    assert.strictEqual(
      isCodexSharedContinuationStatePrepared({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath,
        accountId: "work",
      }),
      false,
    );
  });

  it("preserves a conflicting continuation target that appears during preparation", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const overlayHomePath = resolveActiveCodexHomeWritePath({
      env: fixture.env,
      homePath: fixture.homePath,
    });
    mkdirSync(overlayHomePath, { recursive: true });
    const sourceStatePath = path.join(fixture.homePath, "history.jsonl");
    const overlayStatePath = path.join(overlayHomePath, "history.jsonl");
    writeFileSync(sourceStatePath, "same-before-plan", "utf8");
    let mutated = false;
    const mutateAfterPlanningStarts = {
      symlink: vi.fn((sourcePath: string, targetPath: string, type?: string | null) => {
        const result = symlinkSync(sourcePath, targetPath, type as "dir" | "file");
        if (!mutated) {
          mutated = true;
          writeFileSync(overlayStatePath, "appeared-after-plan", "utf8");
        }
        return result;
      }) as typeof symlinkSync,
      copyFile: copyFileSync,
    };

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          platform: "win32",
          overlayEntryLinker: mutateAfterPlanningStarts,
        }),
      /exists as real entries in both|refusing to overwrite raced/,
    );
    assert.strictEqual(readFileSync(sourceStatePath, "utf8"), "same-before-plan");
    assert.strictEqual(readFileSync(overlayStatePath, "utf8"), "appeared-after-plan");
    assert.ok(lstatSync(overlayStatePath).isFile());
  });

  it("converges when separate processes prepare the same continuation overlay", async () => {
    const root = makeTempRoot();
    const homePath = path.join(root, "codex-home");
    const runtimePath = path.join(root, "synara-runtime");
    mkdirSync(homePath, { recursive: true });
    writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
    const env = { HOME: root, SYNARA_HOME: runtimePath };
    const overlayHomePath = resolveActiveCodexHomeWritePath({ env, homePath });
    const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "codexProcessEnv.ts")).href;
    const releasePath = path.join(root, "release");
    const preparations = [0, 1].map((index) => {
      const readyPath = path.join(root, `ready-${index}`);
      const script = `
        import { existsSync, writeFileSync } from "node:fs";
        import { buildCodexProcessEnv } from ${JSON.stringify(moduleUrl)};
        writeFileSync(${JSON.stringify(readyPath)}, "ready", "utf8");
        while (!existsSync(${JSON.stringify(releasePath)})) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        buildCodexProcessEnv(${JSON.stringify({ env, homePath, platform: "win32" })});
      `;
      return { readyPath, ...spawnBunEval(script) };
    });

    try {
      await vi.waitFor(
        () => expect(preparations.every(({ readyPath }) => existsSync(readyPath))).toBe(true),
        {
          timeout: 5_000,
        },
      );
      writeFileSync(releasePath, "release", "utf8");
      const results = await Promise.all(preparations.map(({ completed }) => completed));
      for (const result of results) {
        assert.strictEqual(result.code, 0, result.stderr);
      }
    } finally {
      writeFileSync(releasePath, "release", "utf8");
      for (const { child } of preparations) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }

    assert.ok(isCodexSharedContinuationStatePrepared({ env, homePath }));
    for (const entryName of [
      "sessions",
      "archived_sessions",
      "history.jsonl",
      "session_index.jsonl",
    ]) {
      const targetPath = path.join(overlayHomePath, entryName);
      assert.ok(lstatSync(targetPath).isSymbolicLink(), entryName);
      assert.strictEqual(
        path.resolve(path.dirname(targetPath), readlinkSync(targetPath)),
        path.resolve(homePath, entryName),
        entryName,
      );
    }
    assert.deepEqual(
      readdirSync(homePath).filter(
        (entryName) =>
          entryName.startsWith(".synara-shared-continuation-") ||
          entryName.startsWith("synara-shared-continuation-v2.json."),
      ),
      [],
    );
  });

  it("converges on one generation when separate processes migrate a legacy marker", async () => {
    const root = makeTempRoot();
    const homePath = path.join(root, "codex-home");
    const runtimePath = path.join(root, "synara-runtime");
    mkdirSync(homePath, { recursive: true });
    writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
    writePreparedLegacyContinuationSource(homePath);
    const env = { HOME: root, SYNARA_HOME: runtimePath };
    const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "codexProcessEnv.ts")).href;
    const releasePath = path.join(root, "migration-release");
    const migrations = [0, 1].map((index) => {
      const readyPath = path.join(root, `migration-ready-${index}`);
      const generationPath = path.join(root, `migration-generation-${index}`);
      const script = `
        import { existsSync, writeFileSync } from "node:fs";
        import {
          prepareCodexHomeOverlayFromPreparedContinuationSource,
          readCodexSharedContinuationGeneration,
        } from ${JSON.stringify(moduleUrl)};
        writeFileSync(${JSON.stringify(readyPath)}, "ready", "utf8");
        while (!existsSync(${JSON.stringify(releasePath)})) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
        const input = ${JSON.stringify({ env, homePath })};
        prepareCodexHomeOverlayFromPreparedContinuationSource({
          ...input,
          allowLegacySharedContinuationMigration: true,
        });
        writeFileSync(
          ${JSON.stringify(generationPath)},
          readCodexSharedContinuationGeneration(input) ?? "missing",
          "utf8",
        );
      `;
      return { readyPath, generationPath, ...spawnBunEval(script) };
    });

    try {
      await vi.waitFor(
        () => expect(migrations.every(({ readyPath }) => existsSync(readyPath))).toBe(true),
        { timeout: 5_000 },
      );
      writeFileSync(releasePath, "release", "utf8");
      const results = await Promise.all(migrations.map(({ completed }) => completed));
      for (const result of results) {
        assert.strictEqual(result.code, 0, result.stderr);
      }
    } finally {
      writeFileSync(releasePath, "release", "utf8");
      for (const { child } of migrations) {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    }

    const generations = migrations.map(({ generationPath }) =>
      readFileSync(generationPath, "utf8"),
    );
    assert.match(generations[0] ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(generations[0], generations[1]);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(homePath, "synara-shared-continuation-v2.json"), "utf8")),
      {
        version: 2,
        sourceHomeIdentity: resolveCodexPathIdentity(homePath),
        generation: generations[0],
        migratedFromVersion: 1,
      },
    );
    assert.equal(existsSync(path.join(homePath, "synara-shared-continuation-v1.json")), false);
  });

  it("fails closed on an interrupted v2 marker without rewriting source or target state", () => {
    const root = makeTempRoot();
    const homePath = path.join(root, "codex-home");
    const env = { HOME: root, SYNARA_HOME: path.join(root, "synara-runtime") };
    mkdirSync(homePath, { recursive: true });
    writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
    writePreparedLegacyContinuationSource(homePath);
    const markerPath = path.join(homePath, "synara-shared-continuation-v2.json");
    writeFileSync(markerPath, '{"version":2,"generation":', "utf8");
    const overlayHomePath = resolveActiveCodexHomeWritePath({ env, homePath });

    assert.throws(
      () =>
        prepareCodexHomeOverlayFromPreparedContinuationSource({
          env,
          homePath,
          allowLegacySharedContinuationMigration: true,
        }),
      /v2 marker.*malformed/,
    );
    assert.equal(readFileSync(markerPath, "utf8"), '{"version":2,"generation":');
    assert.equal(existsSync(overlayHomePath), false);
  });

  it("fails closed when a v2 generation marker belongs to another source home", () => {
    const root = makeTempRoot();
    const homePath = path.join(root, "codex-home");
    const env = { HOME: root, SYNARA_HOME: path.join(root, "synara-runtime") };
    mkdirSync(homePath, { recursive: true });
    writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
    writePreparedLegacyContinuationSource(homePath);
    const markerPath = path.join(homePath, "synara-shared-continuation-v2.json");
    const marker = `${JSON.stringify({
      version: 2,
      sourceHomeIdentity: resolveCodexPathIdentity(path.join(root, "different-home")),
      generation: "123e4567-e89b-42d3-a456-426614174000",
      migratedFromVersion: 1,
    })}\n`;
    writeFileSync(markerPath, marker, "utf8");
    const overlayHomePath = resolveActiveCodexHomeWritePath({ env, homePath });

    assert.throws(
      () =>
        prepareCodexHomeOverlayFromPreparedContinuationSource({
          env,
          homePath,
          allowLegacySharedContinuationMigration: true,
        }),
      /v2 marker.*belongs to another source home/,
    );
    assert.equal(readFileSync(markerPath, "utf8"), marker);
    assert.equal(existsSync(overlayHomePath), false);
  });

  it("never lets background preparation recreate a deleted persisted generation", () => {
    const root = makeTempRoot();
    const homePath = path.join(root, "codex-home");
    const env = { HOME: root, SYNARA_HOME: path.join(root, "synara-runtime") };
    mkdirSync(homePath, { recursive: true });
    writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
    buildCodexProcessEnv({ env, homePath });
    const persistedGeneration = readCodexSharedContinuationGeneration({ env, homePath });
    assert.match(persistedGeneration ?? "", /^[0-9a-f-]{36}$/);
    const overlayHomePath = resolveActiveCodexHomeWritePath({ env, homePath });

    rmSync(homePath, { recursive: true, force: true });
    rmSync(overlayHomePath, { recursive: true, force: true });
    // Health/discovery launch preparation has no persisted cursor generation.
    // If it recreates the selected path, the atomic marker must be a new source.
    buildCodexProcessEnv({ env, homePath });
    const replacementGeneration = readCodexSharedContinuationGeneration({ env, homePath });
    assert.match(replacementGeneration ?? "", /^[0-9a-f-]{36}$/);
    assert.notEqual(replacementGeneration, persistedGeneration);
    const replacementMarker = readFileSync(
      path.join(homePath, "synara-shared-continuation-v2.json"),
      "utf8",
    );

    assert.throws(
      () =>
        buildCodexProcessLaunchContext({
          env,
          homePath,
          expectedSharedContinuationGeneration: persistedGeneration!,
        }),
      /expected .*refusing to launch a persisted cursor against replacement state/,
    );
    assert.equal(
      readFileSync(path.join(homePath, "synara-shared-continuation-v2.json"), "utf8"),
      replacementMarker,
    );
  });

  it("fails closed without deleting a continuation target raced in by another process", async () => {
    const root = makeTempRoot();
    const homePath = path.join(root, "codex-home");
    const runtimePath = path.join(root, "synara-runtime");
    const env = { HOME: root, SYNARA_HOME: runtimePath };
    mkdirSync(homePath, { recursive: true });
    writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
    const overlayHomePath = resolveActiveCodexHomeWritePath({ env, homePath });
    const targetPath = path.join(overlayHomePath, "history.jsonl");
    const readyPath = path.join(root, "ready");
    const releasePath = path.join(root, "release");
    const moduleUrl = pathToFileURL(path.join(import.meta.dirname, "codexProcessEnv.ts")).href;
    const preparation = spawnBunEval(`
      import { copyFileSync, existsSync, symlinkSync, writeFileSync } from "node:fs";
      import path from "node:path";
      import { buildCodexProcessEnv } from ${JSON.stringify(moduleUrl)};
      buildCodexProcessEnv({
        ...${JSON.stringify({ env, homePath, platform: "win32" })},
        overlayEntryLinker: {
          symlink(sourcePath, targetPath, type) {
            if (path.basename(String(targetPath)) === "history.jsonl") {
              writeFileSync(${JSON.stringify(readyPath)}, "ready", "utf8");
              while (!existsSync(${JSON.stringify(releasePath)})) {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
              }
            }
            return symlinkSync(sourcePath, targetPath, type);
          },
          copyFile: copyFileSync,
        },
      });
    `);

    try {
      await vi.waitFor(() => expect(existsSync(readyPath)).toBe(true), {
        timeout: 5_000,
      });
      writeFileSync(targetPath, "independent-writer", "utf8");
      writeFileSync(releasePath, "release", "utf8");
      const result = await preparation.completed;
      assert.notStrictEqual(result.code, 0);
      assert.match(result.stderr, /refusing to overwrite raced or independently owned state/);
    } finally {
      writeFileSync(releasePath, "release", "utf8");
      if (preparation.child.exitCode === null) preparation.child.kill("SIGKILL");
    }

    assert.strictEqual(readFileSync(targetPath, "utf8"), "independent-writer");
    assert.ok(lstatSync(targetPath).isFile());
    assert.strictEqual(existsSync(path.join(homePath, "synara-shared-continuation-v2.json")), true);
  });

  it.runIf(process.platform !== "win32")(
    "preserves different unreadable continuation files",
    () => {
      const fixture = makeAccountFixture({ shadowAuth: "missing" });
      const overlayHomePath = resolveActiveCodexHomeWritePath({
        env: fixture.env,
        homePath: fixture.homePath,
      });
      mkdirSync(overlayHomePath, { recursive: true });
      const sourceStatePath = path.join(fixture.homePath, "history.jsonl");
      const overlayStatePath = path.join(overlayHomePath, "history.jsonl");
      writeFileSync(sourceStatePath, "source-secret", "utf8");
      writeFileSync(overlayStatePath, "overlay-secret", "utf8");
      chmodSync(sourceStatePath, 0o000);
      chmodSync(overlayStatePath, 0o000);

      try {
        assert.throws(() =>
          buildCodexProcessEnv({
            env: fixture.env,
            homePath: fixture.homePath,
            platform: "win32",
          }),
        );
      } finally {
        chmodSync(sourceStatePath, 0o600);
        chmodSync(overlayStatePath, 0o600);
      }
      assert.strictEqual(readFileSync(sourceStatePath, "utf8"), "source-secret");
      assert.strictEqual(readFileSync(overlayStatePath, "utf8"), "overlay-secret");
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves unreadable continuation directories instead of treating them as empty",
    () => {
      const fixture = makeAccountFixture({ shadowAuth: "missing" });
      const overlayHomePath = resolveActiveCodexHomeWritePath({
        env: fixture.env,
        homePath: fixture.homePath,
      });
      const sourceSessionsPath = path.join(fixture.homePath, "sessions");
      const overlaySessionsPath = path.join(overlayHomePath, "sessions");
      mkdirSync(sourceSessionsPath, { recursive: true });
      mkdirSync(overlaySessionsPath, { recursive: true });
      writeFileSync(path.join(sourceSessionsPath, "source.jsonl"), "source", "utf8");
      writeFileSync(path.join(overlaySessionsPath, "overlay.jsonl"), "overlay", "utf8");
      chmodSync(sourceSessionsPath, 0o000);
      chmodSync(overlaySessionsPath, 0o000);

      try {
        assert.throws(() =>
          buildCodexProcessEnv({
            env: fixture.env,
            homePath: fixture.homePath,
            platform: "win32",
          }),
        );
      } finally {
        chmodSync(sourceSessionsPath, 0o700);
        chmodSync(overlaySessionsPath, 0o700);
      }
      assert.strictEqual(
        readFileSync(path.join(sourceSessionsPath, "source.jsonl"), "utf8"),
        "source",
      );
      assert.strictEqual(
        readFileSync(path.join(overlaySessionsPath, "overlay.jsonl"), "utf8"),
        "overlay",
      );
    },
  );

  it("rejects continuation links that alias another storage root", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });
    const legacyOverlayHomePath = resolveActiveCodexHomeWritePath({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
    });
    const foreignSessionsPath = path.join(makeTempRoot(), "foreign-sessions");
    mkdirSync(legacyOverlayHomePath, { recursive: true });
    mkdirSync(foreignSessionsPath, { recursive: true });
    symlinkSync(foreignSessionsPath, path.join(legacyOverlayHomePath, "sessions"), "dir");

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
        }),
      /points outside the shared source home/,
    );
  });

  it("rejects keyring auth before creating an account overlay or linking stale auth", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    writeFileSync(
      path.join(fixture.homePath, "config.toml"),
      'cli_auth_credentials_store = "keyring"\n',
      "utf8",
    );

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          accountId: "work",
          platform: "win32",
        }),
      /require file-backed Codex auth/,
    );
    assert.throws(() => lstatSync(path.join(fixture.env.SYNARA_HOME!, "codex-home-overlay")));
  });

  it("rejects root keyring auth despite a misleading selected-profile file mode", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    writeFileSync(
      path.join(fixture.homePath, "config.toml"),
      'profile = "work"\ncli_auth_credentials_store = "keyring"\n\n[profiles.work]\ncli_auth_credentials_store = "file"\n',
      "utf8",
    );

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: { ...fixture.env, CODEX_HOME: fixture.homePath },
          platform: "win32",
        }),
      /require file-backed Codex auth/,
    );
    assert.throws(() => lstatSync(path.join(fixture.env.SYNARA_HOME!, "codex-home-overlay")));
  });

  it("ignores a profile-only auto auth lookalike", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    writeFileSync(
      path.join(fixture.homePath, "config.toml"),
      'profile = "work"\n\n[profiles.work]\ncli_auth_credentials_store = "auto"\n',
      "utf8",
    );

    const env = buildCodexProcessEnv({
      env: { ...fixture.env, CODEX_HOME: fixture.homePath },
      platform: "win32",
    });
    assert.ok(env.CODEX_HOME);
    assert.ok(existsSync(path.join(fixture.env.SYNARA_HOME!, "codex-home-overlay")));
  });

  it("rejects root auto auth despite a misleading selected-profile file mode", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });
    writeFileSync(
      path.join(fixture.homePath, "config.toml"),
      'profile = "work"\ncli_auth_credentials_store = "auto"\n\n[profiles.work]\ncli_auth_credentials_store = "file"\n',
      "utf8",
    );

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
        }),
      /cli_auth_credentials_store = "auto"/,
    );
    assert.throws(() => lstatSync(path.join(fixture.env.SYNARA_HOME!, "codex-home-overlay")));
  });

  it("fails when shadow-home auth cannot be linked into the account overlay", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });
    const firstEnv = buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
      platform: "win32",
    });
    const overlayHomePath = firstEnv.CODEX_HOME;
    assert.ok(overlayHomePath);
    unlinkSync(path.join(overlayHomePath, "auth.json"));
    chmodSync(overlayHomePath, 0o500);
    try {
      assert.throws(
        () =>
          buildCodexProcessEnv({
            env: fixture.env,
            homePath: fixture.homePath,
            shadowHomePath: fixture.shadowHomePath,
            accountId: "work",
            platform: "win32",
          }),
        /EACCES|EPERM/,
      );
    } finally {
      chmodSync(overlayHomePath, 0o700);
    }
  });

  it("tolerates shadow homes with no auth state yet", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });

    const env = buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
      platform: "win32",
    });

    assert.ok(env.CODEX_HOME);
  });

  it("rejects shadow-home auth state that is itself a symlink", () => {
    const fixture = makeAccountFixture({ shadowAuth: "symlink" });

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
        }),
      /is a symlink/,
    );
  });

  it("rejects a shadow home directory that is itself a symlink", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const aliasedShadowHome = path.join(path.dirname(fixture.shadowHomePath), "codex-shadow-alias");
    symlinkSync(fixture.homePath, aliasedShadowHome);

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: aliasedShadowHome,
          accountId: "work",
          platform: "win32",
        }),
      /shadow home/i,
    );
  });

  it("keeps shared auth out of account overlays without a shadow home", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };

    const env = buildCodexProcessEnv({
      env: sharedEnv,
      accountId: "work",
      platform: "win32",
    });

    const overlayHomePath = env.CODEX_HOME;
    assert.ok(overlayHomePath);
    assert.notStrictEqual(path.resolve(overlayHomePath), path.resolve(fixture.homePath));
    assert.throws(() => lstatSync(path.join(overlayHomePath, "auth.json")));
  });

  it("treats an explicit ambient Codex home as shared in overlay mode", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };

    const env = buildCodexProcessEnv({
      env: sharedEnv,
      homePath: fixture.homePath,
      accountId: "work",
      platform: "win32",
    });

    const overlayHomePath = env.CODEX_HOME;
    assert.ok(overlayHomePath);
    assert.notStrictEqual(path.resolve(overlayHomePath), path.resolve(fixture.homePath));
    assert.throws(() => lstatSync(path.join(overlayHomePath, "auth.json")));
  });

  it("treats a parent-symlink alias of the ambient home as shared in overlay mode", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };
    const aliasedHomePath = aliasHomeThroughParent(fixture.homePath);

    const env = buildCodexProcessEnv({
      env: sharedEnv,
      homePath: aliasedHomePath,
      accountId: "work",
      platform: "win32",
    });

    const overlayHomePath = env.CODEX_HOME;
    assert.ok(overlayHomePath);
    assert.notStrictEqual(path.resolve(overlayHomePath), path.resolve(aliasedHomePath));
    assert.throws(() => lstatSync(path.join(overlayHomePath, "auth.json")));
  });

  it("keeps account-id-only instances isolated in account overlays", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const pluginEnabledEnv = {
      ...fixture.env,
      CODEX_HOME: fixture.homePath,
    };
    writeFileSync(path.join(fixture.homePath, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const env = buildCodexProcessEnv({
      env: pluginEnabledEnv,
      accountId: "work",
      platform: "win32",
    });

    const accountHomePath = env.CODEX_HOME;
    assert.ok(accountHomePath);
    assert.notStrictEqual(path.resolve(accountHomePath), path.resolve(fixture.homePath));
    assert.ok(lstatSync(accountHomePath).isDirectory());
    // The account overlay keeps the model/provider settings while enforcing
    // Synara's file-backed auth boundary.
    assert.match(
      readFileSync(path.join(accountHomePath, "config.toml"), "utf8"),
      /model = "gpt-5\.4"/,
    );
    // The default account uses its own non-account overlay.
    const defaultEnv = buildCodexProcessEnv({ env: pluginEnabledEnv, platform: "win32" });
    assert.ok(defaultEnv.CODEX_HOME);
    assert.notStrictEqual(defaultEnv.CODEX_HOME, fixture.homePath);
    assert.notStrictEqual(defaultEnv.CODEX_HOME, accountHomePath);
  });

  it("keeps explicit shared-home accounts isolated in account overlays", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const pluginEnabledEnv = {
      ...fixture.env,
      CODEX_HOME: fixture.homePath,
    };
    writeFileSync(path.join(fixture.homePath, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const env = buildCodexProcessEnv({
      env: pluginEnabledEnv,
      homePath: fixture.homePath,
      accountId: "work",
      platform: "win32",
    });

    const accountHomePath = env.CODEX_HOME;
    assert.ok(accountHomePath);
    assert.notStrictEqual(path.resolve(accountHomePath), path.resolve(fixture.homePath));
    assert.ok(lstatSync(accountHomePath).isDirectory());
    assert.throws(() => lstatSync(path.join(accountHomePath, "auth.json")));
    assert.match(
      readFileSync(path.join(accountHomePath, "config.toml"), "utf8"),
      /model = "gpt-5\.4"/,
    );
  });

  it("keeps parent-symlink aliases of the shared home isolated", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const aliasedHomePath = aliasHomeThroughParent(fixture.homePath);
    const pluginEnabledEnv = {
      ...fixture.env,
      CODEX_HOME: fixture.homePath,
    };

    const env = buildCodexProcessEnv({
      env: pluginEnabledEnv,
      homePath: aliasedHomePath,
      accountId: "work",
      platform: "win32",
    });

    const accountHomePath = env.CODEX_HOME;
    assert.ok(accountHomePath);
    assert.notStrictEqual(path.resolve(accountHomePath), path.resolve(aliasedHomePath));
    assert.throws(() => lstatSync(path.join(accountHomePath, "auth.json")));
  });

  it("links dedicated account auth into an account-scoped overlay", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const dedicatedHomePath = path.join(makeTempRoot(), "codex-work-home");
    mkdirSync(dedicatedHomePath, { recursive: true });
    writeFileSync(path.join(dedicatedHomePath, "auth.json"), '{"account":"work"}', "utf8");

    const env = buildCodexProcessEnv({
      env: {
        ...fixture.env,
        CODEX_HOME: fixture.homePath,
      },
      homePath: dedicatedHomePath,
      accountId: "work",
      platform: "win32",
    });

    assert.ok(env.CODEX_HOME);
    assert.notStrictEqual(env.CODEX_HOME, dedicatedHomePath);
    assert.ok(lstatSync(path.join(env.CODEX_HOME, "auth.json")).isSymbolicLink());
    assert.strictEqual(
      path.resolve(readlinkSync(path.join(env.CODEX_HOME, "auth.json"))),
      path.resolve(path.join(dedicatedHomePath, "auth.json")),
    );
    assert.strictEqual(
      readFileSync(path.join(dedicatedHomePath, "auth.json"), "utf8"),
      '{"account":"work"}',
    );
  });

  it("rejects a symlinked shadow home", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const aliasedShadowHome = path.join(path.dirname(fixture.shadowHomePath), "codex-shadow-alias");
    symlinkSync(fixture.homePath, aliasedShadowHome);

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: {
            ...fixture.env,
            CODEX_HOME: fixture.homePath,
          },
          shadowHomePath: aliasedShadowHome,
          accountId: "work",
          platform: "win32",
        }),
      /shadow home/i,
    );
  });

  it("rejects symlinked shadow auth state", () => {
    const fixture = makeAccountFixture({ shadowAuth: "symlink" });

    assert.throws(
      () =>
        buildCodexProcessEnv({
          env: {
            ...fixture.env,
            CODEX_HOME: fixture.homePath,
          },
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
        }),
      /is a symlink/,
    );
  });

  it("links shadow auth into an account overlay while preserving source config", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });
    writeFileSync(path.join(fixture.homePath, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    const env = buildCodexProcessEnv({
      env: {
        ...fixture.env,
        CODEX_HOME: fixture.homePath,
      },
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
      platform: "win32",
    });

    assert.ok(env.CODEX_HOME);
    assert.notStrictEqual(env.CODEX_HOME, fixture.shadowHomePath);
    assert.match(
      readFileSync(path.join(env.CODEX_HOME, "config.toml"), "utf8"),
      /model = "gpt-5\.4"/,
    );
    assert.strictEqual(
      path.resolve(readlinkSync(path.join(env.CODEX_HOME, "auth.json"))),
      path.resolve(path.join(fixture.shadowHomePath, "auth.json")),
    );
    // The shadow home's own auth stays untouched.
    assert.strictEqual(
      readFileSync(path.join(fixture.shadowHomePath, "auth.json"), "utf8"),
      '{"account":"work"}',
    );
  });

  it("drops stale shared-auth symlinks when reusing the account home", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const pluginEnabledEnv = {
      ...fixture.env,
      CODEX_HOME: fixture.homePath,
    };

    // Simulate an account home a previous overlay-mode build left behind:
    // auth.json symlinked to the shared home and a plugin-disabled config.
    const overlayEnv = buildCodexProcessEnv({
      env: { ...fixture.env, CODEX_HOME: fixture.homePath },
      accountId: "work",
      platform: "win32",
    });
    const accountHomePath = overlayEnv.CODEX_HOME;
    assert.ok(accountHomePath);
    symlinkSync(path.join(fixture.homePath, "auth.json"), path.join(accountHomePath, "auth.json"));

    const env = buildCodexProcessEnv({
      env: pluginEnabledEnv,
      accountId: "work",
      platform: "win32",
    });

    assert.strictEqual(env.CODEX_HOME, accountHomePath);
    // The stale alias to the default account's auth must be gone.
    assert.throws(() => lstatSync(path.join(accountHomePath, "auth.json")));
  });

  it("mirrors private auth from an account's own dedicated home", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });

    const env = buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      accountId: "work",
      platform: "win32",
    });

    const overlayHomePath = env.CODEX_HOME;
    assert.ok(overlayHomePath);
    const overlayAuthPath = path.join(overlayHomePath, "auth.json");
    assert.ok(lstatSync(overlayAuthPath).isSymbolicLink());
    assert.strictEqual(
      path.resolve(readlinkSync(overlayAuthPath)),
      path.resolve(path.join(fixture.homePath, "auth.json")),
    );
  });

  it("tracks each overlay's authoritative auth source plus its effective fallback", () => {
    const fixture = makeAccountFixture({ shadowAuth: "real" });
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };
    const defaultTracking = resolveCodexAuthTracking({ env: sharedEnv });
    const defaultFingerprintBeforeMaterialization =
      readCodexAuthTrackingFingerprint(defaultTracking);
    assert.strictEqual(
      defaultTracking.authoritativeAuthFilePath,
      path.join(fixture.homePath, "auth.json"),
    );
    assert.match(defaultTracking.effectiveAuthFilePath ?? "", /codex-home-overlay/);
    buildCodexProcessEnv({ env: sharedEnv, platform: "win32" });
    assert.strictEqual(
      readCodexAuthTrackingFingerprint(defaultTracking),
      defaultFingerprintBeforeMaterialization,
    );

    const dedicatedHomePath = path.join(makeTempRoot(), "codex-dedicated");
    mkdirSync(dedicatedHomePath, { recursive: true });
    writeFileSync(path.join(dedicatedHomePath, "config.toml"), "", "utf8");
    const dedicatedTracking = resolveCodexAuthTracking({
      env: sharedEnv,
      homePath: dedicatedHomePath,
      accountId: "work",
    });
    assert.strictEqual(
      dedicatedTracking.authoritativeAuthFilePath,
      path.join(dedicatedHomePath, "auth.json"),
    );
    assert.match(dedicatedTracking.effectiveAuthFilePath ?? "", /codex-home-overlay/);

    const shadowTracking = resolveCodexAuthTracking({
      env: sharedEnv,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
    });
    assert.strictEqual(
      shadowTracking.authoritativeAuthFilePath,
      path.join(fixture.shadowHomePath, "auth.json"),
    );
    assert.match(shadowTracking.effectiveAuthFilePath ?? "", /codex-home-overlay/);

    const sharedAccountTracking = resolveCodexAuthTracking({
      env: sharedEnv,
      accountId: "work",
    });
    assert.match(sharedAccountTracking.authoritativeAuthFilePath, /codex-home-overlay/);
    assert.strictEqual(sharedAccountTracking.effectiveAuthFilePath, undefined);
  });

  it("keeps auth identity stable when a fallback copy rotates for the same account", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };
    const sourceAuthPath = path.join(fixture.homePath, "auth.json");
    const auth = (accountId: string, token: string) =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: accountId,
          access_token: `access-${token}`,
          refresh_token: `refresh-${token}`,
        },
      });
    writeFileSync(sourceAuthPath, auth("workspace-1", "source"), "utf8");
    const copyOnlyLinker = makeAuthCopyOnlyLinker();
    const launch = buildCodexProcessLaunchContext({
      env: sharedEnv,
      platform: "win32",
      overlayEntryLinker: copyOnlyLinker,
    });
    const effectiveAuthFilePath = launch.authTracking.effectiveAuthFilePath;
    assert.ok(effectiveAuthFilePath);
    const initialFingerprint = readCodexAuthTrackingFingerprint(launch.authTracking);

    writeFileSync(effectiveAuthFilePath, auth("workspace-1", "rotated"), "utf8");
    assert.strictEqual(readCodexAuthTrackingFingerprint(launch.authTracking), initialFingerprint);

    writeFileSync(effectiveAuthFilePath, auth("workspace-2", "swapped"), "utf8");
    assert.notStrictEqual(
      readCodexAuthTrackingFingerprint(launch.authTracking),
      initialFingerprint,
    );
  });

  it("rejects a forced-copy launch when authoritative auth changes after the copy", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };
    const sourceAuthPath = path.join(fixture.homePath, "auth.json");
    const auth = (accountId: string, token: string) =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: accountId,
          access_token: `access-${token}`,
          refresh_token: `refresh-${token}`,
        },
      });
    const firstAuth = auth("workspace-first", "1");
    const secondAuth = auth("workspace-second", "2");
    writeFileSync(sourceAuthPath, firstAuth, "utf8");
    const overlayHomePath = resolveActiveCodexHomeWritePath({ env: sharedEnv });
    const overlayAuthPath = path.join(overlayHomePath, "auth.json");
    const raceAfterAuthCopy = {
      symlink: vi.fn((sourcePath: string, targetPath: string, type?: string | null) => {
        if (path.basename(targetPath) === "auth.json") {
          throw new Error("auth symlinks unavailable");
        }
        return symlinkSync(sourcePath, targetPath, type as "dir" | "file");
      }) as typeof symlinkSync,
      copyFile: vi.fn((sourcePath: string, targetPath: string) => {
        copyFileSync(sourcePath, targetPath);
        if (path.basename(targetPath) === "auth.json") {
          writeFileSync(sourcePath, secondAuth, "utf8");
        }
      }) as typeof copyFileSync,
    };

    assert.throws(
      () =>
        buildCodexProcessLaunchContext({
          env: sharedEnv,
          platform: "win32",
          overlayEntryLinker: raceAfterAuthCopy,
        }),
      /authentication changed during app-server launch preparation/,
    );
    assert.strictEqual(readFileSync(overlayAuthPath, "utf8"), firstAuth);
    assert.strictEqual(readFileSync(sourceAuthPath, "utf8"), secondAuth);
  });

  it("rejects an A-to-B-to-A race that leaves fallback auth on the wrong account", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };
    const sourceAuthPath = path.join(fixture.homePath, "auth.json");
    const auth = (accountId: string, token: string) =>
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          account_id: accountId,
          access_token: `access-${token}`,
          refresh_token: `refresh-${token}`,
        },
      });
    const firstAuth = auth("workspace-first", "1");
    const secondAuth = auth("workspace-second", "2");
    writeFileSync(sourceAuthPath, firstAuth, "utf8");
    const tracking = resolveCodexAuthTracking({ env: sharedEnv });
    const fingerprintBeforePreparation = readCodexAuthTrackingFingerprint(tracking);
    const overlayHomePath = resolveActiveCodexHomeWritePath({ env: sharedEnv });
    const overlayAuthPath = path.join(overlayHomePath, "auth.json");
    const copyWhileAuthoritativeTemporarilyChanges = {
      symlink: vi.fn((sourcePath: string, targetPath: string, type?: string | null) => {
        if (path.basename(targetPath) === "auth.json") {
          throw new Error("auth symlinks unavailable");
        }
        return symlinkSync(sourcePath, targetPath, type as "dir" | "file");
      }) as typeof symlinkSync,
      copyFile: vi.fn((sourcePath: string, targetPath: string) => {
        if (path.basename(targetPath) !== "auth.json") {
          copyFileSync(sourcePath, targetPath);
          return;
        }
        writeFileSync(sourcePath, secondAuth, "utf8");
        copyFileSync(sourcePath, targetPath);
        writeFileSync(sourcePath, firstAuth, "utf8");
      }) as typeof copyFileSync,
    };

    assert.throws(
      () =>
        buildCodexProcessLaunchContext({
          env: sharedEnv,
          platform: "win32",
          overlayEntryLinker: copyWhileAuthoritativeTemporarilyChanges,
        }),
      /authentication did not match the authoritative account; refusing to launch/,
    );
    assert.strictEqual(readFileSync(sourceAuthPath, "utf8"), firstAuth);
    assert.strictEqual(readFileSync(overlayAuthPath, "utf8"), secondAuth);
    assert.notStrictEqual(readCodexAuthTrackingFingerprint(tracking), fingerprintBeforePreparation);
  });

  it("removes an unchanged fallback copy when the authoritative account logs out", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };
    const copyOnlyLinker = makeAuthCopyOnlyLinker();
    const firstEnv = buildCodexProcessEnv({
      env: sharedEnv,
      platform: "win32",
      overlayEntryLinker: copyOnlyLinker,
    });
    const overlayHomePath = firstEnv.CODEX_HOME;
    assert.ok(overlayHomePath);
    const overlayAuthPath = path.join(overlayHomePath, "auth.json");
    assert.ok(lstatSync(overlayAuthPath).isFile());

    unlinkSync(path.join(fixture.homePath, "auth.json"));
    buildCodexProcessEnv({
      env: sharedEnv,
      platform: "win32",
      overlayEntryLinker: copyOnlyLinker,
    });

    assert.throws(() => lstatSync(overlayAuthPath));
  });

  it("preserves overlay auth that changed after a fallback copy was created", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };
    const copyOnlyLinker = makeAuthCopyOnlyLinker();
    const firstEnv = buildCodexProcessEnv({
      env: sharedEnv,
      platform: "win32",
      overlayEntryLinker: copyOnlyLinker,
    });
    const overlayHomePath = firstEnv.CODEX_HOME;
    assert.ok(overlayHomePath);
    const overlayAuthPath = path.join(overlayHomePath, "auth.json");
    writeFileSync(overlayAuthPath, '{"account":"independent"}', "utf8");
    unlinkSync(path.join(fixture.homePath, "auth.json"));

    buildCodexProcessEnv({
      env: sharedEnv,
      platform: "win32",
      overlayEntryLinker: copyOnlyLinker,
    });

    assert.strictEqual(readFileSync(overlayAuthPath, "utf8"), '{"account":"independent"}');
  });

  it("drops legacy shared-auth aliases from account overlays and keeps own logins", () => {
    const fixture = makeAccountFixture({ shadowAuth: "missing" });
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };

    const firstEnv = buildCodexProcessEnv({
      env: sharedEnv,
      accountId: "work",
      platform: "win32",
    });
    const overlayHomePath = firstEnv.CODEX_HOME;
    assert.ok(overlayHomePath);
    // Simulate the legacy overlay state that symlinked shared auth in.
    symlinkSync(path.join(fixture.homePath, "auth.json"), path.join(overlayHomePath, "auth.json"));

    const secondEnv = buildCodexProcessEnv({
      env: sharedEnv,
      accountId: "work",
      platform: "win32",
    });
    assert.strictEqual(secondEnv.CODEX_HOME, overlayHomePath);
    assert.throws(() => lstatSync(path.join(overlayHomePath, "auth.json")));

    // The account's own login is a real file and must survive re-preparation.
    writeFileSync(path.join(overlayHomePath, "auth.json"), '{"account":"work"}', "utf8");
    unlinkSync(path.join(fixture.homePath, "auth.json"));
    const thirdEnv = buildCodexProcessEnv({
      env: sharedEnv,
      accountId: "work",
      platform: "win32",
    });
    assert.strictEqual(thirdEnv.CODEX_HOME, overlayHomePath);
    assert.ok(lstatSync(path.join(overlayHomePath, "auth.json")).isFile());
  });
});

describe("linkOrCopyCodexOverlayEntry", () => {
  it("copies auth.json when symlink creation is unavailable", () => {
    const symlink = vi.fn(() => {
      throw new Error("symlinks unavailable");
    });
    const copyFile = vi.fn();

    linkOrCopyCodexOverlayEntry(
      {
        entryName: "auth.json",
        sourcePath: "C:\\Users\\test\\.codex\\auth.json",
        targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
        type: "file",
      },
      { symlink, copyFile },
    );

    expect(symlink).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
      "file",
    );
    expect(copyFile).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
    );
  });

  it("keeps symlink failures visible for other overlay entries", () => {
    const symlink = vi.fn(() => {
      throw new Error("symlinks unavailable");
    });

    expect(() =>
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "sessions",
          sourcePath: "C:\\Users\\test\\.codex\\sessions",
          targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\sessions",
          type: "dir",
        },
        { symlink, copyFile: vi.fn() },
      ),
    ).toThrow("symlinks unavailable");
  });
});

describe("prioritizeCodexOverlayEntries", () => {
  it("prepares auth.json before entries whose symlinks may fail first", () => {
    expect(prioritizeCodexOverlayEntries(["sessions", "auth.json", "config.toml"])).toEqual([
      "auth.json",
      "sessions",
      "config.toml",
    ]);
  });
});
