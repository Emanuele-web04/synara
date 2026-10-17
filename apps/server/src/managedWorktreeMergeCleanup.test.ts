import { NodeServices } from "@effect/platform-node";
import { ServerConfig } from "./config";
import { ThreadId } from "@synara/contracts";
import { dockTerminalScopeId } from "@synara/shared/terminalThreads";
import { Effect, Layer } from "effect";
import { expect, it } from "vitest";
import { GitHubCli, type GitHubCliShape } from "./git/Services/GitHubCli";
import { resolveManagedWorktreeMergeCleanup } from "./managedWorktreeMergeCleanup";
import {
  AutomationRepository,
  type AutomationRepositoryShape,
} from "./persistence/Services/AutomationRepository";
import { ServerSettingsService } from "./serverSettings";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager";

it("disables merge pruning if a safety service is unavailable", async () => {
  expect(await Effect.runPromise(resolveManagedWorktreeMergeCleanup)).toBeUndefined();
});

it("protects enabled continuation automations and live dock terminals using fresh service state", async () => {
  let automationEnabled = true;
  let terminalRunning = false;
  const threadId = ThreadId.makeUnsafe("thread");
  const layer = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "worktree-fence-test-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    ServerSettingsService.layerTest({ worktrees: { pruneAfterMerge: true } }),
    Layer.succeed(GitHubCli, {} as GitHubCliShape),
    Layer.succeed(AutomationRepository, {
      list: () =>
        Effect.succeed({
          definitions: [
            { enabled: automationEnabled, mode: "heartbeat", targetThreadId: threadId },
          ],
        }),
    } as unknown as AutomationRepositoryShape),
    Layer.succeed(TerminalManager, {
      hasLiveSessionsForThread: (id: string) =>
        Effect.succeed(terminalRunning && id === dockTerminalScopeId(threadId)),
    } as unknown as TerminalManagerShape),
  );
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const policy = yield* resolveManagedWorktreeMergeCleanup;
        expect(policy).toBeDefined();
        expect(yield* policy!.enabled).toBe(true);
        expect(yield* policy!.isProtected(threadId)).toBe(true);
        automationEnabled = false;
        expect(yield* policy!.isProtected(threadId)).toBe(false);
        terminalRunning = true;
        expect(yield* policy!.isProtected(threadId)).toBe(true);
      }).pipe(Effect.provide(layer)),
    ),
  );
});
