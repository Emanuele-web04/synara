// FILE: AttachmentSummaryChip.test.tsx
// Purpose: Guards the shared count-pill chip (and its selection/comment wrappers)
//   against label, dismiss, and tooltip regressions after consolidation.
// Layer: Component rendering tests
// Depends on: the summary chip wrappers and React server rendering.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { FileCommentsSummaryChip } from "./FileCommentsSummaryChip";

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

describe("FileCommentsSummaryChip", () => {
  it("renders a pluralized count and a labelled dismiss control", () => {
    const markup = renderToStaticMarkup(
      <FileCommentsSummaryChip
        comments={[
          { path: "a.ts", startLine: 1, endLine: 2, text: "note" },
          { path: "b.ts", startLine: 3, endLine: 3, text: "note" },
        ]}
        onRemove={() => {}}
      />,
    );

    expect(markup).toContain("2 comments");
    expect(markup).toContain("Remove comments");
  });

  it("renders nothing when empty", () => {
    expect(renderToStaticMarkup(<FileCommentsSummaryChip comments={[]} />)).toBe("");
  });
});
