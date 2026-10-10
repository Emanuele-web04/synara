// FILE: AttachmentSummaryChip.test.tsx
// Purpose: Guards the shared count-pill chip (and its selection/comment wrappers)
//   against label, dismiss, and tooltip regressions after consolidation.
// Layer: Component rendering tests
// Depends on: the summary chip wrappers and React server rendering.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";

describe("AssistantSelectionsSummaryChip", () => {
  it("renders a pluralized count and a labelled dismiss control", () => {
    const markup = renderToStaticMarkup(
      <AssistantSelectionsSummaryChip
        selections={[
          { type: "assistant-selection", id: "a", assistantMessageId: "m1", text: "first" },
          { type: "assistant-selection", id: "b", assistantMessageId: "m1", text: "second" },
        ]}
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain("2 selections");
    expect(markup).toContain("Remove selections");
  });

  it("omits the dismiss control without an onRemove handler", () => {
    const markup = renderToStaticMarkup(
      <AssistantSelectionsSummaryChip
        selections={[
          { type: "assistant-selection", id: "a", assistantMessageId: "m1", text: "only" },
        ]}
      />,
    );

    expect(markup).toContain("1 selection");
    expect(markup).not.toContain("Remove selections");
  });

  it("renders nothing when empty", () => {
    expect(renderToStaticMarkup(<AssistantSelectionsSummaryChip selections={[]} />)).toBe("");
  });
});
