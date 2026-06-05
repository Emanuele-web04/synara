/**
 * ExecutionRuntimeServiceLive - The orchestration-facing execution-runtime seam.
 *
 * For `local`/`worktree` threads this resolves nothing and provisions nothing:
 * it returns a compat target with no cwd override, so the reactor keeps its
 * existing local spawn path unchanged. For `remote-runtime` threads it resolves
 * a runtime adapter *by provider* through `RuntimeProviderRegistry`, provisions
 * an instance, and records the resolved facts (instance create, process
 * start/complete, destroy) through internal orchestration commands so runtime
 * state is event-sourced and survives reconnect. Stable per-thread/per-instance
 * command ids make reconnect/crash retries dedupe on the receipt rather than
 * re-appending.
 *
 * The service never names a concrete provider for its lifecycle calls: it routes
 * through `registry.getAdapter(provider)`. The only `fake`-specific knowledge it
 * still holds is the server-internal flavor bookkeeping standing in for a public
 * `runtimePlan` (no public plan carries a flavor), which the fake facade's
 * `deriveFakeFlavor` produces. The reactor sees only `ResolvedExecutionTarget`
 * and a `JsonRpcLineTransport`.
 *
 * @module ExecutionRuntimeServiceLive
 */
import {
  CommandId,
  ExecutionInstanceId,
  RuntimeProcessId,
  RuntimeSnapshotId,
  type ExecutionRuntimeProvider,
  type ExecutionTargetKind,
  type RuntimePlan,
  type RuntimeRole,
  type ThreadId,
} from "@t3tools/contracts";
import { Deferred, Duration, Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type {
  JsonRpcLineTransport,
  ProcessExit,
} from "../../provider/process/JsonRpcLineTransport.ts";
import { MissingCredentialsError, RuntimeProvisionFailedError } from "../Errors.ts";
import { buildTokenizedRepoUrl, resolveGitHubToken } from "../gitWorkspaceBootstrap.ts";
import type { ExecutionRuntimeRepoSource } from "../Services/ExecutionRuntimeProviderAdapter.ts";
import { ExecutionRuntimePlanner } from "../Services/ExecutionRuntimePlanner.ts";
import { type FakeRuntimeFlavor } from "../Services/FakeRuntimeFlavor.ts";
import { RuntimeActivityLeaseManager } from "../Services/RuntimeActivityLeaseManager.ts";
import { RuntimeProviderRegistry } from "../Services/RuntimeProviderRegistry.ts";
import {
  RuntimeProviderCredentials,
  type CredentialedRuntimeProvider,
} from "../Services/RuntimeProviderCredentials.ts";
import { RuntimeWorkspaceDiff } from "../Services/RuntimeWorkspaceDiff.ts";
import {
  ExecutionRuntimeService,
  type ExecutionRuntimeServiceShape,
  type ExecutionRuntimeWorkspaceDiff,
  type ResolvedExecutionTarget,
} from "../Services/ExecutionRuntimeService.ts";
import { deriveFakeFlavor } from "./FakeRuntimeProviderFacade.ts";

const RUNNING_INSTANCE_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "idle"]);

// How often the activity-lease keepalive renews while a turn's transport is
// alive. A provider that auto-stops an idle sandbox (Daytona) uses a window far
// larger than this, so a single missed tick never trips its idle stop.
const ACTIVITY_RENEW_INTERVAL_MS = 60_000;

// When a remote thread is resolved after the in-memory flavor map is gone (a
// server restart between provision-request and provisioning), the read-model
// still says remote/`fake`. Fall back to a flavor that backs the agent role so
// the public remote path stays resilient across restart instead of failing.
const DEFAULT_FAKE_FLAVOR: FakeRuntimeFlavor = "fake-pty-workspace";

const runtimeCommandId = (threadId: ThreadId, suffix: string): CommandId =>
  CommandId.makeUnsafe(`runtime:${threadId}:${suffix}`);

