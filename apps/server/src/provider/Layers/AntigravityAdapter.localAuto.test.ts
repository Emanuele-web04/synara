import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalRequestId, ThreadId, type ProviderRuntimeEvent } from "@synara/contracts";
import { spawnProcess } from "@synara/shared/processRuntime";
import { Effect, Layer, Stream } from "effect";
import { expect, it, vi } from "vitest";
import { ServerConfig } from "../../config";
import { AntigravityAdapter } from "../Services/AntigravityAdapter";
import {
  buildAntigravityHookConfig,
  hookScriptSource,
  makeAntigravityAdapterLive,
  type AntigravityAdapterDependencies,
} from "./AntigravityAdapter";

it.each(["accept", "decline", "interrupt", "stop"] as const)(
  "gates the actual Antigravity hook process until %s",
  async (decision) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synara-antigravity-auto-"));
    let env: NodeJS.ProcessEnv = {};
    let cliArgs: readonly string[] = [];
    let hook: ChildProcess | undefined;
    const fakeSpawn = ((_command, args, options) => {
      env = options.env ?? {};
      cliArgs = args;
      return Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        killed: false,
        kill: () => true,
      }) as unknown as ChildProcess;
    }) as NonNullable<AntigravityAdapterDependencies["spawnProcess"]>;
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const adapter = yield* AntigravityAdapter;
          const events: ProviderRuntimeEvent[] = [];
          yield* adapter.streamEvents.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                events.push(event);
              }),
            ),
            Effect.forkChild,
          );
          const threadId = ThreadId.makeUnsafe("agy-auto");
          yield* adapter.startSession({
            provider: "antigravity",
            threadId,
            cwd: root,
            runtimeMode: "auto-local",
            lifecycleGeneration: "generation",
            providerOptions: { antigravity: { binaryPath: "/fake/agy" } },
          });
          const turn = yield* adapter.sendTurn({
            threadId,
            input: "Create a file",
            attachments: [],
          });
          yield* Effect.promise(async () => {
            expect(cliArgs).not.toContain("--dangerously-skip-permissions");
            expect(env.SYNARA_ANTIGRAVITY_HOOK_DECISION).toBe("ask");
            expect(env.SYNARA_ANTIGRAVITY_APPROVAL_DIR).toBeTruthy();
            const script = path.join(root, "capture.cjs");
            await fs.writeFile(script, hookScriptSource());
            hook = spawnProcess(process.execPath, [script, "pre-tool"], {
              env,
              stdio: ["pipe", "pipe", "pipe"],
            }) as ChildProcess;
            let output = "";
            hook.stdout!.on("data", (chunk) => {
              output += String(chunk);
            });
            const exited = new Promise<void>((resolve, reject) => {
              hook!.once("close", () => resolve());
              hook!.once("error", reject);
            });
            hook.stdin!.end(
              JSON.stringify({
                stepIdx: 0,
                toolCall: {
                  name: "write_to_file",
                  args: { TargetFile: "file.txt", CodeContent: "exact\ncontent" },
                },
              }),
            );
            await vi.waitFor(() =>
              expect(events.some((event) => event.type === "request.opened")).toBe(true),
            );
            expect(output).toBe("");
            const request = events.find((event) => event.type === "request.opened")!;
            expect(request).toMatchObject({
              turnId: turn.turnId,
              lifecycleGeneration: "generation",
              payload: {
                args: {
                  toolName: "write_to_file",
                  input: { TargetFile: "file.txt", CodeContent: "exact\ncontent" },
                },
              },
            });
            if (decision === "interrupt")
              await Effect.runPromise(adapter.interruptTurn(threadId, turn.turnId));
            else if (decision === "stop") await Effect.runPromise(adapter.stopSession(threadId));
            else
              await Effect.runPromise(
                adapter.respondToRequest(
                  threadId,
                  ApprovalRequestId.makeUnsafe(request.requestId!),
                  decision,
                ),
              );
            await vi.waitFor(() =>
              expect(events.filter((event) => event.type === "request.resolved")).toHaveLength(1),
            );
            if (decision === "accept" || decision === "decline") {
              await exited;
              expect(JSON.parse(output)).toEqual({
                decision: decision === "accept" ? "allow" : "deny",
              });
              const lines = (await fs.readFile(env.SYNARA_ANTIGRAVITY_EVENTS!, "utf8"))
                .trim()
                .split("\n");
              expect(lines.some((line) => line.startsWith("approval-finished\t"))).toBe(true);
            } else {
              expect(output).not.toContain('"allow"');
              await expect(
                Effect.runPromise(
                  adapter.respondToRequest(
                    threadId,
                    ApprovalRequestId.makeUnsafe(request.requestId!),
                    "accept",
                  ),
                ),
              ).rejects.toBeDefined();
            }
          });
          yield* adapter.stopSession(threadId);
        }).pipe(
          Effect.provide(
            makeAntigravityAdapterLive({
              ensurePlugin: async () => {},
              spawnProcess: fakeSpawn,
              teardownProcessTree: async () => ({ escalated: false, signalErrors: [] }),
            }).pipe(
              Layer.provideMerge(ServerConfig.layerTest(root, { prefix: "agy-auto-" })),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
          Effect.scoped,
        ),
      );
    } finally {
      hook?.kill();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

it("lets the bounded approval wait finish before Antigravity's hook timeout", () => {
  expect(buildAntigravityHookConfig((event) => `capture ${event}`)).toMatchObject({
    "synara-capture": { PreToolUse: [{ hooks: [{ timeout: 610 }] }] },
  });
});
