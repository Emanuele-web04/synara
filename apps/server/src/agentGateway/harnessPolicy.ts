import type { ProviderKind } from "@synara/contracts";

/** Canonical, versioned host policy delivered to every supported provider. */
export const SYNARA_HARNESS_POLICY_VERSION = "2026-07-16.2";
export const SYNARA_HARNESS_POLICY_MARKER = `[Synara harness policy ${SYNARA_HARNESS_POLICY_VERSION}]`;

export interface SynaraHarnessCapabilities {
  readonly gatewayControlAvailable: boolean;
}

/**
 * Render one truthful policy. Providers without a safely thread-scoped MCP
 * connection still receive host identity, but are never told they can mutate
 * Synara resources.
 */
export function renderSynaraHarnessPolicy(capabilities: SynaraHarnessCapabilities): string {
  const controlPolicy = capabilities.gatewayControlAvailable
    ? [
        "Use the synara_* tools for Synara threads, projects, automations, and coordination.",
        "Provider-native subagent or Task tools are implementation details: they do not create Synara threads and must not substitute for an explicit request to create Synara threads.",
        "For a plural thread request, call synara_create_threads exactly once. The array length is the exact requested count.",
        "Use synara_capabilities to select canonical provider, model, and option values. Never guess a model slug or silently substitute a provider or model.",
        "Provider option keys are not interchangeable: Codex uses options.reasoningEffort and Claude Agent uses options.effort. Follow synara_capabilities.targetConstruction for every provider instead of inspecting Synara source code.",
        "When results are requested, call synara_wait_for_threads for the created thread ids, wait for every requested result, then synthesize all outcomes.",
        "Report failures as outcomes. Do not create replacement threads unless the user gives a new instruction to do so.",
      ]
    : [
        "Synara MCP control is unavailable in this provider session. Do not claim that Synara threads, projects, or automations were created or changed.",
        "Provider-native subagent or Task tools do not create Synara threads. If the user explicitly requests Synara resource management, explain that this session cannot perform it.",
      ];

  return [
    SYNARA_HARNESS_POLICY_MARKER,
    "You are running inside Synara. Synara is the host and harness for this session.",
    ...controlPolicy,
  ].join("\n");
}

export const SYNARA_GATEWAY_HARNESS_POLICY = renderSynaraHarnessPolicy({
  gatewayControlAvailable: true,
});

export const SYNARA_IDENTITY_ONLY_HARNESS_POLICY = renderSynaraHarnessPolicy({
  gatewayControlAvailable: false,
});

export interface SynaraHarnessPolicyDeliveryState {
  harnessPolicyDelivered?: boolean;
}

const PROVIDERS_WITH_THREAD_SCOPED_SYNARA_MCP = new Set<ProviderKind>([
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "droid",
]);

export function providerHasSynaraGatewayControl(input: {
  readonly provider: ProviderKind;
  readonly scopedGatewayConnectionAvailable: boolean;
}): boolean {
  return (
    input.scopedGatewayConnectionAvailable &&
    PROVIDERS_WITH_THREAD_SCOPED_SYNARA_MCP.has(input.provider)
  );
}

/** Return the private host-context block exactly once for one provider session. */
export function takeSynaraHarnessPolicyForSession(
  state: SynaraHarnessPolicyDeliveryState,
  capabilities: SynaraHarnessCapabilities,
): string | null {
  if (state.harnessPolicyDelivered === true) return null;
  state.harnessPolicyDelivered = true;
  return [
    "<synara_host_context>",
    renderSynaraHarnessPolicy(capabilities),
    "</synara_host_context>",
  ].join("\n");
}

/**
 * Provider-aware delivery guard. Pooled OpenCode/Kilo runtimes and Pi can
 * never accidentally advertise Synara mutations even if a future call site
 * passes a truthy transport flag.
 */
export function takeSynaraHarnessPolicyForProviderSession(
  state: SynaraHarnessPolicyDeliveryState,
  input: {
    readonly provider: ProviderKind;
    readonly scopedGatewayConnectionAvailable: boolean;
  },
): string | null {
  return takeSynaraHarnessPolicyForSession(state, {
    gatewayControlAvailable: providerHasSynaraGatewayControl(input),
  });
}

export function takeSynaraHarnessPolicyTextPartForProviderSession(
  state: SynaraHarnessPolicyDeliveryState,
  input: {
    readonly provider: ProviderKind;
    readonly scopedGatewayConnectionAvailable: boolean;
  },
): { readonly type: "text"; readonly text: string } | null {
  const text = takeSynaraHarnessPolicyForProviderSession(state, input);
  return text === null ? null : { type: "text", text };
}
