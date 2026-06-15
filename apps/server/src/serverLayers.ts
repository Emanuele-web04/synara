import * as NodeServices from "@effect/platform-node/NodeServices";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore";
import { ExecutionRuntimePlannerLive } from "./executionRuntime/Layers/ExecutionRuntimePlanner";
import { ExecutionRuntimeReconcilerLive } from "./executionRuntime/Layers/ExecutionRuntimeReconciler";
import { ExecutionRuntimeServiceLive } from "./executionRuntime/Layers/ExecutionRuntimeService";
import { FAKE_RUNTIME_DESCRIPTORS } from "./executionRuntime/Layers/fakeDescriptors";
import { FakeRuntimeProviderAdapterLive } from "./executionRuntime/Layers/FakeRuntimeProviderAdapter";
import { BUILT_IN_RUNTIME_DESCRIPTORS } from "./executionRuntime/Layers/descriptors";
import { makeRuntimeProviderRegistryWithAdaptersLive } from "./executionRuntime/Layers/RuntimeProviderRegistry";
import { CodexMcpPluginSourceLive } from "./executionRuntime/Layers/CodexMcpPluginSource";
import { DAYTONA_RUNTIME_DESCRIPTOR } from "./executionRuntime/providers/daytona/descriptor";
import { makeDaytonaRuntimeAdapterLayer } from "./executionRuntime/providers/daytona/runtimeLayer";
import { VERCEL_SANDBOX_DESCRIPTOR } from "./executionRuntime/providers/vercelSandbox/descriptor";
import { makeVercelSandboxRuntimeAdapterLayer } from "./executionRuntime/providers/vercelSandbox/runtimeLayer";
import { MODAL_PROVIDER_DESCRIPTOR } from "./executionRuntime/providers/modal/modalDescriptors";
import { makeModalRuntimeAdapterLayer } from "./executionRuntime/providers/modal/runtimeLayer";
import { CLOUDFLARE_RUNTIME_DESCRIPTOR } from "./executionRuntime/Layers/cloudflareDescriptor";
import { makeCloudflareRuntimeAdapterLayer } from "./executionRuntime/Layers/CloudflareRuntimeProviderFacadeLayer";
import { RuntimeActivityLeaseManagerLive } from "./executionRuntime/Layers/RuntimeActivityLeaseManager";
import { RuntimeWorkspaceDiffLive } from "./executionRuntime/Layers/RuntimeWorkspaceDiff";
import { RuntimeCredentialBrokerLive } from "./executionRuntime/Layers/RuntimeCredentialBroker";
import { RuntimeProviderCredentialsLive } from "./executionRuntime/Layers/RuntimeProviderCredentials";
import { SandboxSecretWriterLive } from "./executionRuntime/Layers/SandboxSecretWriter";
import { RuntimeGitWorkspaceLive } from "./executionRuntime/Layers/RuntimeGitWorkspace";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer";

import { DevServerManagerLive } from "./devServerManager";
import { KeybindingsLive } from "./keybindings";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitLayerLive, TextGenerationLayerLive } from "./git/runtimeLayer";
import { ReviewLayerLive } from "./review/runtimeLayer";
import { TerminalLayerLive } from "./terminal/runtimeLayer";
import { AuthControlPlaneLive } from "./auth/Layers/AuthControlPlane";
import { BootstrapCredentialServiceLive } from "./auth/Layers/BootstrapCredentialService";
import { ServerAuthLive } from "./auth/Layers/ServerAuth";
import { ServerAuthPolicyLive } from "./auth/Layers/ServerAuthPolicy";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { SessionCredentialServiceLive } from "./auth/Layers/SessionCredentialService";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import { ServerRuntimeStartupLive } from "./serverRuntimeStartup";
import { ServerSettingsLive } from "./serverSettings";
import { WorkspaceLayerLive } from "./workspace/runtimeLayer";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver";
import { ProfileStatsQueryLive } from "./profileStats";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment";

export { makeServerProviderLayer } from "./provider/runtimeLayer";

