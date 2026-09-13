import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";
import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type OrchestrationThread,
  ProjectId,
  type ProviderInstanceId,
  type ProviderSession,
  type ProviderStartOptions,
  ThreadId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";
import { Effect, FileSystem, Option, Path } from "effect";

import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import { claudeIsolatedHomePath } from "../provider/claudeEnvironment";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ServerSettingsShape } from "../serverSettings";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery";
import {
  claudeHistoricalSessionChildEnvironment,
  claudeHistoricalSessionEnvironment,
  makeImportThreadHandler,
  resolveImportedThreadProviderOptionsForSettings,
} from "./importThreadRoute";

const threadId = ThreadId.makeUnsafe("thread-import");
const projectId = ProjectId.makeUnsafe("project-import");
const importedAt = "2026-08-09T12:00:00.000Z";

it("expands instance Claude homes for historical-session imports", () => {
  const environment = claudeHistoricalSessionEnvironment({
    claudeAgent: {
      homePath: "~/claude-work",
      environment: { CLAUDE_IMPORT_TEST: "1" },
    },
  } satisfies ProviderStartOptions);

  assert.equal(environment?.HOME, path.join(homedir(), "claude-work"));
  assert.equal(environment?.CLAUDE_IMPORT_TEST, "1");
});

it("expands instance Claude homes against the configured Synara home", () => {
  const environment = claudeHistoricalSessionEnvironment(
    {
      claudeAgent: {
        homePath: "~/claude-work",
        environment: { CLAUDE_IMPORT_TEST: "1" },
      },
    } satisfies ProviderStartOptions,
    { homeDir: "/synara/home" },
  );

  assert.equal(environment?.HOME, path.join("/synara/home", "claude-work"));
  assert.equal(environment?.CLAUDE_IMPORT_TEST, "1");
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

  assert.equal(environment?.HOME, claudeIsolatedHomePath({ isolationRootDir, providerInstanceId }));
  assert.equal(environment?.ANTHROPIC_AUTH_TOKEN, "work-token");
});

it("does not remerge ambient credentials into Claude import child environments", () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "ambient-key";
  try {
    const environment: NodeJS.ProcessEnv = claudeHistoricalSessionChildEnvironment({
      HOME: "/tmp/synara-claude-import",
    });

    assert.deepEqual(environment, { HOME: "/tmp/synara-claude-import" });
    assert.equal((environment as NodeJS.ProcessEnv)["ANTHROPIC_API_KEY"], undefined);
  } finally {
    if (original === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = original;
    }
  }
});

function makeCodexThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId,
    title: "Imported thread",
    modelSelection: { provider: "codex", model: "gpt-5.5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: null,
    createdAt: importedAt,
    updatedAt: importedAt,
    archivedAt: null,
    settledAt: null,
    deletedAt: null,
    handoff: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

it.effect("imports Codex history through a provider-owned fork", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const externalId = "019fbe83-572e-7092-a84e-5ba7285ca2c5";
    const dispatchedCommands: OrchestrationCommand[] = [];
    const session: ProviderSession = {
      provider: "codex",
      status: "ready",
      runtimeMode: "full-access",
      threadId,
      resumeCursor: { threadId: "forked-codex-thread" },
      createdAt: importedAt,
      updatedAt: importedAt,
    };
    const startSession = vi.fn(() => Effect.succeed(session));
    const readThread = vi.fn(() =>
      Effect.succeed({
        threadId: "forked-codex-thread",
        turns: [],
      }),
    );

    const handler = makeImportThreadHandler({
      fileSystem,
      path,
      platform: process.platform,
      serverConfig: { homeDir: "/tmp/synara-home", stateDir: "/tmp/synara-state" },
      orchestrationEngine: {
        dispatch: (command: OrchestrationCommand) =>
          Effect.sync(() => {
            dispatchedCommands.push(command);
            return { sequence: dispatchedCommands.length };
          }),
      } as unknown as OrchestrationEngineShape,
      projectionSnapshotQuery: {
        getThreadDetailById: () => Effect.succeed(Option.some(makeCodexThread())),
        getProjectShellById: () => Effect.succeed(Option.none()),
      } as unknown as ProjectionSnapshotQueryShape,
      providerAdapterRegistry: {
        getByProvider: () =>
          Effect.succeed({
            readThread,
          } as never),
      } as unknown as ProviderAdapterRegistryShape,
      providerService: {
        startSession,
        stopSession: () => Effect.void,
      } as unknown as ProviderServiceShape,
      serverSettings: {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as unknown as ServerSettingsShape,
    });

    const result = yield* handler({ threadId, externalId });

    assert.deepEqual(result, { threadId });
    assert.deepEqual(startSession.mock.calls[0], [
      threadId,
      {
        threadId,
        provider: "codex",
        modelSelection: { provider: "codex", model: "gpt-5.5" },
        forkSourceResumeCursor: { threadId: externalId },
        runtimeMode: "full-access",
      },
    ]);
    assert.deepEqual(readThread.mock.calls, [[threadId]]);
    assert.equal(dispatchedCommands.at(-1)?.type, "thread.session.set");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects imports before inspecting a disabled provider adapter", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const thread = {
      ...makeCodexThread(),
      modelSelection: { provider: "opencode" as const, model: "openai/gpt-5" },
    };
    const getByProvider = vi.fn(() => Effect.die("disabled provider adapter must not be read"));
    const startSession = vi.fn(() => Effect.die("disabled provider session must not start"));

    const handler = makeImportThreadHandler({
      fileSystem,
      path,
      platform: process.platform,
      serverConfig: { homeDir: "/tmp/synara-home", stateDir: "/tmp/synara-state" },
      orchestrationEngine: {
        dispatch: () => Effect.die("disabled import must not dispatch"),
      } as unknown as OrchestrationEngineShape,
      projectionSnapshotQuery: {
        getThreadDetailById: () => Effect.succeed(Option.some(thread)),
        getProjectShellById: () => Effect.die("disabled import must stop before project lookup"),
      } as unknown as ProjectionSnapshotQueryShape,
      providerAdapterRegistry: {
        getByProvider,
      } as unknown as ProviderAdapterRegistryShape,
      providerService: {
        startSession,
      } as unknown as ProviderServiceShape,
      serverSettings: {
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          providers: {
            ...DEFAULT_SERVER_SETTINGS.providers,
            opencode: {
              ...DEFAULT_SERVER_SETTINGS.providers.opencode,
              enabled: false,
            },
          },
        }),
      } as unknown as ServerSettingsShape,
    });

    const failure = yield* Effect.flip(
      handler({ threadId, externalId: "prepared-before-disable" }),
    );

    assert.ok(failure);
    assert.match(failure.message, /OpenCode is disabled/);
    assert.equal(getByProvider.mock.calls.length, 0);
    assert.equal(startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("rejects disabled provider instances before import preflight can materialize options", () => {
  assert.throws(
    () =>
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
        { provider: "opencode", instanceId: "opencode_disabled", model: "opencode/model" },
      ),
    /disabled for thread import/,
  );
});

it("passes the resolved OpenCode instance into external-thread preflight", async () => {
  const importThreadId = ThreadId.makeUnsafe("thread-import-opencode");
  const importProjectId = ProjectId.makeUnsafe("project-import-opencode");
  const instanceId = "opencode_work" as ProviderInstanceId;
  const workspaceRoot = "/repo/opencode";
  const externalReadInputs: Array<Record<string, unknown>> = [];
  const now = new Date().toISOString();
  const adapter = {
    readExternalThread: (input: Record<string, unknown>) => {
      externalReadInputs.push(input);
      return Effect.succeed({
        threadId: importThreadId,
        turns: [],
        cwd: workspaceRoot,
      });
    },
    readThread: () => Effect.succeed({ threadId: importThreadId, turns: [], cwd: workspaceRoot }),
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
            id: importThreadId,
            projectId: importProjectId,
            title: "Imported thread",
            modelSelection: {
              provider: "opencode",
              instanceId,
              model: "opencode/test-model",
            },
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
            id: importProjectId,
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
          provider: "opencode",
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: "full-access",
          cwd: workspaceRoot,
          threadId: importThreadId,
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
            driver: "opencode",
            enabled: true,
            config: {},
          },
        },
      }),
    } as never,
  });

  await Effect.runPromise(handler({ threadId: importThreadId, externalId: "external-session" }));

  assert.equal(externalReadInputs.length, 1);
  assert.equal(externalReadInputs[0]?.externalThreadId, "external-session");
  assert.equal(externalReadInputs[0]?.providerInstanceId, instanceId);
  assert.equal(externalReadInputs[0]?.cwd, workspaceRoot);
});
