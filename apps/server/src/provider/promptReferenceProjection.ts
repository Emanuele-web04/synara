// FILE: promptReferenceProjection.ts
// Purpose: Projects structured composer references for providers without native mention input items.
// Layer: Provider prompt compatibility
// Exports: appendProviderReferencesPromptBlock.

import type { ProviderMentionReference } from "@synara/contracts";

function referenceLine(reference: ProviderMentionReference): string {
  const kind = reference.path.startsWith("plugin://") ? "Factory plugin" : "local path";
  return `- ${kind}: ${JSON.stringify({ name: reference.name, path: reference.path })}`;
}

/** Keeps selected plugin/path chips meaningful when ACP accepts text and images only. */
export function appendProviderReferencesPromptBlock(input: {
  readonly text: string | undefined;
  readonly mentions: ReadonlyArray<ProviderMentionReference> | undefined;
}): string | undefined {
  if (!input.mentions || input.mentions.length === 0) {
    return input.text;
  }
  const block = [
    "<selected_provider_references>",
    "The user explicitly selected these references. Droid manages enabled Factory plugin components natively; prefer the selected plugin's skills, commands, agents, or tools when they are available and relevant. Read local paths with your filesystem tools as needed.",
    ...input.mentions.map(referenceLine),
    "</selected_provider_references>",
  ].join("\n");
  return input.text ? `${input.text}\n\n${block}` : block;
}