// `markThreadRemote` carries a flavor but no public plan; synthesize the minimal
// plan the fake facade provisions from. The synthesized plan round-trips through
// `deriveFakeFlavor`, but the exact requested flavor is preserved in the
// per-thread/per-instance flavor maps so a non-pty/non-ephemeral flavor keeps
// its precise reconnect capability.
const planForFlavor = (flavor: FakeRuntimeFlavor): RuntimePlan => ({
  targetKind: "remote-runtime",
  provider: "fake",
  ports: [],
  persistent: flavor === "fake-pty-workspace" || flavor === "fake-command-workspace",
  snapshotId: null,
});

interface ProvisionIntent {
  readonly provider: ExecutionRuntimeProvider;
  readonly plan: RuntimePlan;
  /** Server-internal fake flavor, present only for the `fake` provider family. */
  readonly fakeFlavor?: FakeRuntimeFlavor;
}

// The providers whose credentials gate the real client. `fake`/`local`/`worktree`
// need none, so the missing-creds preflight skips them.
const CREDENTIALED_PROVIDERS: ReadonlySet<ExecutionRuntimeProvider> = new Set([
  "daytona",
  "vercel-sandbox",
  "modal",
  "cloudflare",
]);

const asCredentialedProvider = (
  provider: ExecutionRuntimeProvider,
): CredentialedRuntimeProvider | null =>
  CREDENTIALED_PROVIDERS.has(provider) ? (provider as CredentialedRuntimeProvider) : null;

