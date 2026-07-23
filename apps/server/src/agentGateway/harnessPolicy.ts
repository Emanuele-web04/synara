import type { ProviderKind } from "@synara/contracts";

import { AUTOMATION_AUTHORING_GUIDANCE } from "./automationAuthoringGuidance.ts";

/** Canonical, versioned host policy delivered to every supported provider. */
export const SYNARA_HARNESS_POLICY_VERSION = "2026-07-23.5";
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
        "For thread discovery and diagnosis, use synara_list_threads, synara_read_thread, synara_read_thread_activity, synara_read_thread_events, synara_read_thread_runtime_events, and synara_diagnose_thread before inspecting Synara's SQLite files or process logs. Fall back to host storage only when a tool's coverage metadata says the required evidence is unavailable.",
        "Provider-native subagent or Task tools are implementation details: they do not create Synara threads and must not substitute for an explicit request to create Synara threads.",
        "For a plural thread request, submit one exact synara_create_threads plan. The array length is the exact requested count.",
        "If synara_create_threads rejects the plan during validation or preflight before returning an operationId, correct that same plan and retry it with the same requestId. This is safe because no durable operation, thread, or worktree was created.",
        "Use synara_capabilities to select canonical provider, model, and option values. Never guess a model slug or silently substitute a provider or model.",
        "Provider option keys are not interchangeable: Codex uses options.reasoningEffort and Claude Agent uses options.effort. Follow synara_capabilities.targetConstruction for every provider instead of inspecting Synara source code.",
        "When results are requested, call synara_wait_for_threads for the created thread ids, wait for every requested result, then synthesize all outcomes.",
        "After synara_create_threads returns an operationId, retries must keep the same requestId and exact plan. Report terminal operation failures as outcomes; do not create replacement threads unless the user gives a new instruction.",
        "Synara automations support heartbeat and standalone modes plus interval, once, daily, weekdays, weekly, and cron schedules. Existing everyMinutes heartbeat calls remain supported. Use fastInterval: true only when the user explicitly accepts a sub-minute bounded loop.",
        AUTOMATION_AUTHORING_GUIDANCE,
        "Prefer synara_create_automation with suggested: true when the user has not explicitly asked to create an automation. Suggested automations remain disabled until the user accepts their proposal card.",
        "Before synara_update_automation, call synara_view_automation and resend the complete mutable configuration, including unchanged fields. Updates are full replacement and partial payloads are rejected.",
        'Automation-dispatched turns receive an identity/run/memory envelope. Persist durable context with synara_update_automation_memory {"memory": "..."} before finishing; memory is full replacement, DB-backed, and capped at 32 KiB.',
        'Every automation-dispatched turn must finish by calling synara_report_automation_result. Use decision "silent" only for a successful run with nothing requiring user attention; otherwise use "notify" with a concise title and summary. Failures remain visible regardless of this decision or the automation notification policy.',
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
  "opencode",
  "kilo",
  "pi",
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
 * Provider-aware delivery guard. The transport flag must only become true
 * after a provider has installed thread-scoped gateway tools successfully.
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