export function makeServerRuntimeServicesLayer() {
  const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(GitCoreLive));

  // The execution-runtime service resolves/provisions where a thread runs before
  // the provider session starts. It routes provisioning/exec/teardown through an
  // adapter resolved by provider from the registry; the service itself needs
  // ChildProcessSpawner (from NodeServices below). The registry holds the
  // descriptors the planner validates a public `runtimePlan` against (fake
  // flavors included) plus the `fake` provider's lifecycle adapter; its fake
  // adapter needs FileSystem from NodeServices. The registry/adapters are built
  // here (before the checkpoint diff query) so the remote workspace-diff seam,
  // which both that query and the execution-runtime service consume, can route
  // git through the provider adapters without a layer cycle.
  // The Daytona adapter env-selects its real REST client vs the in-repo fake
  // client (local temp dirs) per provision: with `DAYTONA_API_KEY` present the
  // real client is used, else the fake, so the server boots without provider
  // access and a key saved in Settings takes effect on the next provision with no
  // restart. The adapter resolves through the registry by the `daytona` literal.
  const daytonaRuntimeAdapterLayer = makeDaytonaRuntimeAdapterLayer();
  // The Vercel Sandbox adapter env-selects its real client vs the in-repo fake
  // client (temp dirs + local processes): with the `VERCEL_*` credentials present
  // the real client is used, else the fake, so the server boots without provider
  // access. The adapter resolves by the `vercel-sandbox` provider literal.
  const vercelSandboxRuntimeAdapterLayer = makeVercelSandboxRuntimeAdapterLayer();
  // The Modal adapter env-selects the real Modal CLI backend vs the in-repo fake
  // backend (temp dirs + local processes): with `MODAL_TOKEN_ID`/
  // `MODAL_TOKEN_SECRET` present the real backend is used, else the fake, so the
  // server boots without provider access. The facade derives the Modal role from
  // the plan, and the adapter resolves by the `modal` provider literal. The
  // registry binds the broadest `service`-shaped descriptor for `modal`.
  const modalRuntimeAdapterLayer = makeModalRuntimeAdapterLayer();
  // The Cloudflare adapter env-selects the real bridge connection (HTTP/WS to the
  // Runtime Bridge Worker) vs the in-process fake bridge: with
  // `SYNARA_CLOUDFLARE_BRIDGE_URL` + `SYNARA_CLOUDFLARE_BRIDGE_TOKEN` present the
  // real connection is used, else the fake, so the server boots without provider
  // access. The adapter resolves by the `cloudflare` provider literal; the
  // registry binds the broadest `workspace`-shaped descriptor for `cloudflare`.
  const cloudflareRuntimeAdapterLayer = makeCloudflareRuntimeAdapterLayer();
  // Each real adapter resolves its real-vs-fake client from the merged credential
  // env (settings + stored secrets over `process.env`) through this service. The
  // service reads ServerSettings live and pulls secret tokens from
  // ServerSecretStore by name. Daytona re-reads it per provision, so a key entered
  // in Settings takes effect on the next provision with no restart; the other
  // providers still resolve once at layer build (their per-provision migration is
  // a later slice), taking effect on the next server start.
  const runtimeProviderCredentialsLayer = RuntimeProviderCredentialsLive.pipe(
    Layer.provide(ServerSettingsLive),
    Layer.provide(ServerSecretStoreLive),
  );
  // The Daytona adapter inherits the operator's HTTP MCP servers ("plugins") into
  // a remote sandbox when the opt-in `syncMcpPlugins` setting is on. This source
  // reads that setting and the host config live, so a change applies on the next
  // provision/resume with no restart, the same way the credential overlay does.
  const codexMcpPluginSourceLayer = CodexMcpPluginSourceLive.pipe(
    Layer.provide(ServerSettingsLive),
  );
  const runtimeProviderRegistryLayer = makeRuntimeProviderRegistryWithAdaptersLive({
    descriptors: [
      ...BUILT_IN_RUNTIME_DESCRIPTORS,
      ...FAKE_RUNTIME_DESCRIPTORS,
      DAYTONA_RUNTIME_DESCRIPTOR,
      VERCEL_SANDBOX_DESCRIPTOR,
      MODAL_PROVIDER_DESCRIPTOR,
      CLOUDFLARE_RUNTIME_DESCRIPTOR,
    ],
  }).pipe(
    Layer.provide(FakeRuntimeProviderAdapterLive),
    Layer.provide(daytonaRuntimeAdapterLayer),
    Layer.provide(vercelSandboxRuntimeAdapterLayer),
    Layer.provide(modalRuntimeAdapterLayer),
    Layer.provide(cloudflareRuntimeAdapterLayer),
    Layer.provide(runtimeProviderCredentialsLayer),
    Layer.provide(codexMcpPluginSourceLayer),
  );
  // Provider-agnostic remote working-tree diff: routes `git` inside an instance
  // through the provider's exec channel (resolved by provider from the registry).
  // Depends only on the registry, so both the checkpoint diff query and the
  // execution-runtime service can consume it without a layer cycle.
  const runtimeWorkspaceDiffLayer = RuntimeWorkspaceDiffLive.pipe(
    Layer.provide(runtimeProviderRegistryLayer),
  );

  // Built after the registry/workspace-diff so a remote thread's Review diff can
  // be sourced from its sandbox instead of the host CheckpointStore.
  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(checkpointStoreLayer),
    Layer.provideMerge(runtimeWorkspaceDiffLayer),
  );

  const runtimeServicesLayer = Layer.mergeAll(
    OrchestrationLayerLive,
    checkpointStoreLayer,
    checkpointDiffQueryLayer,
    RuntimeReceiptBusLive,
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );

  const executionRuntimePlannerLayer = ExecutionRuntimePlannerLive.pipe(
    Layer.provide(runtimeProviderRegistryLayer),
  );
  const executionRuntimeServiceLayer = ExecutionRuntimeServiceLive.pipe(
    Layer.provide(executionRuntimePlannerLayer),
    Layer.provide(runtimeProviderRegistryLayer),
    // The service runs the missing-creds preflight through this same per-provision
    // credential service, so a Settings change is honored without a restart.
    Layer.provide(runtimeProviderCredentialsLayer),
    // Host-side git for resolving the project repo's origin URL when cloning it
    // into a real remote instance during provision.
    Layer.provide(GitCoreLive),
    // Read live so the opt-in post-clone install setting applies on the next
    // provision with no restart, the same way the credential overlay does.
    Layer.provide(ServerSettingsLive),
    // The activity-lease keepalive: `exec` acquires a lease and renews it on a
    // timer (routed through the adapter's keepalive) while a turn's transport is
    // alive. Leases live and die inside `exec`, so a service-local instance is
    // self-contained; the published one in runtimeRemoteConcernsLayer serves any
    // external resolver.
    Layer.provide(RuntimeActivityLeaseManagerLive),
    // The remote workspace-diff seam, shared with the checkpoint diff query, so
    // the service's `workspaceDiff` routes git through the provider adapters.
    Layer.provide(runtimeWorkspaceDiffLayer),
    Layer.provideMerge(runtimeServicesLayer),
  );
  // Cross-cutting remote concerns: runtime-neutral git over the exec channel,
  // activity leases, and the credential broker. Git rides the fake adapter's
  // command-exec primitive; leases and the broker are in-memory v1 bookkeeping.
  const runtimeRemoteConcernsLayer = Layer.mergeAll(
    RuntimeGitWorkspaceLive.pipe(Layer.provide(FakeRuntimeProviderAdapterLive)),
    RuntimeActivityLeaseManagerLive,
    RuntimeCredentialBrokerLive,
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(executionRuntimeServiceLayer),
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(GitCoreLive),
    Layer.provideMerge(TextGenerationLayerLive),
    Layer.provideMerge(ServerSettingsLive),
  );
  // The reconciler recovers remote runtimes from partial failure on startup and
  // on a schedule. It needs the operational instance repository (from the runtime
  // services layer) plus the provider-agnostic execution-runtime seam to probe
  // and converge state.
  const executionRuntimeReconcilerLayer = ExecutionRuntimeReconcilerLive.pipe(
    Layer.provideMerge(executionRuntimeServiceLayer),
    Layer.provideMerge(runtimeServicesLayer),
  );
  // The reactor routes a remote thread's turn diff to its sandbox through the
  // execution-runtime seam; local/worktree threads keep the host CheckpointStore
  // path unchanged.
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(executionRuntimeServiceLayer),
    Layer.provideMerge(runtimeServicesLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
  );
  const threadDeletionReactorLayer = ThreadDeletionReactorLive.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(TerminalLayerLive),
  );
  const sessionCredentialLayer = SessionCredentialServiceLive.pipe(
    Layer.provide(ServerSecretStoreLive),
  );
  const authControlPlaneLayer = AuthControlPlaneLive.pipe(
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionCredentialLayer),
  );
  const serverAuthLayer = ServerAuthLive.pipe(
    Layer.provide(ServerAuthPolicyLive),
    Layer.provide(BootstrapCredentialServiceLive),
    Layer.provide(sessionCredentialLayer),
    Layer.provide(authControlPlaneLayer),
  );
  const authServicesLayer = Layer.mergeAll(
    ServerAuthPolicyLive,
    ServerSecretStoreLive,
    BootstrapCredentialServiceLive,
    sessionCredentialLayer,
    authControlPlaneLayer,
    serverAuthLayer,
  );

  return Layer.mergeAll(
    orchestrationReactorLayer,
    threadDeletionReactorLayer,
    executionRuntimeReconcilerLayer,
    runtimeRemoteConcernsLayer,
    GitLayerLive,
    TextGenerationLayerLive,
    ReviewLayerLive,
    TerminalLayerLive,
    KeybindingsLive,
    ServerSettingsLive,
    ServerEnvironmentLive,
    SandboxSecretWriterLive.pipe(Layer.provide(ServerSecretStoreLive)),
    authServicesLayer,
    ServerLifecycleEventsLive,
    ServerRuntimeStartupLive,
    ProfileStatsQueryLive,
    DevServerManagerLive.pipe(Layer.provide(TerminalLayerLive)),
    WorkspaceLayerLive,
    ProjectFaviconResolverLive,
  ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));
}
