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
import { DAYTONA_RUNTIME_DESCRIPTOR } from "./executionRuntime/providers/daytona/descriptor";
import { makeDaytonaRuntimeAdapterLayer } from "./executionRuntime/providers/daytona/runtimeLayer";
import { VERCEL_SANDBOX_DESCRIPTOR } from "./executionRuntime/providers/vercelSandbox/descriptor";
import { makeVercelSandboxRuntimeAdapterLayer } from "./executionRuntime/providers/vercelSandbox/runtimeLayer";
import { MODAL_PROVIDER_DESCRIPTOR } from "./executionRuntime/providers/modal/modalDescriptors";
import { makeModalRuntimeAdapterLayer } from "./executionRuntime/providers/modal/runtimeLayer";
import { RuntimeActivityLeaseManagerLive } from "./executionRuntime/Layers/RuntimeActivityLeaseManager";
import { RuntimeCredentialBrokerLive } from "./executionRuntime/Layers/RuntimeCredentialBroker";
import { RuntimeGitWorkspaceLive } from "./executionRuntime/Layers/RuntimeGitWorkspace";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer";

import { KeybindingsLive } from "./keybindings";
import { GitCoreLive } from "./git/Layers/GitCore";
import { GitLayerLive, TextGenerationLayerLive } from "./git/runtimeLayer";
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
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment";

export { makeServerProviderLayer } from "./provider/runtimeLayer";

export function makeServerRuntimeServicesLayer() {
  const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(GitCoreLive));

  const checkpointDiffQueryLayer = CheckpointDiffQueryLive.pipe(
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(checkpointStoreLayer),
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
  // The execution-runtime service resolves/provisions where a thread runs before
  // the provider session starts. It routes provisioning/exec/teardown through an
  // adapter resolved by provider from the registry; the service itself needs
  // ChildProcessSpawner (from NodeServices below). Engine + snapshot query come
  // from runtimeServicesLayer. The registry holds the descriptors the planner
  // validates a public `runtimePlan` against (fake flavors included) plus the
  // `fake` provider's lifecycle adapter; its fake adapter needs FileSystem from
  // NodeServices.
  // The Daytona adapter env-selects its real REST client vs the in-repo fake
  // client (local temp dirs): with `DAYTONA_API_KEY` present the real client is
  // used, else the fake, so the server boots without provider access. The adapter
  // resolves through the registry by the `daytona` provider literal.
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
  const runtimeProviderRegistryLayer = makeRuntimeProviderRegistryWithAdaptersLive({
    descriptors: [
      ...BUILT_IN_RUNTIME_DESCRIPTORS,
      ...FAKE_RUNTIME_DESCRIPTORS,
      DAYTONA_RUNTIME_DESCRIPTOR,
      VERCEL_SANDBOX_DESCRIPTOR,
      MODAL_PROVIDER_DESCRIPTOR,
    ],
  }).pipe(
    Layer.provide(FakeRuntimeProviderAdapterLive),
    Layer.provide(daytonaRuntimeAdapterLayer),
    Layer.provide(vercelSandboxRuntimeAdapterLayer),
    Layer.provide(modalRuntimeAdapterLayer),
  );
  const executionRuntimePlannerLayer = ExecutionRuntimePlannerLive.pipe(
    Layer.provide(runtimeProviderRegistryLayer),
  );
  const executionRuntimeServiceLayer = ExecutionRuntimeServiceLive.pipe(
    Layer.provide(executionRuntimePlannerLayer),
    Layer.provide(runtimeProviderRegistryLayer),
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
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
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
    TerminalLayerLive,
    KeybindingsLive,
    ServerSettingsLive,
    ServerEnvironmentLive,
    authServicesLayer,
    ServerLifecycleEventsLive,
    ServerRuntimeStartupLive,
    WorkspaceLayerLive,
    ProjectFaviconResolverLive,
  ).pipe(Layer.provideMerge(NodeServices.layer), Layer.provideMerge(FetchHttpClient.layer));
}
