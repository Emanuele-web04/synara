// FILE: runtimePresentation.ts
// Purpose: Pure presentation helpers for the execution-runtime UI — labels for
// the header chip, runtime panel, and the environment picker's remote option,
// plus action availability. Reads the public runtime read-model only; action
// availability is computed here and dispatched via the `thread.runtime.action`
// client command from the chip/panel.
// Layer: Web UI logic (pure, unit-tested)

import {
  RuntimeSnapshotId,
  type ExecutionRuntimeProvider,
  type ExecutionTargetKind,
  type OrchestrationThreadRuntime,
  type RuntimeInstanceStatus,
  type RuntimePlan,
} from "@t3tools/contracts";

/** Display label for each execution target the UI offers at thread creation. */
export const EXECUTION_TARGET_LABELS: Record<ExecutionTargetKind, string> = {
  local: "Local",
  worktree: "Worktree",
  "remote-runtime": "Remote",
};

/** Display label for each runtime provider surfaced in the read-model. */
export const EXECUTION_RUNTIME_PROVIDER_LABELS: Record<ExecutionRuntimeProvider, string> = {
  local: "Local",
  worktree: "Worktree",
  fake: "Fake remote",
  daytona: "Daytona",
  "vercel-sandbox": "Vercel Sandbox",
  modal: "Modal",
  cloudflare: "Cloudflare",
};

/** Human label for each instance lifecycle status. */
export const RUNTIME_INSTANCE_STATUS_LABELS: Record<RuntimeInstanceStatus, string> = {
  pending: "Pending",
  provisioning: "Provisioning",
  starting: "Starting",
  running: "Running",
  idle: "Idle",
  stopping: "Stopping",
  stopped: "Stopped",
  snapshotting: "Snapshotting",
  archiving: "Archiving",
  archived: "Archived",
  destroying: "Destroying",
  destroyed: "Destroyed",
  failed: "Failed",
  lost: "Lost",
  unknown: "Unknown",
};

export type RuntimeStatusTone = "active" | "pending" | "idle" | "terminal" | "error";

const STATUS_TONE: Record<RuntimeInstanceStatus, RuntimeStatusTone> = {
  pending: "pending",
  provisioning: "pending",
  starting: "pending",
  running: "active",
  idle: "idle",
  stopping: "pending",
  stopped: "terminal",
  snapshotting: "pending",
  archiving: "pending",
  archived: "terminal",
  destroying: "pending",
  destroyed: "terminal",
  failed: "error",
  lost: "error",
  unknown: "idle",
};

export function resolveRuntimeStatusTone(status: RuntimeInstanceStatus): RuntimeStatusTone {
  return STATUS_TONE[status];
}

/** Whether a status is one of the terminal states (no further activity expected). */
export function isTerminalRuntimeStatus(status: RuntimeInstanceStatus): boolean {
  const tone = STATUS_TONE[status];
  return tone === "terminal";
}

export interface RuntimeHeaderPresentation {
  /** True for any non-local/worktree target — the only case worth showing in the header. */
  readonly show: boolean;
  readonly label: string;
  readonly detailLabel: string;
  readonly providerLabel: string;
  readonly statusLabel: string;
  readonly tone: RuntimeStatusTone;
  /** "Remote sandbox: <status> on <provider>". */
  readonly text: string;
}

/**
 * Resolve the header chip. Local/worktree threads keep the existing chrome and
 * show nothing here — the runtime chip is infra-only and remote-focused.
 */
export function resolveRuntimeHeaderPresentation(
  runtime: OrchestrationThreadRuntime | null | undefined,
): RuntimeHeaderPresentation {
  if (!runtime || runtime.targetKind !== "remote-runtime") {
    return {
      show: false,
      label: "",
      detailLabel: "",
      providerLabel: "",
      statusLabel: "",
      tone: "idle",
      text: "",
    };
  }
  const providerLabel = EXECUTION_RUNTIME_PROVIDER_LABELS[runtime.provider];
  const statusLabel = RUNTIME_INSTANCE_STATUS_LABELS[runtime.status];
  const detailLabel = `${statusLabel} on ${providerLabel}`;
  return {
    show: true,
    label: "Remote sandbox",
    detailLabel,
    providerLabel,
    statusLabel,
    tone: resolveRuntimeStatusTone(runtime.status),
    text: `Remote sandbox: ${detailLabel}`,
  };
}

export type RuntimeActionKind = "stop" | "destroy" | "snapshot" | "refresh";

export interface RuntimeActionAvailability {
  readonly kind: RuntimeActionKind;
  readonly enabled: boolean;
  /** When disabled, an honest reason the action cannot run yet. */
  readonly disabledReason: string | null;
}

