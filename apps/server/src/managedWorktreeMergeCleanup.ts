import { ServerConfig } from "./config";
import { withWorktreeRemoval } from "./worktreeLifecycle";
import { ThreadId } from "@synara/contracts";
import { automationContinuationThreadId } from "@synara/shared/automationMode";
import { terminalScopeIdsForThread } from "@synara/shared/terminalThreads";
import { Effect, Option } from "effect";
import { GitHubCli } from "./git/Services/GitHubCli";
import type { ManagedWorktreeMergeCleanup } from "./managedWorktrees";
import { AutomationRepository } from "./persistence/Services/AutomationRepository";
import { ServerSettingsService } from "./serverSettings";
import { TerminalManager } from "./terminal/Services/Manager";

/** Optional in isolated test/service graphs; missing safety dependencies disable pruning. */
export const resolveManagedWorktreeMergeCleanup: Effect.Effect<
  ManagedWorktreeMergeCleanup | undefined
> = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig);
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const github = yield* Effect.serviceOption(GitHubCli);
  const automations = yield* Effect.serviceOption(AutomationRepository);
  const terminals = yield* Effect.serviceOption(TerminalManager);
  if (
    Option.isNone(config) ||
    Option.isNone(settings) ||
    Option.isNone(github) ||
    Option.isNone(automations) ||
    Option.isNone(terminals) ||
    !terminals.value.hasLiveSessionsForThread
  )
    return undefined;
  return {
    withOwnership: (effect) =>
      withWorktreeRemoval(config.value.homeDir, effect).pipe(
        Effect.map(Option.getOrElse(() => false)),
      ),
    enabled: settings.value.getSettings.pipe(
      Effect.map((value) => value.worktrees.pruneAfterMerge),
    ),
    github: github.value,
    isProtected: (id) =>
      Effect.gen(function* () {
        const definitions = yield* automations.value.list({ includeArchived: false });
        if (
          definitions.definitions.some(
            (definition) => definition.enabled && automationContinuationThreadId(definition) === id,
          )
        )
          return true;
        for (const scope of terminalScopeIdsForThread(ThreadId.makeUnsafe(id))) {
          if (yield* terminals.value.hasLiveSessionsForThread!(scope)) return true;
        }
        return false;
      }).pipe(
        Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
      ),
  };
});