const makeExecutionRuntimeService = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const planner = yield* ExecutionRuntimePlanner;
  const registry = yield* RuntimeProviderRegistry;
  const credentials = yield* RuntimeProviderCredentials;
  const leases = yield* RuntimeActivityLeaseManager;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const git = yield* GitCore;
  const serverSettings = yield* ServerSettingsService;
  const runtimeWorkspaceDiff = yield* RuntimeWorkspaceDiff;

  // Per-thread provisioning intent, stashed at plan/mark time and read at
  // provision time (the wrinkle: plan derivation precedes provisioning). Stands
  // in for a public `runtimePlan` until a later slice exposes one; the read-model
  // only carries the public provider literal.
  const threadIntents = new Map<string, ProvisionIntent>();
  // Maps a provisioned instance id to the provider that backs it, so `exec`,
  // `destroy`, and `probeInstance` resolve the right adapter.
  const instanceProviders = new Map<string, ExecutionRuntimeProvider>();
  // Fake-only: maps a provisioned instance id to its exact flavor for the
  // flavor-specific reconnect-capability probe.
  const instanceFakeFlavors = new Map<string, FakeRuntimeFlavor>();
  // Instances with a live transport (an in-flight turn) this process lifetime.
  // The reconciler reads this through `probeInstance().liveActivity` to skip
  // idle-destroy: stream output is not event-sourced, so `lastActivityAt` freezes
  // mid-conversation and would otherwise trip the idle threshold. Multiple
  // concurrent processes can share one instance, so it is reference-counted.
  const liveTransportCounts = new Map<string, number>();
  const retainLiveTransport = (instanceId: ExecutionInstanceId) => {
    const key = String(instanceId);
    liveTransportCounts.set(key, (liveTransportCounts.get(key) ?? 0) + 1);
  };
  const releaseLiveTransport = (instanceId: ExecutionInstanceId) => {
    const key = String(instanceId);
    const next = (liveTransportCounts.get(key) ?? 0) - 1;
    if (next <= 0) {
      liveTransportCounts.delete(key);
    } else {
      liveTransportCounts.set(key, next);
    }
  };

  const failProvision = (threadId: ThreadId, detail: string) =>
    new RuntimeProvisionFailedError({ threadId, detail });

  // Reject a non-`fake` provision that has no usable credentials before any
  // provider call (mirrors each provider's real-vs-fake gate). `fake`/`local`/
  // `worktree` need none and pass through. A credential-read failure is treated as
  // "not configured" so a misconfigured store fails closed rather than reaching a
  // provider with no key. Succeeds for an unconfigured provider with no error.
  const ensureCredentialsConfigured = (
    threadId: ThreadId,
    provider: ExecutionRuntimeProvider,
  ): Effect.Effect<void, MissingCredentialsError> => {
    const credentialed = asCredentialedProvider(provider);
    if (credentialed === null) {
      return Effect.void;
    }
    return credentials.credentialsConfigured(credentialed).pipe(
      Effect.orElseSucceed(() => false),
      Effect.flatMap((configured) =>
        configured ? Effect.void : Effect.fail(new MissingCredentialsError({ threadId, provider })),
      ),
    );
  };

  const dispatchRuntimeCommand = (
    threadId: ThreadId,
    suffix: string,
    build: (commandId: CommandId, createdAt: string) => Parameters<typeof engine.dispatch>[0],
  ) => {
    const commandId = runtimeCommandId(threadId, suffix);
    const createdAt = new Date().toISOString();
    return engine.dispatch(build(commandId, createdAt)).pipe(
      Effect.mapError((error) =>
        failProvision(threadId, `dispatch ${suffix} failed: ${error.message}`),
      ),
      Effect.asVoid,
    );
  };

  // A failed projection read is treated as "no runtime row": the thread falls
  // back to the local compat path rather than failing provisioning outright.
  const resolveThreadRuntime = (threadId: ThreadId) =>
    snapshotQuery.getThreadDetailById(threadId).pipe(
      Effect.map((option) => Option.getOrUndefined(option)),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  const recordProvisionRequest = (
    threadId: ThreadId,
    provider: ExecutionRuntimeProvider,
    role: RuntimeRole,
  ) =>
    dispatchRuntimeCommand(threadId, "provision", (commandId, createdAt) => ({
      type: "thread.runtime.provision",
      commandId,
      threadId,
      targetKind: "remote-runtime",
      provider,
      role,
      createdAt,
    }));

  const markThreadRemote: ExecutionRuntimeServiceShape["markThreadRemote"] = (input) =>
    Effect.gen(function* () {
      const role: RuntimeRole = input.role ?? "agent";
      threadIntents.set(input.threadId, {
        provider: "fake",
        plan: planForFlavor(input.flavor),
        fakeFlavor: input.flavor,
      });
      yield* recordProvisionRequest(input.threadId, "fake", role);
    });

  const applyRuntimePlan: ExecutionRuntimeServiceShape["applyRuntimePlan"] = (input) =>
    Effect.gen(function* () {
      const plan = input.plan;
      // No plan, or a local/worktree plan, keeps the existing compat path: no
      // validation, no provisioning, no intent.
      if (plan == null || plan.targetKind !== "remote-runtime") {
        return;
      }
      const role: RuntimeRole = input.role ?? "agent";
      // Honor the plan's provider. The fake family validates against a
      // flavor-keyed descriptor (the public `fake` provider hides its flavor);
      // every other provider validates against its provider-keyed descriptor. A
      // provider with no registered descriptor fails `RuntimeProviderUnsupportedError`
      // here, pre-provision, which is correct until that provider lands.
      const isFake = plan.provider === "fake";
      const fakeFlavor = isFake ? deriveFakeFlavor(plan) : undefined;
      const descriptor = isFake
        ? yield* registry.getDescriptorByFlavor(fakeFlavor as FakeRuntimeFlavor)
        : yield* registry.getDescriptor(plan.provider);
      yield* planner.validateAgainstDescriptor(plan, role, descriptor);
      // A descriptor-valid plan for a credentialed provider with no key still
      // cannot provision; reject it here, pre-provision, alongside plan validation.
      yield* ensureCredentialsConfigured(input.threadId, plan.provider);
      threadIntents.set(input.threadId, {
        provider: plan.provider,
        plan,
        ...(fakeFlavor !== undefined ? { fakeFlavor } : {}),
      });
      yield* recordProvisionRequest(input.threadId, plan.provider, role);
    });

  // Synthesize a provision intent when none was stashed this process lifetime (a
  // server restart between provision-request and provisioning). The read-model's
  // persisted provider is the source of truth: a `fake` row resumes the default
  // fake flavor; any other persisted provider resumes that provider's own plan, so
  // a remote thread does not silently downgrade to `fake` after a restart.
  const intentForMissing = (persistedProvider: ExecutionRuntimeProvider): ProvisionIntent => {
    if (persistedProvider === "fake") {
      return {
        provider: "fake",
        plan: planForFlavor(DEFAULT_FAKE_FLAVOR),
        fakeFlavor: DEFAULT_FAKE_FLAVOR,
      };
    }
    return {
      provider: persistedProvider,
      plan: {
        targetKind: "remote-runtime",
        provider: persistedProvider,
        ports: [],
        persistent: true,
        snapshotId: null,
      },
    };
  };

  // Derive a clone-target dir name from a repo URL (`.../synara.git` -> `synara`).
  // Falls back to a stable default so a malformed URL still clones somewhere.
  const repoDirNameFromUrl = (repoUrl: string): string => {
    const last = repoUrl.split(/[/\\]/).filter(Boolean).at(-1) ?? "workspace";
    const name = last.replace(/\.git$/i, "").trim();
    return name.length > 0 ? name : "workspace";
  };

  // Resolve the source repo to clone into a *real remote* instance so the agent
  // runs with its cwd inside the working tree. Reads the thread's project
  // workspaceRoot (the host local repo), its origin URL, and a host GitHub token,
  // then builds the tokenized clone URL. Returns `undefined` (skip cloning) when
  // the provider is `fake` (shares the host FS), the thread has no project repo,
  // or the host repo has no origin remote. Degrades to the clean URL when no token
  // resolves — a public repo clones fine, and a private repo surfaces git's own
  // actionable 403 through the adapter. Never logs the token.
  const resolveRepoSourceFor = (
    threadId: ThreadId,
    provider: ExecutionRuntimeProvider,
  ): Effect.Effect<ExecutionRuntimeRepoSource | undefined> =>
    Effect.gen(function* () {
      if (provider === "fake") {
        return undefined;
      }
      const thread = yield* resolveThreadRuntime(threadId);
      if (thread === undefined) {
        return undefined;
      }
      const project = Option.getOrUndefined(
        yield* snapshotQuery
          .getProjectShellById(thread.projectId)
          .pipe(Effect.catchCause(() => Effect.succeed(Option.none()))),
      );
      if (project === undefined) {
        return undefined;
      }
      const originUrl = yield* git
        .readConfigValue(project.workspaceRoot, "remote.origin.url")
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (originUrl === null || originUrl.trim().length === 0) {
        return undefined;
      }
      const repoUrl = originUrl.trim();
      // Prefer the thread's worktree branch, then its branch; default to "main"
      // (the clone's `checkout -B` creates it from HEAD if it is not on origin).
      const ref = thread.associatedWorktreeBranch?.trim() || thread.branch?.trim() || "main";
      const token = yield* resolveGitHubToken().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.orElseSucceed(() => null),
      );
      const tokenizedUrl = buildTokenizedRepoUrl(repoUrl, token);
      // Opt-in post-clone install. Read live so a Settings change applies on the
      // next provision; a failed read degrades to "" (off) rather than blocking.
      const postCloneCommand = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.sandboxes.postCloneCommand),
        Effect.orElseSucceed(() => ""),
      );
      return {
        repoUrl,
        ref,
        tokenizedUrl,
        targetSubdir: repoDirNameFromUrl(repoUrl),
        ...(postCloneCommand.trim().length > 0 ? { postCloneCommand } : {}),
      } satisfies ExecutionRuntimeRepoSource;
    });

  const provisionRemote = (
    threadId: ThreadId,
    targetKind: ExecutionTargetKind,
    persistedProvider: ExecutionRuntimeProvider,
  ): Effect.Effect<ResolvedExecutionTarget, RuntimeProvisionFailedError> =>
    Effect.gen(function* () {
      const intent = threadIntents.get(threadId) ?? intentForMissing(persistedProvider);
      // Reject a credentialed provider with no key before any provider call, even
      // on the restart-resume path where no plan was re-applied. Surfaced as a
      // provision failure so the reactor's single catch handles it unchanged.
      yield* ensureCredentialsConfigured(threadId, intent.provider).pipe(
        Effect.mapError((error) => failProvision(threadId, error.message)),
      );
      const adapter = yield* registry
        .getAdapter(intent.provider)
        .pipe(
          Effect.mapError((cause) => failProvision(threadId, `provision failed: ${cause.message}`)),
        );
      // Resolve the repo to clone into a real remote instance (skipped for `fake`,
      // a thread with no project repo, or a repo with no origin). Token resolution
      // and the host origin read never fail the provision: a missing repo source
      // just provisions an empty sandbox as before.
      const repoSource = yield* resolveRepoSourceFor(threadId, intent.provider).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const context = yield* adapter
        .provision({ threadId, plan: intent.plan, ...(repoSource ? { repoSource } : {}) })
        .pipe(
          Effect.mapError((cause) => failProvision(threadId, `provision failed: ${cause.message}`)),
        );
      instanceProviders.set(context.instance.id, intent.provider);
      if (intent.fakeFlavor !== undefined) {
        instanceFakeFlavors.set(context.instance.id, intent.fakeFlavor);
      }

      yield* dispatchRuntimeCommand(
        threadId,
        `instance.record.${context.instance.id}`,
        (commandId, createdAt) => ({
          type: "thread.runtime.instance.record",
          commandId,
          threadId,
          instanceId: context.instance.id,
          provider: intent.provider,
          status: "running",
          rootPath: context.rootPath,
          createdAt,
        }),
      );

      return {
        threadId,
        targetKind,
        cwd: context.rootPath,
        instanceId: context.instance.id,
      } satisfies ResolvedExecutionTarget;
    });

  // Best-effort re-injection of host-resolved agent credentials into a resumed
  // instance. Routes through the resolved adapter so the service stays
  // provider-agnostic; a provider that injects none (or one the registry cannot
  // resolve) is a silent no-op, and a failed rewrite never blocks the resume.
  const reinjectCredentials = (
    provider: ExecutionRuntimeProvider,
    instanceId: ExecutionInstanceId,
  ): Effect.Effect<void> =>
    registry.getAdapter(provider).pipe(
      Effect.flatMap((adapter) =>
        adapter.reinjectCredentials !== undefined
          ? adapter.reinjectCredentials(instanceId)
          : Effect.void,
      ),
      Effect.ignore,
    );

  const ensureTargetForThread: ExecutionRuntimeServiceShape["ensureTargetForThread"] = (
    threadId,
    hydratedRuntime,
  ) =>
    Effect.gen(function* () {
      // Reuse the caller's already-loaded runtime row when present (the reactor
      // hydrates it on the full thread detail it loads before turn start), so the
      // hot path does not pay a second full thread-detail query just to read the
      // nullable runtime row. `undefined` means the caller did not supply it.
      const runtime =
        hydratedRuntime !== undefined
          ? hydratedRuntime
          : ((yield* resolveThreadRuntime(threadId))?.runtime ?? null);
      const targetKind: ExecutionTargetKind = runtime?.targetKind ?? "local";

      // Compat path: local/worktree threads keep the reactor's existing cwd
      // resolution. No provisioning, no cwd override, no instance.
      if (targetKind !== "remote-runtime") {
        return {
          threadId,
          targetKind,
          cwd: undefined,
          instanceId: null,
        } satisfies ResolvedExecutionTarget;
      }

      // Reuse an already-running instance rather than re-provisioning.
      if (
        runtime?.instance !== null &&
        runtime?.instance !== undefined &&
        RUNNING_INSTANCE_STATUSES.has(runtime.instance.status)
      ) {
        const intent = threadIntents.get(threadId);
        instanceProviders.set(runtime.instance.id, runtime.instance.provider);
        if (intent?.fakeFlavor !== undefined) {
          instanceFakeFlavors.set(runtime.instance.id, intent.fakeFlavor);
        }
        // Resume path: refresh host-injected agent credentials before the next
        // turn. A token written at first provision may have expired while the
        // sandbox sat idle; the adapter rewrites a fresh one (no-op for providers
        // that inject none). Best-effort — a failed rewrite must not block resume.
        yield* reinjectCredentials(runtime.instance.provider, runtime.instance.id);
        return {
          threadId,
          targetKind,
          cwd: runtime.instance.rootPath ?? undefined,
          instanceId: runtime.instance.id,
        } satisfies ResolvedExecutionTarget;
      }

      // Use the read-model's persisted provider as the fallback intent when none
      // was stashed (restart between provision-request and provisioning), so the
      // remote thread resumes its real provider instead of downgrading to `fake`.
      const persistedProvider: ExecutionRuntimeProvider = runtime?.provider ?? "fake";
      return yield* provisionRemote(threadId, targetKind, persistedProvider);
    });

  // Keep a live turn's instance alive: take an activity lease and, while the
  // transport is open, renew it on a timer — routing the renew through the
  // adapter's `refreshActivity` so a provider that auto-stops an idle sandbox
  // (Daytona) does not tear it down under an active agent. Released on transport
  // exit. Provider-agnostic: a provider with no `refreshActivity` (fake) renews
  // only the in-memory lease, which is a harmless no-op for it. Best-effort
  // throughout — a failed renew never propagates to the turn.
  const startActivityKeepalive = (
    instanceId: ExecutionInstanceId,
    adapter: { readonly refreshActivity?: (id: ExecutionInstanceId) => Effect.Effect<void> },
    exit: Deferred.Deferred<ProcessExit>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const lease = yield* leases.acquire({ instanceId, reason: "turn" });
      retainLiveTransport(instanceId);

      const renewOnce = leases.renew(lease.id).pipe(
        Effect.flatMap(() =>
          adapter.refreshActivity !== undefined ? adapter.refreshActivity(instanceId) : Effect.void,
        ),
        Effect.ignore,
      );

      // Sleep, but wake immediately when the transport exits so the loop tears
      // down promptly instead of waiting out a full interval. `raceFirst` returns
      // whichever wins; the exit branch flips `transportLive` false to end the loop.
      const tick = Effect.raceFirst(
        Effect.sleep(Duration.millis(ACTIVITY_RENEW_INTERVAL_MS)).pipe(Effect.as(true as const)),
        Deferred.await(exit).pipe(Effect.as(false as const)),
      );

      const loop: Effect.Effect<void> = tick.pipe(
        Effect.flatMap((transportLive) =>
          transportLive ? renewOnce.pipe(Effect.flatMap(() => loop)) : Effect.void,
        ),
      );

      yield* loop.pipe(
        Effect.ensuring(
          Effect.sync(() => releaseLiveTransport(instanceId)).pipe(
            Effect.flatMap(() => leases.release(lease.id)),
          ),
        ),
        Effect.forkDetach,
        Effect.asVoid,
      );
    });

  const exec: ExecutionRuntimeServiceShape["exec"] = (input) =>
    Effect.gen(function* () {
      const provider = instanceProviders.get(input.instanceId);
      if (provider === undefined) {
        return yield* failProvision(
          input.threadId,
          `instance ${input.instanceId} is not a provisioned remote instance`,
        );
      }
      const adapter = yield* registry
        .getAdapter(provider)
        .pipe(
          Effect.mapError((cause) =>
            failProvision(input.threadId, `create transport failed: ${cause.message}`),
          ),
        );
      const processId = RuntimeProcessId.makeUnsafe(`proc-${crypto.randomUUID()}`);

      yield* dispatchRuntimeCommand(
        input.threadId,
        `process.start.${processId}`,
        (commandId, createdAt) => ({
          type: "thread.runtime.process.start",
          commandId,
          threadId: input.threadId,
          instanceId: input.instanceId,
          processId,
          role: input.role,
          command: input.command.trim().length > 0 ? input.command : null,
          createdAt,
        }),
      );

      const cwd = (yield* resolveThreadRuntime(input.threadId))?.runtime?.instance?.rootPath ?? ".";
      const built = yield* adapter
        .createTransport(input.instanceId, {
          command: input.command,
          args: input.args,
          cwd,
          env: input.env ?? {},
        })
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          // Transport creation failed after the process-start was recorded; close
          // the lifecycle so the row does not stay `running` forever.
          Effect.tapError(() =>
            dispatchRuntimeCommand(
              input.threadId,
              `process.complete.${processId}`,
              (commandId, createdAt) => ({
                type: "thread.runtime.process.complete",
                commandId,
                threadId: input.threadId,
                instanceId: input.instanceId,
                processId,
                status: "failed",
                exitCode: null,
                createdAt,
              }),
            ).pipe(Effect.ignore),
          ),
          Effect.mapError((cause) =>
            failProvision(input.threadId, `create transport failed: ${cause.message}`),
          ),
        );

      // Record completion + exit code when the process exits. Stream-only output
      // is not event-sourced (resolved decision #5); the lifecycle + exit is.
      yield* Effect.forkDetach(
        Deferred.await(built.transport.exit).pipe(
          Effect.flatMap((status) =>
            dispatchRuntimeCommand(
              input.threadId,
              `process.complete.${processId}`,
              (commandId, createdAt) => ({
                type: "thread.runtime.process.complete",
                commandId,
                threadId: input.threadId,
                instanceId: input.instanceId,
                processId,
                status: status.code === 0 || status.code === null ? "exited" : "failed",
                exitCode: status.code,
                createdAt,
              }),
            ),
          ),
          Effect.ignore,
        ),
      );

      // Hold the instance alive for the life of this transport: an activity lease
      // renewed on a timer through the adapter's keepalive, plus a live-transport
      // marker the reconciler reads to skip idle-destroy mid-conversation.
      yield* startActivityKeepalive(input.instanceId, adapter, built.transport.exit);

      return {
        processId,
        transport: built.transport,
        ...(built.controller !== undefined ? { controller: built.controller } : {}),
      };
    });

  // Read the sandbox working-tree diff for a remote thread. The caller passes the
  // instance's provider when it has it (the reactor reads it off the persisted
  // runtime row); otherwise fall back to the in-memory instance→provider map.
  // Delegates the registry-routed git to the standalone RuntimeWorkspaceDiff seam
  // so the diff logic lives in one place. Best-effort: an unresolvable provider
  // degrades to an empty-but-clean diff.
  const EMPTY_WORKSPACE_DIFF: ExecutionRuntimeWorkspaceDiff = { diff: "", changedPaths: [] };
  const workspaceDiff: ExecutionRuntimeServiceShape["workspaceDiff"] = (input) =>
    Effect.gen(function* () {
      const provider = input.provider ?? instanceProviders.get(input.instanceId);
      if (provider === undefined) {
        return EMPTY_WORKSPACE_DIFF;
      }
      return yield* runtimeWorkspaceDiff.read({
        instanceId: input.instanceId,
        provider,
        workdir: input.workdir,
      });
    });

  const destroy: ExecutionRuntimeServiceShape["destroy"] = (threadId, instanceId, knownProvider) =>
    Effect.gen(function* () {
      // The map is empty after a server restart, which is exactly when the
      // reconciler issues its destroy. Fall back to the provider the caller read
      // off the DB row so the adapter teardown still fires on a cold map.
      const provider = instanceProviders.get(instanceId) ?? knownProvider;
      if (provider !== undefined) {
        yield* registry.getAdapter(provider).pipe(
          Effect.flatMap((adapter) => adapter.destroy(instanceId)),
          Effect.ignore,
        );
      }
      instanceProviders.delete(instanceId);
      instanceFakeFlavors.delete(instanceId);
      threadIntents.delete(threadId);
      yield* dispatchRuntimeCommand(threadId, `destroy.${instanceId}`, (commandId, createdAt) => ({
        type: "thread.runtime.destroy",
        commandId,
        threadId,
        instanceId,
        createdAt,
      })).pipe(Effect.ignore);
    });

  // Resolve the adapter backing an instance, falling back to the caller-supplied
  // provider when the in-memory map is cold (server restart). Returns undefined
  // when neither source resolves a provider — the caller then records state only.
  const resolveInstanceAdapter = (
    instanceId: ExecutionInstanceId,
    knownProvider: ExecutionRuntimeProvider | undefined,
  ) =>
    Effect.gen(function* () {
      const provider = instanceProviders.get(instanceId) ?? knownProvider;
      if (provider === undefined) {
        return undefined;
      }
      return yield* registry.getAdapter(provider).pipe(Effect.orElseSucceed(() => undefined));
    });

  const stop: ExecutionRuntimeServiceShape["stop"] = (threadId, instanceId, knownProvider) =>
    Effect.gen(function* () {
      const adapter = yield* resolveInstanceAdapter(instanceId, knownProvider);
      if (adapter?.stop !== undefined) {
        yield* adapter.stop(instanceId).pipe(Effect.ignore);
      }
      // Record the stop regardless of provider support so the read-model converges
      // to `stopping`; an unsupported provider simply records the requested state.
      yield* dispatchRuntimeCommand(threadId, `stop.${instanceId}`, (commandId, createdAt) => ({
        type: "thread.runtime.stop",
        commandId,
        threadId,
        instanceId,
        createdAt,
      })).pipe(Effect.ignore);
    });

  const snapshot: ExecutionRuntimeServiceShape["snapshot"] = (
    threadId,
    instanceId,
    knownProvider,
  ) =>
    Effect.gen(function* () {
      const adapter = yield* resolveInstanceAdapter(instanceId, knownProvider);
      if (adapter?.snapshot === undefined) {
        // Unsupported provider: graceful no-op, no snapshot recorded.
        return;
      }
      const snapshotId = yield* adapter
        .snapshot(instanceId, null)
        .pipe(Effect.orElseSucceed(() => null));
      if (snapshotId === null) {
        return;
      }
      yield* dispatchRuntimeCommand(
        threadId,
        `snapshot.${instanceId}.${snapshotId}`,
        (commandId, createdAt) => ({
          type: "thread.runtime.snapshot",
          commandId,
          threadId,
          instanceId,
          snapshotId: RuntimeSnapshotId.makeUnsafe(snapshotId),
          createdAt,
        }),
      ).pipe(Effect.ignore);
    });

  // Resolve the reconnect capability for a fake instance. A flavor recorded in
  // the in-memory map (provisioned this process lifetime) gives the precise
  // descriptor; otherwise the family default is reconnect-capable, and liveness
  // (`isAlive`) decides the rest. Provider knowledge stays here, not the reactor.
  const resolveFakeReconnect = (instanceId: ExecutionInstanceId) =>
    Effect.gen(function* () {
      const flavor = instanceFakeFlavors.get(instanceId);
      if (flavor === undefined) {
        return true;
      }
      const descriptor = yield* registry
        .getDescriptorByFlavor(flavor)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      return descriptor?.capabilities.lifecycle.reconnect ?? true;
    });

  const probeInstance: ExecutionRuntimeServiceShape["probeInstance"] = (input) =>
    Effect.gen(function* () {
      const descriptor = yield* registry
        .getDescriptor(input.provider)
        .pipe(Effect.catch(() => Effect.succeed(undefined)));
      // The fake family resolves its reconnect capability from the exact recorded
      // flavor; every other provider reads it off the resolved descriptor.
      const supportsReconnect =
        input.provider === "fake"
          ? yield* resolveFakeReconnect(input.instanceId)
          : (descriptor?.capabilities.lifecycle.reconnect ?? false);
      // Probe liveness through the provider's registered adapter. A provider with
      // a descriptor but no adapter (validation-only wiring, or one not yet
      // registered) has nothing to probe, so it reports `absent` and the
      // reconciler marks it lost.
      const alive = yield* registry.getAdapter(input.provider).pipe(
        Effect.flatMap((adapter) => adapter.isAlive(input.instanceId)),
        Effect.orElseSucceed(() => false),
      );
      return {
        supportsReconnect,
        liveness: alive ? ("alive" as const) : ("absent" as const),
        // True while this process holds a live transport (an in-flight turn) for
        // the instance, so the reconciler skips idle-destroy under a live agent.
        liveActivity: (liveTransportCounts.get(String(input.instanceId)) ?? 0) > 0,
      };
    });

  const recordInstanceState: ExecutionRuntimeServiceShape["recordInstanceState"] = (input) =>
    dispatchRuntimeCommand(
      input.threadId,
      `state.${input.status}.${input.instanceId}`,
      (commandId, createdAt) => ({
        type: "thread.runtime.state.record",
        commandId,
        threadId: input.threadId,
        instanceId: input.instanceId,
        status: input.status,
        ...(input.failureReason !== undefined ? { failureReason: input.failureReason } : {}),
        createdAt,
      }),
    );

  return {
    markThreadRemote,
    applyRuntimePlan,
    ensureTargetForThread,
    exec,
    workspaceDiff,
    destroy,
    stop,
    snapshot,
    probeInstance,
    recordInstanceState,
  } satisfies ExecutionRuntimeServiceShape;
});

export const ExecutionRuntimeServiceLive = Layer.effect(
  ExecutionRuntimeService,
  makeExecutionRuntimeService,
);

export type { JsonRpcLineTransport };
