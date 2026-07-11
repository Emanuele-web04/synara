import { homedir } from "node:os";
import path from "node:path";

import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ProviderInstanceId,
  type ProviderStartOptions,
  ThreadId,
} from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";

import { claudeIsolatedHomePath } from "../provider/claudeEnvironment";
import {
  claudeHistoricalSessionChildEnvironment,
  claudeHistoricalSessionEnvironment,
  makeImportThreadHandler,
  resolveImportedThreadProviderOptionsForSettings,
} from "./importThreadRoute";

describe("claudeHistoricalSessionEnvironment", () => {
  it("expands instance Claude homes the same way session launches do", () => {
    const environment = claudeHistoricalSessionEnvironment({
      claudeAgent: {
        homePath: "~/claude-work",
        environment: { SYNARA_CLAUDE_IMPORT_TEST: "1" },
      },
    } satisfies ProviderStartOptions);

    expect(environment?.HOME).toBe(path.join(homedir(), "claude-work"));
    expect(environment?.SYNARA_CLAUDE_IMPORT_TEST).toBe("1");
  });

  it("expands instance Claude homes against the configured Synara home", () => {
    const environment = claudeHistoricalSessionEnvironment(
      {
        claudeAgent: {
          homePath: "~/claude-work",
          environment: { SYNARA_CLAUDE_IMPORT_TEST: "1" },
        },
      } satisfies ProviderStartOptions,
      { homeDir: "/synara/home" },
    );

    expect(environment?.HOME).toBe(path.join("/synara/home", "claude-work"));
    expect(environment?.SYNARA_CLAUDE_IMPORT_TEST).toBe("1");
  });

  it("scopes default Claude imports to the configured Synara home", () => {
    const environment = claudeHistoricalSessionEnvironment(undefined, {
      homeDir: "/synara/home",
    });

    expect(environment?.HOME).toBe("/synara/home");
  });

  it("scopes environment-only Claude imports to the selected provider instance", () => {
    const isolationRootDir = "/synara/userdata";
    const providerInstanceId = "claude_work" as ProviderInstanceId;
    const environment = claudeHistoricalSessionEnvironment(
      {
        claudeAgent: {
          environment: { ANTHROPIC_AUTH_TOKEN: "work-token" },
        },
      } satisfies ProviderStartOptions,
      {
        homeDir: "/synara/home",
        isolationRootDir,
        providerInstanceId,
      },
    );

    expect(environment?.HOME).toBe(
      claudeIsolatedHomePath({ isolationRootDir, providerInstanceId }),
    );
    expect(environment?.ANTHROPIC_AUTH_TOKEN).toBe("work-token");
  });

  it("passes the sanitized historical environment to child queries without remerging process env", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "ambient-key";
    try {
      const environment = claudeHistoricalSessionChildEnvironment({
        HOME: "/tmp/synara-claude-import",
      });

      expect(environment).toEqual({ HOME: "/tmp/synara-claude-import" });
      expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = original;
      }
    }
  });
});

describe("resolveImportedThreadProviderOptionsForSettings", () => {
  it("rejects disabled provider instances before import preflight can materialize options", () => {
    expect(() =>
      resolveImportedThreadProviderOptionsForSettings(
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            opencode_disabled: {
              driver: "opencode",
              enabled: false,
              config: {
                serverUrl: "http://127.0.0.1:4096",
                serverPassword: "must-not-be-used",
              },
            },
          },
        },
        { instanceId: "opencode_disabled", model: "opencode/model" },
      ),
    ).toThrow(/disabled for thread import/);
  });
});

describe("makeImportThreadHandler", () => {
  it.each(["opencode", "kilo"] as const)(
    "passes the resolved %s instance into external-thread preflight",
    async (driver) => {
      const threadId = ThreadId.makeUnsafe(`thread-import-${driver}`);
      const projectId = ProjectId.makeUnsafe(`project-import-${driver}`);
      const instanceId = `${driver}_work` as ProviderInstanceId;
      const workspaceRoot = `/repo/${driver}`;
      const externalReadInputs: Array<Record<string, unknown>> = [];
      const now = new Date().toISOString();
      const adapter = {
        readExternalThread: (input: Record<string, unknown>) => {
          externalReadInputs.push(input);
          return Effect.succeed({
            threadId,
            turns: [],
            cwd: workspaceRoot,
          });
        },
        readThread: () => Effect.succeed({ threadId, turns: [], cwd: workspaceRoot }),
      };
      const handler = makeImportThreadHandler({
        fileSystem: {} as never,
        orchestrationEngine: {
          dispatch: () => Effect.void,
        } as never,
        path: path as never,
        platform: process.platform,
        projectionSnapshotQuery: {
          getThreadDetailById: () =>
            Effect.succeed(
              Option.some({
                id: threadId,
                projectId,
                title: "Imported thread",
                modelSelection: { instanceId, model: `${driver}/test-model` },
                runtimeMode: "full-access",
                interactionMode: "default",
                envMode: "local",
                branch: null,
                worktreePath: null,
                associatedWorktreePath: null,
                associatedWorktreeBranch: null,
                associatedWorktreeRef: null,
                session: null,
              } as never),
            ),
          getProjectShellById: () =>
            Effect.succeed(
              Option.some({
                id: projectId,
                kind: "git",
                workspaceRoot,
              } as never),
            ),
        } as never,
        providerAdapterRegistry: {
          getByProvider: () => Effect.succeed(adapter as never),
        } as never,
        providerService: {
          startSession: () =>
            Effect.succeed({
              provider: driver,
              providerInstanceId: instanceId,
              status: "ready",
              runtimeMode: "full-access",
              cwd: workspaceRoot,
              threadId,
              createdAt: now,
              updatedAt: now,
            }),
        } as never,
        serverConfig: { homeDir: "/home/tester", stateDir: "/synara/state" },
        serverSettings: {
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              [instanceId]: {
                driver,
                enabled: true,
                config: {},
              },
            },
          }),
        } as never,
      });

      await Effect.runPromise(handler({ threadId, externalId: "external-session" }));

      expect(externalReadInputs).toHaveLength(1);
      expect(externalReadInputs[0]).toMatchObject({
        externalThreadId: "external-session",
        providerInstanceId: instanceId,
      });
    },
  );
});
