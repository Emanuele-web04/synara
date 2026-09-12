import fs from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ProjectId, ThreadId } from "@synara/contracts";
import * as processRuntime from "@synara/shared/processRuntime";
import { Effect, Option } from "effect";
import { expect, it, vi } from "vitest";

import { makeAgentGatewayCredentials } from "../src/agentGateway/Layers/AgentGatewayCredentials.ts";
import { AgentGatewaySessionRegistryLive } from "../src/agentGateway/Layers/AgentGatewaySessionRegistry.ts";
import { makeAgentGatewayMcpTransport } from "../src/agentGateway/mcpTransport.ts";
import { mcpToolResultJson } from "../src/agentGateway/protocol.ts";
import { ServerConfig } from "../src/config.ts";
import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

it.each([false, true])(
  "preserves manual ownership and completes queued automation (legacy interruption: %s)",
  async (legacyInterruption) => {
    let reconciliationOffsetMs = 0;
    try {
      const spawnProcess = processRuntime.spawnProcess;
      vi.spyOn(processRuntime, "spawnProcess").mockImplementation((command, args, options) => {
        if (args?.includes("app-server") || args?.includes("--version")) {
          expect(command).toBe(process.execPath);
          expect(options?.env?.CODEX_HOME).toBe(process.env.CODEX_HOME);
          expect(options?.env?.CODEX_SQLITE_HOME).toBe(process.env.CODEX_HOME);
        }
        return spawnProcess(command, args, options);
      });
      await Effect.acquireUseRelease(
        makeOrchestrationIntegrationHarness({
          realCodex: true,
          serverSettings: { providers: { codex: { binaryPath: process.execPath } } },
          runtimeReconcilerOptions: { now: () => Date.now() + reconciliationOffsetMs },
        }),
        (harness) =>
          Effect.gen(function* () {
            // Use the real adapter/process transport against a deterministic local
            // protocol peer. Synara, Codex home/config/SQLite, and Git are isolated.
            const codexState = path.join(harness.rootDir, "codex-home-overlay");
            expect(path.isAbsolute(codexState)).toBe(true);
            expect([
              process.env.USERPROFILE,
              process.cwd(),
              harness.workspaceDir,
              harness.rootDir,
            ]).not.toContain(codexState);
            fs.mkdirSync(codexState);
            fs.writeFileSync(
              path.join(codexState, "config.toml"),
              `sqlite_home = ${JSON.stringify(codexState)}\n`,
            );
            vi.stubEnv("SYNARA_HOME", harness.rootDir);
            vi.stubEnv("CODEX_HOME", codexState);
            vi.stubEnv("CODEX_SQLITE_HOME", codexState);
            fs.copyFileSync(
              path.join(import.meta.dirname, "fixtures/codexLifecycle.cjs"),
              path.join(harness.workspaceDir, "app-server"),
            );

            const projectId = ProjectId.makeUnsafe("lifecycle-project");
            const threadId = ThreadId.makeUnsafe("lifecycle-thread");
            const modelSelection = { provider: "codex", model: "gpt-5.6-sol" } as const;
            const createdAt = new Date().toISOString();
            yield* harness.engine.dispatch({
              type: "project.create",
              commandId: CommandId.makeUnsafe("lifecycle-project-create"),
              projectId,
              title: "Lifecycle fixture",
              workspaceRoot: harness.workspaceDir,
              defaultModelSelection: modelSelection,
              createdAt,
            });
            yield* harness.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.makeUnsafe("lifecycle-thread-create"),
              threadId,
              projectId,
              title: "Lifecycle fixture",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            });
            const start = (id: string, dispatchOrigin: "user" | "automation") =>
              harness.engine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.makeUnsafe(`${id}-start`),
                threadId,
                message: {
                  messageId: MessageId.makeUnsafe(id),
                  role: "user",
                  text: id,
                  attachments: [],
                },
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                dispatchMode: "queue",
                dispatchOrigin,
                createdAt: new Date().toISOString(),
              });
            yield* start("manual-message", "user");
            yield* harness.waitForThread(
              threadId,
              (thread) =>
                thread.latestTurn?.state === "running" &&
                thread.session?.activeTurnId === "fixture-turn-1" &&
                thread.messages.some((message) =>
                  message.text.includes("Working on fixture-turn-1"),
                ),
            );

            // Advance only reconciliation's observation clock. The live adapter
            // and its activity watchdog continue using real time.
            const reconcileAfterDeadline = () =>
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  reconciliationOffsetMs = 46 * 60_000;
                }),
                () => harness.runtimeReconciler.reconcileNow,
                () =>
                  Effect.sync(() => {
                    reconciliationOffsetMs = 0;
                  }),
              );
            yield* reconcileAfterDeadline();

            const credentials = yield* makeAgentGatewayCredentials.pipe(
              Effect.provide(AgentGatewaySessionRegistryLive),
              Effect.provide(ServerConfig.layerTest(harness.workspaceDir, harness.rootDir)),
            );
            const token = credentials.issueSessionToken(threadId, "codex");
            const transport = makeAgentGatewayMcpTransport({
              credentials,
              snapshotQuery: harness.snapshotQuery,
              instructions: "Lifecycle fixture",
              requireThreadShell: (id) =>
                harness.snapshotQuery
                  .getThreadShellById(ThreadId.makeUnsafe(id))
                  .pipe(Effect.map(Option.getOrThrow)),
              tools: [
                {
                  requiredCapability: "automation:write",
                  requiresActiveTurn: true,
                  definition: {
                    name: "lifecycle_write",
                    description: "Check exact turn ownership",
                    inputSchema: { type: "object" },
                  },
                  handler: (_args, context) =>
                    Effect.succeed(mcpToolResultJson({ turnId: context.callerTurnId })),
                },
              ],
            });
            const write = () =>
              transport({
                authorizationHeader: `Bearer ${token}`,
                body: {
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: { name: "lifecycle_write", arguments: {} },
                },
              });
            expect(JSON.stringify(yield* write())).toContain("fixture-turn-1");

            if (legacyInterruption) {
              const shell = Option.getOrThrow(
                yield* harness.snapshotQuery.getThreadShellById(threadId),
              );
              yield* harness.engine.dispatch({
                type: "thread.session.set",
                commandId: CommandId.makeUnsafe("legacy-false-interruption"),
                threadId,
                session: {
                  ...shell.session!,
                  status: "interrupted",
                  activeTurnId: null,
                  updatedAt: new Date().toISOString(),
                },
                createdAt: new Date().toISOString(),
              });
              expect(JSON.stringify(yield* write())).toContain("caller_turn_inactive");
            }
            yield* start("automation-message", "automation");
            yield* harness.waitForDomainEvent(
              (event) =>
                event.type ===
                  (legacyInterruption ? "thread.turn-start-requested" : "thread.turn-queued") &&
                event.payload.messageId === "automation-message",
            );
            if (legacyInterruption) {
              const stale = Option.getOrThrow(
                yield* harness.snapshotQuery.getThreadShellById(threadId),
              );
              expect(stale.session).toMatchObject({ status: "starting", activeTurnId: null });
              expect(stale.latestTurn?.state).toBe("interrupted");
            }
            yield* reconcileAfterDeadline();
            const queued = Option.getOrThrow(
              yield* harness.snapshotQuery.getThreadShellById(threadId),
            );
            expect(queued.session?.activeTurnId).toBe("fixture-turn-1");
            expect(queued.latestTurn).toMatchObject({
              turnId: "fixture-turn-1",
              state: "running",
              completedAt: null,
            });
            expect(JSON.stringify(yield* write())).not.toContain("caller_turn_inactive");
            const protocol = () =>
              fs
                .readFileSync(path.join(codexState, "protocol.jsonl"), "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as { type: string; turnId: string });
            expect(protocol().filter((event) => event.type === "started")).toHaveLength(1);

            fs.writeFileSync(path.join(codexState, "complete-fixture-turn-1"), "");
            yield* harness.waitForThread(
              threadId,
              (thread) => thread.session?.activeTurnId === "fixture-turn-2",
            );
            fs.writeFileSync(path.join(codexState, "complete-fixture-turn-2"), "");
            const completed = yield* harness.waitForThread(
              threadId,
              (thread) =>
                thread.session?.status === "ready" &&
                thread.latestTurn?.turnId === "fixture-turn-2" &&
                thread.latestTurn.state === "completed",
            );
            expect(completed.session?.activeTurnId).toBeNull();
            expect(
              completed.messages
                .filter((message) => message.role === "assistant")
                .map((message) => message.turnId),
            ).toEqual(expect.arrayContaining(["fixture-turn-1", "fixture-turn-2"]));
            expect(protocol()).toEqual([
              { type: "started", turnId: "fixture-turn-1" },
              { type: "completed", turnId: "fixture-turn-1", state: "completed" },
              { type: "started", turnId: "fixture-turn-2" },
              { type: "completed", turnId: "fixture-turn-2", state: "completed" },
            ]);
            expect(JSON.stringify(yield* write())).toContain("caller_turn_inactive");
          }),
        (harness) => harness.dispose,
      ).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  },
);
