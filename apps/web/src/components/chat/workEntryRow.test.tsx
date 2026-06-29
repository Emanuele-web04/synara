// FILE: workEntryRow.test.tsx
// Purpose: Focused SSR coverage for raw streamed work-entry rendering.
// Layer: Web chat presentation tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SimpleWorkEntryRow } from "./workEntryRow";
import type { WorkLogEntry } from "~/session-logic";

describe("SimpleWorkEntryRow", () => {
  it.each(["command_output", "file_change_output", "unknown"] as const)(
    "renders lossless %s output in a multiline stream body",
    (streamKind) => {
      const workEntry: WorkLogEntry = {
        id: `${streamKind}-raw-output`,
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Stream output",
        detail: "one\ntwo\n",
        streamKind,
        tone: "tool",
        toolTitle: "Stream output",
      };

      const markup = renderToStaticMarkup(
        <SimpleWorkEntryRow workEntry={workEntry} chatMetaFontSizePx={12} />,
      );

      expect(markup).toContain("<pre");
      expect(markup).toContain("one\ntwo\n");
    },
  );

  it.each(["reasoning_text", "reasoning_summary_text", "plan_text"] as const)(
    "renders %s through assistant markdown",
    (streamKind) => {
      const workEntry: WorkLogEntry = {
        id: `${streamKind}-markdown-output`,
        createdAt: "2026-02-23T00:00:01.000Z",
        label: "Stream output",
        detail: "## Heading\n\n- one\n- two",
        streamKind,
        status: "inProgress",
        tone: streamKind.startsWith("reasoning") ? "thinking" : "tool",
        toolTitle: "Stream output",
      };

      const markup = renderToStaticMarkup(
        <SimpleWorkEntryRow workEntry={workEntry} chatMetaFontSizePx={12} />,
      );

      expect(markup).not.toContain("<pre");
      expect(markup).toContain('class="chat-markdown');
      expect(markup).toContain("<h2>Heading</h2>");
      expect(markup).toContain("<li>one</li>");
    },
  );

  it("keeps collab agent markdown on the streaming markdown path", () => {
    const workEntry: WorkLogEntry = {
      id: "agent-task-markdown-output",
      createdAt: "2026-02-23T00:00:01.000Z",
      detail: "### Agent Notes\n\n- inspected renderer",
      itemType: "collab_agent_tool_call",
      label: "Started subagent",
      status: "inProgress",
      tone: "tool",
      toolTitle: "Started subagent",
    };

    const markup = renderToStaticMarkup(
      <SimpleWorkEntryRow workEntry={workEntry} chatMetaFontSizePx={12} />,
    );

    expect(markup).toContain('class="chat-markdown');
    expect(markup).toContain("<h3>Agent Notes</h3>");
    expect(markup).toContain("<li>inspected renderer</li>");
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

  it.each([
    ["inProgress", "Running"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["declined", "Declined"],
  ] as const)("renders %s lifecycle status semantics", (status, label) => {
    const workEntry: WorkLogEntry = {
      id: `${status}-status-row`,
      createdAt: "2026-02-23T00:00:01.000Z",
      label: "Tool call",
      status,
      tone: status === "failed" ? "error" : "tool",
      toolTitle: "Tool call",
    };

    const markup = renderToStaticMarkup(
      <SimpleWorkEntryRow workEntry={workEntry} chatMetaFontSizePx={12} />,
    );

    expect(markup).toContain(`data-work-entry-status="${status}"`);
    expect(markup).toContain(`aria-label="Status: ${label}"`);
    expect(markup).toContain('data-work-entry-status-dot="true"');
  });

  it("uses a single details trigger for openable rows with tool details", () => {
    const workEntry: WorkLogEntry = {
      id: "openable-command-details",
      createdAt: "2026-02-23T00:00:01.000Z",
      command: "cat package.json",
      detail: '{"file_path":"/Users/example/project/package.json"}',
      itemType: "command_execution",
      label: "Ran command",
      status: "completed",
      tone: "tool",
      toolDetails: {
        kind: "command",
        title: "Read",
        command: "cat package.json",
        output: {
          stdout: "{}",
          stderr: "",
          exitCode: 0,
        },
      },
      toolTitle: "Read",
    };

    const markup = renderToStaticMarkup(
      <SimpleWorkEntryRow
        workEntry={workEntry}
        chatMetaFontSizePx={12}
        onOpenAgentActivity={() => undefined}
        onOpenToolDetails={() => undefined}
      />,
    );

    expect(markup.match(/<button/g)?.length).toBe(1);
    expect(markup).toContain('data-tool-detail-trigger="true"');
  });

  it("renders subagent tool details through the canonical disclosure path", () => {
    const workEntry: WorkLogEntry = {
      id: "subagent-details",
      createdAt: "2026-02-23T00:00:01.000Z",
      detail: "Inspect the renderer",
      itemType: "collab_agent_tool_call",
      label: "Started subagent",
      status: "inProgress",
      subagents: [
        {
          threadId: "subagent-thread-1",
          nickname: "Surveyor",
          rawStatus: "running",
          isActive: true,
        },
      ],
      tone: "tool",
      toolDetails: {
        kind: "command",
        title: "Task",
        command: "Task: inspect renderer",
        output: {
          stdout: "running",
          stderr: "",
          exitCode: 0,
        },
      },
      toolTitle: "Started subagent",
    };

    const markup = renderToStaticMarkup(
      <SimpleWorkEntryRow
        workEntry={workEntry}
        chatMetaFontSizePx={12}
        onOpenAgentActivity={() => undefined}
        onOpenToolDetails={() => undefined}
      />,
    );

    expect(markup).toContain('data-tool-detail-trigger="true"');
    expect(markup.match(/data-tool-detail-trigger="true"/g)?.length).toBe(1);
    expect(markup.match(/<button/g)?.length).toBe(2);
    expect(markup).toContain("Surveyor");
  });
});