// Stop/destroy/snapshot dispatch the `thread.runtime.action` client command,
// which the reactor routes to ExecutionRuntimeService. Each action is enabled
// only when a runtime instance is present (stop additionally requires a
// non-terminal instance). Refresh re-pulls the read-model snapshot the client
// already owns and is available whenever a runtime row exists.
export function resolveRuntimeActions(
  runtime: OrchestrationThreadRuntime | null | undefined,
): ReadonlyArray<RuntimeActionAvailability> {
  const hasInstance = Boolean(runtime?.instance);
  const terminal = runtime ? isTerminalRuntimeStatus(runtime.status) : true;
  const stoppable = hasInstance && !terminal;
  return [
    {
      kind: "stop",
      enabled: stoppable,
      disabledReason: stoppable
        ? null
        : hasInstance
          ? "Runtime instance is already stopped."
          : "No active runtime instance to stop.",
    },
    {
      kind: "destroy",
      enabled: hasInstance,
      disabledReason: hasInstance ? null : "No runtime instance to destroy.",
    },
    {
      kind: "snapshot",
      enabled: hasInstance,
      disabledReason: hasInstance ? null : "No runtime instance to snapshot.",
    },
    // Refresh is always available: it re-reads the snapshot the client can pull.
    { kind: "refresh", enabled: Boolean(runtime), disabledReason: runtime ? null : "No runtime." },
  ];
}

export const RUNTIME_ACTION_LABELS: Record<RuntimeActionKind, string> = {
  stop: "Stop",
  destroy: "Destroy",
  snapshot: "Snapshot",
  refresh: "Refresh",
};

/**
 * Per-draft-thread remote opt-in. The runtime knobs (provider, snapshot,
 * resources, ports, persistence) are workspace-level settings now, not per-thread
 * — so the only state a draft carries is whether Remote is chosen. The plan is
 * assembled from settings at create time via {@link buildRuntimePlanFromDefaults}.
 */
export interface RuntimePlanDraft {
  readonly enabled: boolean;
}

/** Remote-runtime providers the UI offers (excludes the local/worktree compat targets). */
export const REMOTE_RUNTIME_PROVIDERS: ReadonlyArray<ExecutionRuntimeProvider> = [
  "fake",
  "daytona",
  "vercel-sandbox",
  "modal",
  "cloudflare",
];

/**
 * Resolve the provider a freshly opted-in remote draft should default to. The
 * configured `sandboxDefaultRemoteProvider` setting wins when it names a real
 * remote provider; otherwise (unset, "no preference", or an unknown value) the
 * draft falls back to `fake`, the only provider that runs without credentials.
 */
export function resolveDefaultRemoteProvider(configuredProvider: string): ExecutionRuntimeProvider {
  const candidate = configuredProvider.trim();
  return REMOTE_RUNTIME_PROVIDERS.find((provider) => provider === candidate) ?? "fake";
}

export const DEFAULT_RUNTIME_PLAN_DRAFT: RuntimePlanDraft = { enabled: false };

/** Parse a free-text ports field ("3000, 8080") into a deduped positive-int list. */
export function parsePortsInput(input: string): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const token of input.split(/[\s,]+/)) {
    if (token.length === 0) {
      continue;
    }
    const value = Number(token);
    if (!Number.isInteger(value) || value <= 0 || value > 65535 || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** Parse one raw setting string into a positive integer, or null when unusable. */
function parsePositiveInt(value: string): number | null {
  const raw = value.trim();
  if (raw.length === 0) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The workspace-level remote-runtime defaults a new thread provisions with,
 * sourced from the Sandboxes settings. Fields are the raw setting strings (parsed
 * here) plus the already-resolved provider; `snapshotId` is the provider's
 * configured snapshot or null.
 */
export interface RuntimePlanDefaults {
  readonly provider: ExecutionRuntimeProvider;
  readonly snapshotId: string | null;
  readonly cpu: string;
  readonly memoryMb: string;
  readonly timeoutSeconds: string;
  readonly ports: string;
  /** "true" enables persistence; anything else (incl. blank) is off. */
  readonly persistent: string;
}

/**
 * Build the `RuntimePlan` input for `thread.create` from the configured Sandboxes
 * defaults. The caller invokes this only when the draft opted into Remote, so a
 * local/worktree thread keeps `runtimePlan` unset exactly as before.
 */
export function buildRuntimePlanFromDefaults(
  defaults: RuntimePlanDefaults,
  providerKind: RuntimePlan["providerKind"],
): RuntimePlan {
  const resources: { cpu?: number; memoryMb?: number } = {};
  const cpu = parsePositiveInt(defaults.cpu);
  const memoryMb = parsePositiveInt(defaults.memoryMb);
  if (cpu !== null) {
    resources.cpu = cpu;
  }
  if (memoryMb !== null) {
    resources.memoryMb = memoryMb;
  }
  const timeoutSeconds = parsePositiveInt(defaults.timeoutSeconds);
  const snapshot = defaults.snapshotId?.trim() ?? "";
  return {
    targetKind: "remote-runtime",
    provider: defaults.provider,
    ports: parsePortsInput(defaults.ports),
    persistent: defaults.persistent.trim() === "true",
    snapshotId: snapshot.length > 0 ? RuntimeSnapshotId.makeUnsafe(snapshot) : null,
    ...(Object.keys(resources).length > 0 ? { resources } : {}),
    ...(timeoutSeconds !== null ? { timeoutSeconds } : {}),
    ...(providerKind ? { providerKind } : {}),
  };
}
