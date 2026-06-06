import { Schema } from "effect";

/**
 * `ProviderKind` and its policy literals live here, separate from
 * `orchestration.ts`, so schema-only modules (`executionRuntime.ts`,
 * `model.ts`) can reference the runtime value without forming an import cycle
 * with the large orchestration module. `orchestration.ts` re-exports these to
 * preserve the existing public import surface.
 */
export const ProviderKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "kilo",
  "opencode",
  "pi",
]);
export type ProviderKind = typeof ProviderKind.Type;

export const DEFAULT_PROVIDER_KIND: ProviderKind = "codex";

export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;

export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;
