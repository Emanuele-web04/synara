// FILE: PullRequestAutoFixService.ts (layer)
// Purpose: Auto-fix CI. Stores which pull requests each chat watches and, every minute,
//          polls their checks; when one settles red on a new commit it starts a fix turn in
//          that chat, one fix per chat at a time (like Claude Code's CI monitor, which wakes
//          the one session for every bound PR). All decisions live in
//          `pullRequestAutoFixDecision.ts`.
// Layer: Server background service (Stable and Beta; each PR watch is opt-in)

import {
  CommandId,
  EventId,
  MessageId,
  PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  type OrchestrationThreadShell,
  type PullRequestAutoFixPauseReason,
  type PullRequestAutoFixState,
  type ThreadId,
} from "@synara/contracts";
import { PULL_REQUEST_AUTO_FIX_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { normalizeGitHubPullRequestUrl } from "@synara/shared/githubRepository";
import { Cause, Clock, Duration, Effect, Layer, Option, Schedule } from "effect";
import * as Semaphore from "effect/Semaphore";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts";
import { ProviderService } from "../../provider/Services/ProviderService";

import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestAutoFixRepository } from "../../persistence/Services/PullRequestAutoFixRepository.ts";
import {
  buildPullRequestAutoFixPrompt,
  decidePullRequestAutoFix,
  isThreadBusyForAutoFix,
  type PullRequestAutoFixDecision,
} from "../pullRequestAutoFixDecision.ts";
import {
  PullRequestAutoFixError,
  PullRequestAutoFixService,
  type PullRequestAutoFixServiceShape,
} from "../Services/PullRequestAutoFixService.ts";

/** Matches the Environment panel's own PR poll, so auto-fix adds no extra GitHub cadence. */
const PULL_REQUEST_AUTO_FIX_POLL_INTERVAL = Duration.seconds(60);
/** Chats polled side by side; GitHub reads still go through the shared read queue. */
const PULL_REQUEST_AUTO_FIX_THREAD_CONCURRENCY = 4;

const PAUSE_SUMMARIES: Record<PullRequestAutoFixPauseReason, string> = {
  "attempt-limit": `checks still fail after ${PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS} fix attempts`,
  "no-push": "the fix turn ended without pushing a commit",
  "dispatch-interrupted": "the fix request was interrupted; turn Auto-fix on again to resume",
};

const autoFixId = (threadId: ThreadId, label: string) =>
  `pull-request-auto-fix:${threadId}:${label}:${crypto.randomUUID()}`;

const pullRequestLabel = (url: string) => {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `PR #${number}` : "the pull request";
};

const fixCommandId = (state: PullRequestAutoFixState) =>
  CommandId.makeUnsafe(
    `pull-request-auto-fix:${state.threadId}:${state.pullRequestUrl}:${state.lastHandledHeadSha}:${state.attempts}:${state.updatedAt}`,
  );

