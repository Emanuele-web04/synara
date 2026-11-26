// FILE: InlineVisual.tsx
// Purpose: One agent-published inline visual, drawn the way it was published: a component
//          spec with the app's own components, or an HTML document in a sandboxed frame.
// Layer: Chat transcript row content
// Exports: InlineVisual

import type { InlineVisualActivityPayload, ThreadId } from "@synara/contracts";

import { InlineVisualBlocks, type InlineVisualBlocksActions } from "./InlineVisualBlocks";
import { InlineVisualFrame } from "./InlineVisualFrame";

export function InlineVisual({
  threadId,
  visual,
  actions,
  onScrollIntent,
}: {
  readonly threadId: ThreadId;
  readonly visual: InlineVisualActivityPayload;
  readonly actions: InlineVisualBlocksActions;
  readonly onScrollIntent?: ((upward: boolean) => void) | undefined;
}) {
  return visual.format === "components" ? (
    <InlineVisualBlocks threadId={threadId} visual={visual} actions={actions} />
  ) : (
    <InlineVisualFrame threadId={threadId} visual={visual} onScrollIntent={onScrollIntent} />
  );
}
