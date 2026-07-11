// FILE: threadImport.ts
// Purpose: Builds exact provider-instance targets for existing-thread imports.
// Layer: Web orchestration helper

import type {
  ProviderComposerCapabilities,
  ProviderInstanceId,
  ProviderKind,
} from "@synara/contracts";

import type { ProviderInstanceOption } from "../appSettings";

export type ThreadImportProviderKind = Extract<
  ProviderKind,
  "codex" | "claudeAgent" | "cursor" | "kilo" | "opencode"
>;

export interface ThreadImportTarget {
  readonly provider: ThreadImportProviderKind;
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
}

function supportsThreadImportProvider(
  provider: ProviderKind,
): provider is ThreadImportProviderKind {
  return (
    provider === "codex" ||
    provider === "claudeAgent" ||
    provider === "cursor" ||
    provider === "kilo" ||
    provider === "opencode"
  );
}

export function buildThreadImportCandidates(
  instances: ReadonlyArray<ProviderInstanceOption>,
): ThreadImportTarget[] {
  return instances.flatMap((instance) =>
    instance.enabled && supportsThreadImportProvider(instance.provider)
      ? [
          {
            provider: instance.provider,
            instanceId: instance.instanceId,
            label: instance.label,
          },
        ]
      : [],
  );
}

export function filterThreadImportTargetsByCapabilities(
  candidates: ReadonlyArray<ThreadImportTarget>,
  capabilities: ReadonlyArray<ProviderComposerCapabilities | undefined>,
): ThreadImportTarget[] {
  return candidates.filter(
    (_candidate, index) => capabilities[index]?.supportsThreadImport === true,
  );
}
