// FILE: workEntryRow.test.tsx
// Purpose: Focused SSR coverage for raw streamed work-entry rendering.
// Layer: Web chat presentation tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SimpleWorkEntryRow } from "./workEntryRow";
import type { WorkLogEntry } from "~/session-logic";

describe("SimpleWorkEntryRow", () => {
  it.each([
    "reasoning_text",
    "reasoning_summary_text",
    "plan_text",
    "command_output",
    "file_change_output",
    "unknown",
  ] as const)("renders lossless %s output in a multiline stream body", (streamKind) => {
    const workEntry: WorkLogEntry = {
      id: `${streamKind}-raw-output`,
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Stream output",
      detail: "one\ntwo\n",
      streamKind,
      tone: streamKind.startsWith("reasoning") ? "thinking" : "tool",
      toolTitle: "Stream output",
    };

    const markup = renderToStaticMarkup(
      <SimpleWorkEntryRow workEntry={workEntry} chatMetaFontSizePx={12} />,
    );

    expect(markup).toContain("<pre");
    expect(markup).toContain("one\ntwo\n");
  });

  it("renders whitespace-only stream output visibly", () => {
    const workEntry: WorkLogEntry = {
      id: "whitespace-output",
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Command output",
      detail: "\n\t ",
      streamKind: "command_output",
      tone: "tool",
      toolTitle: "Command output",
    };

    const markup = renderToStaticMarkup(
      <SimpleWorkEntryRow workEntry={workEntry} chatMetaFontSizePx={12} />,
    );

    expect(markup).toContain("<pre");
    expect(markup).toContain("\\n\n\\t\u00b7");
  });
});