const make = Effect.gen(function* () {
  const repository = yield* PullRequestAutoFixRepository;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const provider = yield* ProviderService;
  const mutations = yield* Semaphore.make(1);
  let lastRevision = 0;
  let intentRevision = 0;
  const intents = new Map<string, number>();
  const intentKey = (threadId: ThreadId, url: string) => `${threadId}:${url}`;
  const nextUpdatedAt = () =>
    new Date((lastRevision = Math.max(Date.now(), lastRevision + 1))).toISOString();
  const hasBackgroundWork = (threadId: ThreadId) =>
    provider.hasLiveRuntimeTasks?.({ threadId }) ?? Effect.succeed(false);
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const gitCore = yield* GitCore;
  const gitHubCli = yield* GitHubCli;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const enabled = isServerBetaFeatureEnabled(PULL_REQUEST_AUTO_FIX_BETA_FEATURE);

  const fail = (message: string) => new PullRequestAutoFixError({ message });
  const toError = (fallback: string) => (cause: unknown) =>
    fail(cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback);

  const requireEnabled = enabled
    ? Effect.void
    : Effect.fail(fail("Auto-fix CI is unavailable on this host."));

  const resolveThreadCwd = Effect.fnUntraced(function* (thread: OrchestrationThreadShell) {
    const project = Option.getOrUndefined(
      yield* snapshotQuery.getProjectShellById(thread.projectId),
    );
    return project ? (resolveThreadWorkspaceCwd({ thread, projects: [project] }) ?? null) : null;
  });

  const get: PullRequestAutoFixServiceShape["get"] = (input) =>
    requireEnabled.pipe(
      Effect.andThen(repository.listByThread({ threadId: input.threadId })),
      Effect.map((states) => ({ states })),
      Effect.mapError(toError("Failed to read Auto-fix CI.")),
    );

  const set: PullRequestAutoFixServiceShape["set"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      const requestedUrl = normalizeGitHubPullRequestUrl(input.pullRequestUrl);
      if (!requestedUrl) return yield* fail("A valid GitHub pull request URL is required.");
      if (!input.enabled) {
        return yield* mutations.withPermits(1)(
          Effect.gen(function* () {
            const revision = ++intentRevision;
            intents.set(intentKey(input.threadId, requestedUrl), revision);
            const states = yield* repository.listByThread({ threadId: input.threadId });
            for (const state of states) {
              if (
                state.pullRequestUrl === requestedUrl ||
                state.requestedPullRequestUrl === requestedUrl
              ) {
                intents.set(intentKey(input.threadId, state.pullRequestUrl), revision);
                if (state.requestedPullRequestUrl)
                  intents.set(intentKey(input.threadId, state.requestedPullRequestUrl), revision);
                yield* repository.delete({
                  threadId: input.threadId,
                  pullRequestUrl: state.pullRequestUrl,
                });
              }
            }
            return { state: null };
          }),
        );
      }
      const revision = yield* mutations.withPermits(1)(
        Effect.sync(() => {
          const revision = ++intentRevision;
          intents.set(intentKey(input.threadId, requestedUrl), revision);
          return revision;
        }),
      );
      const thread = Option.getOrUndefined(yield* snapshotQuery.getThreadShellById(input.threadId));
      if (!thread || thread.archivedAt != null) {
        return yield* fail("This thread is no longer available.");
      }
      const cwd = yield* resolveThreadCwd(thread);
      if (!cwd) {
        return yield* fail("This thread has no workspace to fix the pull request in.");
      }
      // Confirms the PR exists and is open from the thread's own checkout before watching it.
      const { summary } = yield* gitHubCli.getPullRequestWithChecks({
        cwd,
        reference: input.pullRequestUrl,
      });
      if ((summary.state ?? "open") !== "open") {
        return yield* fail("Only open pull requests can be auto-fixed.");
      }
      const canonicalUrl = normalizeGitHubPullRequestUrl(summary.url);
      if (!canonicalUrl) return yield* fail("GitHub returned an invalid pull request URL.");
      return yield* mutations.withPermits(1)(
        Effect.gen(function* () {
          const previous = (yield* repository.listByThread({ threadId: input.threadId })).find(
            (row) => row.pullRequestUrl === canonicalUrl,
          );
          if (
            intents.get(intentKey(input.threadId, requestedUrl)) !== revision ||
            (intents.get(intentKey(input.threadId, canonicalUrl)) ?? 0) > revision
          )
            return { state: previous ?? null };
          const currentThread = Option.getOrUndefined(
            yield* snapshotQuery.getThreadShellById(input.threadId),
          );
          if (
            !currentThread ||
            currentThread.archivedAt != null ||
            (yield* resolveThreadCwd(currentThread)) !== cwd
          )
            return yield* fail("This thread's workspace is no longer available.");
          intents.set(intentKey(input.threadId, canonicalUrl), revision);
          const owner = (yield* repository.listActive()).find(
            (row) => row.pullRequestUrl === canonicalUrl && row.threadId !== input.threadId,
          );
          if (owner)
            return yield* fail(
              "Auto-fix CI is already enabled for this pull request in another chat. Turn it off there first.",
            );
          const state: PullRequestAutoFixState = {
            threadId: input.threadId,
            pullRequestUrl: canonicalUrl,
            requestedPullRequestUrl:
              requestedUrl === canonicalUrl
                ? (previous?.requestedPullRequestUrl ?? requestedUrl)
                : requestedUrl,
            status: "watching",
            pauseReason: null,
            attempts: 0,
            lastHandledHeadSha: null,
            updatedAt: nextUpdatedAt(),
          };
          yield* repository.upsert(state);
          return { state };
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof PullRequestAutoFixError
          ? cause
          : toError("Failed to update Auto-fix CI.")(cause),
      ),
    );

  const appendActivity = (threadId: ThreadId, kind: string, summary: string) => {
    const createdAt = new Date().toISOString();
    return orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(autoFixId(threadId, kind)),
      threadId,
      requireUnarchived: true,
      activity: {
        id: EventId.makeUnsafe(autoFixId(threadId, kind)),
        kind: `pull-request.auto-fix.${kind}`,
        tone: "info",
        summary,
        payload: {},
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  };

  const startFixTurn = Effect.fnUntraced(function* (input: {
    readonly state: PullRequestAutoFixState;
    readonly thread: OrchestrationThreadShell;
    readonly decision: Extract<PullRequestAutoFixDecision, { type: "fix" }>;
    readonly prNumber: number;
    readonly returnHeadSha: string;
  }) {
    const { state, decision } = input;
    const now = nextUpdatedAt();
    const fixing: PullRequestAutoFixState = {
      ...state,
      status: "fixing",
      pauseReason: null,
      attempts: decision.attempt,
      lastHandledHeadSha: decision.headSha,
      updatedAt: now,
    };
    // The deterministic receipt ties this durable attempt to exactly one dispatch.
    // An interrupted pre-dispatch attempt pauses at restart instead of silently waiting forever.
    yield* repository.upsert(fixing);
    yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: fixCommandId(fixing),
        threadId: state.threadId,
        message: {
          messageId: MessageId.makeUnsafe(autoFixId(state.threadId, "message")),
          role: "user",
          text: buildPullRequestAutoFixPrompt({
            prNumber: input.prNumber,
            pullRequestUrl: state.pullRequestUrl,
            returnHeadSha: input.returnHeadSha,
            headSha: decision.headSha,
            switchBranch: decision.switchBranch,
          }),
          attachments: [],
        },
        dispatchMode: "queue",
        dispatchOrigin: "automation",
        // The thread's own modes: an unattended fix turn never gets more access than the
        // user already gave this thread.
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        createdAt: now,
      })
      .pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            yield* repository.upsert({
              ...fixing,
              status: "paused",
              pauseReason: "dispatch-interrupted",
              updatedAt: nextUpdatedAt(),
            });
            yield* appendActivity(
              state.threadId,
              "paused",
              `Auto-fix CI paused: ${PAUSE_SUMMARIES["dispatch-interrupted"]}`,
            );
          }),
        ),
      );
  });

  const readCheckout = (cwd: string) =>
    Effect.gen(function* () {
      const details = yield* gitCore.statusDetails(cwd);
      const head = yield* gitCore.execute({
        operation: "auto-fix checkout identity",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
      });
      const headSha = head.stdout.trim();
      if (!/^[a-f0-9]{40,64}$/i.test(headSha)) return null;
      return { branch: details.branch, clean: !details.hasWorkingTreeChanges, headSha };
    }).pipe(Effect.orElseSucceed(() => null));

  /** Applies one PR's decision; returns true when it started a fix turn. */
  const pollPullRequest = Effect.fnUntraced(function* (input: {
    readonly state: PullRequestAutoFixState;
    readonly cwd: string | null;
  }) {
    const { state, cwd } = input;
    const observed = cwd
      ? yield* gitHubCli.withRead(
          gitHubCli.getPullRequestWithChecks({ cwd, reference: state.pullRequestUrl }),
        )
      : null;

    return yield* mutations.withPermits(1)(
      Effect.gen(function* () {
        const current = (yield* repository.listByThread({ threadId: state.threadId })).find(
          (row) => row.pullRequestUrl === state.pullRequestUrl,
        );
        if (!current || current.updatedAt !== state.updatedAt || current.status === "paused")
          return false;
        let freshThread = Option.getOrNull(yield* snapshotQuery.getThreadShellById(state.threadId));
        if (
          freshThread &&
          (isThreadBusyForAutoFix(freshThread) || (yield* hasBackgroundWork(state.threadId)))
        )
          return false;
        const freshCwd = freshThread ? yield* resolveThreadCwd(freshThread) : null;
        if (freshCwd !== cwd) return false;
        const freshCheckout = freshCwd ? yield* readCheckout(freshCwd) : null;
        // Git process I/O can outlive a new turn, mode change or workspace switch.
        freshThread = Option.getOrNull(yield* snapshotQuery.getThreadShellById(state.threadId));
        if (
          freshThread &&
          (isThreadBusyForAutoFix(freshThread) || (yield* hasBackgroundWork(state.threadId)))
        )
          return false;
        if ((freshThread ? yield* resolveThreadCwd(freshThread) : null) !== freshCwd) return false;
        const decision = decidePullRequestAutoFix({
          now: yield* Clock.currentTimeMillis,
          state,
          thread: freshThread,
          checkout: freshCheckout,
          pullRequest: observed
            ? {
                state: observed.summary.state ?? "open",
                url: observed.summary.url,
                headBranch: observed.summary.headRefName,
                headSha: observed.headSha,
                checks: observed.checks,
              }
            : {
                state: "open",
                url: state.pullRequestUrl,
                headBranch: null,
                headSha: null,
                checks: [],
              },
        });

        const key = { threadId: state.threadId, pullRequestUrl: state.pullRequestUrl };
        switch (decision.type) {
          case "wait":
            return false;
          case "disable":
            yield* repository.delete(key);
            if (decision.reason === "pull-request-closed") {
              yield* appendActivity(
                state.threadId,
                "stopped",
                `Auto-fix CI turned off: ${pullRequestLabel(state.pullRequestUrl)} was closed`,
              );
            }
            return false;
          case "pause":
            yield* repository.upsert({
              ...state,
              status: "paused",
              pauseReason: decision.reason,
              updatedAt: nextUpdatedAt(),
            });
            yield* appendActivity(
              state.threadId,
              "paused",
              `Auto-fix CI paused on ${pullRequestLabel(state.pullRequestUrl)}: ${PAUSE_SUMMARIES[decision.reason]}`,
            );
            return false;
          case "update":
            yield* repository.upsert({
              ...state,
              status: decision.status,
              attempts: decision.attempts,
              updatedAt: nextUpdatedAt(),
            });
            return false;
          case "fix":
            if (!observed || !freshThread || !freshCheckout) return false;
            yield* startFixTurn({
              state,
              thread: freshThread,
              decision,
              prNumber: observed.summary.number,
              returnHeadSha: freshCheckout.headSha,
            });
            return true;
        }
      }),
    );
  });

  // Every watched PR of a chat is checked each poll, but a chat runs one turn at a time:
  // once a fix starts, the rest wait for the next poll (the chat is busy until it ends).
  const pollThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    states: ReadonlyArray<PullRequestAutoFixState>,
  ) {
    const thread = Option.getOrNull(yield* snapshotQuery.getThreadShellById(threadId));
    // A busy chat is skipped before touching git or GitHub: nothing can start until it idles.
    if (
      thread &&
      thread.archivedAt == null &&
      (isThreadBusyForAutoFix(thread) || (yield* hasBackgroundWork(threadId)))
    )
      return;
    const cwd = thread ? yield* resolveThreadCwd(thread) : null;
    if (thread && !cwd) return;

    for (const state of states) {
      const started = yield* pollPullRequest({ state, cwd }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("auto-fix CI poll failed", {
            threadId,
            pullRequestUrl: state.pullRequestUrl,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (started) return;
    }
  });

  const pollAll = repository.listActive().pipe(
    Effect.flatMap((states) => {
      const byThread = new Map<ThreadId, PullRequestAutoFixState[]>();
      for (const state of states) {
        const group = byThread.get(state.threadId);
        if (group) group.push(state);
        else byThread.set(state.threadId, [state]);
      }
      return Effect.forEach(
        byThread,
        ([threadId, group]) =>
          pollThread(threadId, group).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("auto-fix CI poll failed", {
                threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        { concurrency: PULL_REQUEST_AUTO_FIX_THREAD_CONCURRENCY, discard: true },
      );
    }),
    Effect.catchCause((cause) =>
      Effect.logWarning("auto-fix CI poll failed", { cause: Cause.pretty(cause) }),
    ),
  );

  if (enabled) {
    for (const state of yield* repository.listActive()) {
      lastRevision = Math.max(lastRevision, Date.parse(state.updatedAt));
      if (state.status !== "fixing") continue;
      const receipt = yield* receipts.getByCommandId({ commandId: fixCommandId(state) });
      if (Option.isSome(receipt) && receipt.value.status === "accepted") continue;
      const thread = Option.getOrUndefined(yield* snapshotQuery.getThreadShellById(state.threadId));
      if (!thread || thread.archivedAt != null) {
        yield* repository.delete({
          threadId: state.threadId,
          pullRequestUrl: state.pullRequestUrl,
        });
        continue;
      }
      yield* repository.upsert({
        ...state,
        status: "paused",
        pauseReason: "dispatch-interrupted",
        updatedAt: nextUpdatedAt(),
      });
      yield* appendActivity(
        state.threadId,
        "paused",
        `Auto-fix CI paused on ${pullRequestLabel(state.pullRequestUrl)}: ${PAUSE_SUMMARIES["dispatch-interrupted"]}`,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Auto-fix recovery notice failed", {
            threadId: state.threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
    yield* pollAll.pipe(
      Effect.repeat(Schedule.spaced(PULL_REQUEST_AUTO_FIX_POLL_INTERVAL)),
      Effect.forkScoped,
    );
  }

  return { get, set } satisfies PullRequestAutoFixServiceShape;
});

export const PullRequestAutoFixServiceLive = Layer.effect(PullRequestAutoFixService, make);
