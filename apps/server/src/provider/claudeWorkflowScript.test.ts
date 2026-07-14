import { describe, expect, it } from "vitest";

import {
  extractClaudeWorkflowAgentPhases,
  parseClaudeWorkflowLaunch,
  parseClaudeWorkflowLaunchFromText,
  parseClaudeWorkflowProgressAgents,
  parseClaudeWorkflowScriptMeta,
} from "./claudeWorkflowScript.ts";

const FULL_SCRIPT = `export const meta = {
  name: "spec",
  description: 'Draft the feature spec',
  phases: [
    { title: "One", detail: "Research" },
    { title: "Two" },
  ],
};

const research = await agent("Research prior art", {
  label: "gamma-agent",
  phase: "One",
  model: "haiku",
});
const draft = await agent(\`Draft using \${research}\`, { phase: 'Two', label: 'delta-agent' });
`;

describe("parseClaudeWorkflowScriptMeta", () => {
  it("parses name, description, and phases from the meta literal", () => {
    expect(parseClaudeWorkflowScriptMeta(FULL_SCRIPT)).toEqual({
      name: "spec",
      description: "Draft the feature spec",
      phases: [{ title: "One", detail: "Research" }, { title: "Two" }],
    });
  });

  it("parses meta without phases", () => {
    expect(parseClaudeWorkflowScriptMeta('export const meta = { name: "solo" };')).toEqual({
      name: "solo",
    });
  });

  it("returns undefined for computed or malformed meta without throwing", () => {
    expect(parseClaudeWorkflowScriptMeta("const x = 1;")).toBeUndefined();
    expect(parseClaudeWorkflowScriptMeta("export const meta = buildMeta();")).toBeUndefined();
    expect(parseClaudeWorkflowScriptMeta("export const meta = { name: myName };")).toBeUndefined();
    expect(
      parseClaudeWorkflowScriptMeta("export const meta = { name: `wf-${suffix}` };"),
    ).toBeUndefined();
    expect(parseClaudeWorkflowScriptMeta('export const meta = { name: "x"')).toBeUndefined();
    expect(parseClaudeWorkflowScriptMeta("export const meta = { phases: [1] };")).toEqual(
      undefined,
    );
  });
});

describe("extractClaudeWorkflowAgentPhases", () => {
  it("collects label/phase string-literal pairs across quote styles", () => {
    expect(extractClaudeWorkflowAgentPhases(FULL_SCRIPT)).toEqual({
      "gamma-agent": "One",
      "delta-agent": "Two",
    });
  });

  it("ignores computed values and options missing either key", () => {
    const script = `
      await agent("a", { label: makeLabel(), phase: "One" });
      await agent("b", { label: \`x-\${n}\`, phase: "One" });
      await agent("c", { label: "loner" });
      await agent("d (with parens)", { phase: "Two" });
    `;
    expect(extractClaudeWorkflowAgentPhases(script)).toBeUndefined();
  });
});

describe("parseClaudeWorkflowLaunch", () => {
  it("reads identifiers from the structured tool result", () => {
    expect(
      parseClaudeWorkflowLaunch({
        status: "async_launched",
        taskId: "wf-task-1",
        taskType: "local_workflow",
        workflowName: "spec",
        runId: "wf_abc123",
        scriptPath: "/home/user/.claude/workflows/spec.ts",
        transcriptDir: "/tmp/transcripts",
      }),
    ).toEqual({
      taskId: "wf-task-1",
      runId: "wf_abc123",
      scriptPath: "/home/user/.claude/workflows/spec.ts",
    });
  });

  it("rejects non-workflow results", () => {
    expect(parseClaudeWorkflowLaunch({ taskType: "bash", runId: "wf_abc123" })).toBeUndefined();
    expect(parseClaudeWorkflowLaunch("wf_abc123")).toBeUndefined();
    expect(parseClaudeWorkflowLaunch({ taskType: "local_workflow" })).toBeUndefined();
  });
});

describe("parseClaudeWorkflowLaunchFromText", () => {
  it("recovers runId and script path from free text", () => {
    const text = [
      "Workflow launched in the background.",
      "Run id: wf_9f3k2a. Script persisted to /sessions/abc/workflow-spec.ts for resume.",
    ].join("\n");
    expect(parseClaudeWorkflowLaunchFromText(text)).toEqual({
      runId: "wf_9f3k2a",
      scriptPath: "/sessions/abc/workflow-spec.ts",
    });
  });

  it("returns undefined when neither identifier is present", () => {
    expect(parseClaudeWorkflowLaunchFromText("All done.")).toBeUndefined();
  });
});

describe("parseClaudeWorkflowProgressAgents", () => {
  it("reads workflow_agent entries from the output file", () => {
    const content = JSON.stringify({
      workflowProgress: [
        { type: "workflow_phase", title: "One" },
        {
          type: "workflow_agent",
          label: "gamma-agent",
          phaseIndex: 0,
          agentId: "agent-1",
          model: "haiku",
          state: "completed",
        },
        { type: "workflow_agent", label: "delta-agent", phaseIndex: 1, state: "failed" },
        { type: "workflow_agent" },
      ],
    });
    expect(parseClaudeWorkflowProgressAgents(content)).toEqual([
      { label: "gamma-agent", phaseIndex: 0, model: "haiku", state: "completed" },
      { label: "delta-agent", phaseIndex: 1, state: "failed" },
    ]);
  });

  it("returns undefined for invalid JSON or missing progress", () => {
    expect(parseClaudeWorkflowProgressAgents("not json")).toBeUndefined();
    expect(parseClaudeWorkflowProgressAgents("{}")).toBeUndefined();
  });
});
