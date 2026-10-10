import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  OrchestrationCommand,
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
  ServerProviderStatus,
} from "@synara/contracts";
import { MessageId, ProjectId, TurnId } from "@synara/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it } from "vitest";

import { AgentGatewayOperationRepositoryLive } from "../../agentGateway/Layers/AgentGatewayOperationRepository.ts";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ExternalMcpGateway,
  type ExternalMcpGatewayShape,
} from "../Services/ExternalMcpGateway.ts";
import { ExternalMcpService } from "../Services/ExternalMcpService.ts";
import { ExternalMcpRepositoryLive } from "./ExternalMcpRepository.ts";
import { ExternalMcpGatewayLive } from "./ExternalMcpGateway.ts";
import { ExternalMcpServiceLive } from "./ExternalMcpService.ts";

const temporaryDirectories: string[] = [];
const NOW = "2026-07-20T12:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("project-external-cc");
const TURN_ID = TurnId.makeUnsafe("turn-external-cc");

function projectShell(workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    kind: "project",
    title: "External MCP project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function emptyThreadDetail(shell: OrchestrationThreadShell): OrchestrationThread {
  return {
    ...shell,
    deletedAt: null,
    pinnedMessages: [],
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
  };
}

function callTool(
  gateway: Pick<ExternalMcpGatewayShape, "handlePost">,
  credential: string,
  name: string,
  args: Record<string, unknown>,
) {
  return gateway.handlePost({
    authorizationHeader: `Bearer ${credential}`,
    body: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("external MCP computer control scope", () => {
  it("requires the computer:control capability and forwards enableComputerControl to the turn", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-external-cc-"));
    temporaryDirectories.push(baseDir);
    const workspaceRoot = path.join(baseDir, "project");
    const worktreesDir = path.join(baseDir, "worktrees");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.mkdirSync(worktreesDir, { recursive: true });

    const project = projectShell(workspaceRoot);
    const threads = new Map<string, OrchestrationThreadShell>();
    const details = new Map<string, OrchestrationThread>();
    const dispatched: OrchestrationCommand[] = [];

    const snapshotLayer = Layer.succeed(ProjectionSnapshotQuery, {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          projects: [project],
          threads: [...threads.values()],
          updatedAt: NOW,
        }),
      getProjectShellById: (projectId: string) =>
        Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      getThreadShellById: (threadId: string) =>
        Effect.succeed(Option.fromNullishOr(threads.get(threadId))),
      getThreadDetailById: (threadId: string) =>
        Effect.succeed(Option.fromNullishOr(details.get(threadId))),
    } as never);

    const engineLayer = Layer.succeed(OrchestrationEngineService, {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          if (command.type === "thread.create") {
            const shell = {
              id: command.threadId,
              projectId: command.projectId,
              title: command.title,
              modelSelection: command.modelSelection,
              runtimeMode: command.runtimeMode,
              interactionMode: command.interactionMode,
              envMode: command.envMode,
              branch: command.branch,
              worktreePath: command.worktreePath,
              associatedWorktreePath: command.associatedWorktreePath ?? null,
              associatedWorktreeBranch: command.associatedWorktreeBranch ?? null,
              associatedWorktreeRef: command.associatedWorktreeRef ?? null,
              createBranchFlowCompleted: false,
              isPinned: false,
              parentThreadId: null,
              subagentAgentId: null,
              subagentNickname: null,
              subagentRole: null,
              forkSourceThreadId: null,
              sidechatSourceThreadId: null,
              lastKnownPr: null,
              latestTurn: null,
              latestUserMessageAt: null,
              creationSource: command.creationSource,
              gatewayOperationId: command.gatewayOperationId,
              gatewayOperationIndex: command.gatewayOperationIndex,
              createdAt: command.createdAt,
              updatedAt: command.createdAt,
              archivedAt: null,
              handoff: null,
              session: null,
            } as OrchestrationThreadShell;
            threads.set(shell.id, shell);
            details.set(shell.id, emptyThreadDetail(shell));
          }
          if (command.type === "thread.turn.start") {
            const prior = threads.get(command.threadId);
            if (!prior) throw new Error("Turn dispatched before thread creation.");
            threads.set(command.threadId, {
              ...prior,
              latestTurn: {
                turnId: TURN_ID,
                state: "completed",
                requestedAt: command.createdAt,
                startedAt: command.createdAt,
                completedAt: command.createdAt,
                assistantMessageId: MessageId.makeUnsafe("message-cc-result"),
              },
              latestUserMessageAt: command.createdAt,
              updatedAt: command.createdAt,
            });
          }
          return { sequence: dispatched.length };
        }),
    } as never);

    const gitLayer = Layer.succeed(GitCore, {
      withMutation: (_cwd: string, effect: Effect.Effect<unknown, unknown, unknown>) => effect,
      execute: () =>
        Effect.succeed({
          code: 0,
          stdout: "0123456789abcdef0123456789abcdef01234567\n",
          stderr: "",
        }),
      createDetachedWorktree: (input: {
        readonly path?: string;
        readonly ref: string;
        readonly newBranch?: string;
      }) =>
        Effect.succeed({
          worktree: {
            path: input.path ?? path.join(worktreesDir, "generated"),
            ref: input.ref,
            branch: input.newBranch ?? null,
          },
        }),
      recordWorktreeOwnership: (input: {
        readonly path: string;
        readonly branch: string | null;
        readonly token: string;
      }) =>
        Effect.succeed({
          token: input.token,
          gitDir: path.join(baseDir, "git-admin", input.token),
          branch: input.branch,
          head: "0123456789abcdef0123456789abcdef01234567",
        }),
      listBranches: () => Effect.succeed({ isRepo: true, hasOriginRemote: false, branches: [] }),
      verifyWorktreeOwnership: () => Effect.succeed({ verified: true, reason: null }),
      removeWorktree: () => Effect.void,
      deleteBranchIfUnchanged: () => Effect.void,
    } as never);

    const providerDiscoveryLayer = Layer.succeed(ProviderDiscoveryService, {
      listModels: ({ provider }: { readonly provider: string }) =>
        Effect.succeed({
          models: provider === "codex" ? [{ slug: "gpt-5.5", name: "GPT-5.5" }] : [],
          source: "test",
        }),
    } as never);
    const providerHealthLayer = Layer.succeed(ProviderHealth, {
      getStatuses: Effect.succeed([
        {
          provider: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: NOW,
        },
      ] as ServerProviderStatus[]),
      refresh: Effect.succeed([] as ServerProviderStatus[]),
      updateProvider: () => Effect.die("not used"),
      streamChanges: Stream.empty,
    } as never);
    const projectionTurnsLayer = Layer.succeed(ProjectionTurnRepository, {
      getManyWaitSnapshot: () =>
        Effect.succeed({ existingThreadIds: [...threads.keys()], turns: [] }),
    } as never);
    const configLayer = Layer.succeed(ServerConfig, {
      baseDir,
      worktreesDir,
      host: "127.0.0.1",
      publicUrl: undefined,
    } as never);

    const repositoryLayer = ExternalMcpRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const operationLayer = AgentGatewayOperationRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const serviceLayer = ExternalMcpServiceLive.pipe(
      Layer.provideMerge(repositoryLayer),
      Layer.provide(snapshotLayer),
      Layer.provide(configLayer),
    );
    const gatewayLayer = ExternalMcpGatewayLive.pipe(
      Layer.provideMerge(serviceLayer),
      Layer.provideMerge(repositoryLayer),
      Layer.provide(snapshotLayer),
      Layer.provide(engineLayer),
      Layer.provide(gitLayer),
      Layer.provide(providerDiscoveryLayer),
      Layer.provide(providerHealthLayer),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(projectionTurnsLayer),
      Layer.provide(operationLayer),
      Layer.provide(configLayer),
    );
    const testLayer = Layer.mergeAll(gatewayLayer, serviceLayer, SqlitePersistenceMemory);

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ExternalMcpService;
        const gateway = yield* ExternalMcpGateway;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            ${PROJECT_ID}, ${project.title}, ${project.workspaceRoot}, '[]', ${NOW}, ${NOW}, NULL
          )
        `;

        // Integration WITHOUT computer:control — request must be denied.
        const plain = yield* service.createIntegration({
          name: "No computer scope",
          projectIds: [PROJECT_ID],
          capabilities: ["projects:read", "tasks:create", "tasks:wait", "tasks:read"],
          expiresInDays: 30,
        });
        yield* service.pair(plain.pairingCode, "syn_mcp_v1_cc-plain-secret");
        const denied = yield* callTool(
          gateway,
          "syn_mcp_v1_cc-plain-secret",
          "synara_create_task",
          {
            requestId: "cc-denied",
            projectId: PROJECT_ID,
            provider: "codex",
            model: "gpt-5.5",
            prompt: "denied task",
            enableComputerControl: true,
          },
        );
        expect(JSON.stringify(denied.body)).toContain("capability_denied");
        expect(JSON.stringify(denied.body)).toContain("computer:control");
        expect(dispatched.filter((c) => c.type === "thread.turn.start")).toHaveLength(0);

        // Same integration without the field still works.
        const allowedPlain = yield* callTool(
          gateway,
          "syn_mcp_v1_cc-plain-secret",
          "synara_create_task",
          {
            requestId: "cc-plain",
            projectId: PROJECT_ID,
            provider: "codex",
            model: "gpt-5.5",
            prompt: "plain task",
          },
        );
        expect(JSON.stringify(allowedPlain.body)).not.toContain("capability_denied");
        const plainTurn = dispatched.find((c) => c.type === "thread.turn.start");
        expect(
          plainTurn && "enableComputerControl" in plainTurn
            ? plainTurn.enableComputerControl
            : undefined,
        ).toBeUndefined();

        // Integration WITH computer:control — task gets the flag on turn.start.
        const scoped = yield* service.createIntegration({
          name: "With computer scope",
          projectIds: [PROJECT_ID],
          capabilities: [
            "projects:read",
            "tasks:create",
            "tasks:wait",
            "tasks:read",
            "computer:control",
          ],
          expiresInDays: 30,
        });
        yield* service.pair(scoped.pairingCode, "syn_mcp_v1_cc-scoped-secret");
        const granted = yield* callTool(
          gateway,
          "syn_mcp_v1_cc-scoped-secret",
          "synara_create_task",
          {
            requestId: "cc-granted",
            projectId: PROJECT_ID,
            provider: "codex",
            model: "gpt-5.5",
            prompt: "computer task",
            enableComputerControl: true,
          },
        );
        expect(JSON.stringify(granted.body)).not.toContain("capability_denied");
        const turns = dispatched.filter((c) => c.type === "thread.turn.start");
        const grantedTurn = turns.at(-1);
        expect(grantedTurn).toMatchObject({
          enableComputerControl: true,
          computerControlMode: "request",
        });
      }).pipe(Effect.provide(testLayer)),
    );
  });
});
