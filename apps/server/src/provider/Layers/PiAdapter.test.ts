// FILE: PiAdapter.test.ts
// Purpose: Verifies Pi adapter discovery, subagent prompt, and transcript helper behavior.
// Layer: Provider adapter tests
// Depends on: PiAdapter discovery helpers and Pi model metadata shapes.

import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  buildPiSubagentPrompt,
  ensurePiSubagentChildLauncherEnv,
  getPiSupportedThinkingOptions,
  makePiSubagentTurnCompletedPayload,
  makePiSubagentPromptItemId,
  makePiSubagentSourceKey,
  makePiUserInputOptions,
  PLAIN_PI_EXTENSION_THEME,
  piSubagentPromptTextForReceiver,
  piSubagentReceiverAgents,
  recordPiSubagentParentTurnIds,
  recordPiSubagentSessionTranscriptEmission,
  shouldEmitPiSubagentFallbackTranscript,
} from "./PiAdapter";

function makePiModel(input: {
  reasoning: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}): Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> {
  return {
    reasoning: input.reasoning,
    ...(input.thinkingLevelMap !== undefined ? { thinkingLevelMap: input.thinkingLevelMap } : {}),
  };
}

describe("getPiSupportedThinkingOptions", () => {
  it("hides thinking controls for non-reasoning models", () => {
    expect(getPiSupportedThinkingOptions(makePiModel({ reasoning: false }))).toEqual([]);
  });

  it("advertises xhigh only when the concrete Pi model supports it", () => {
    const withoutXHigh = getPiSupportedThinkingOptions(makePiModel({ reasoning: true }));
    const withXHigh = getPiSupportedThinkingOptions(
      makePiModel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } }),
    );

    expect(withoutXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
    expect(withXHigh.map((option) => option.value)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("respects provider-level disabled thinking levels", () => {
    const options = getPiSupportedThinkingOptions(
      makePiModel({
        reasoning: true,
        thinkingLevelMap: {
          off: null,
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
        },
      }),
    );

    expect(options.map((option) => option.value)).toEqual(["minimal", "low", "medium", "high"]);
  });
});

describe("Pi extension UI helpers", () => {
  it("keeps original select values while showing normalized unique labels", () => {
    const mappings = makePiUserInputOptions(["  OpenRouter  ", "", "OpenRouter"]);

    expect(mappings.map((mapping) => mapping.value)).toEqual(["  OpenRouter  ", "", "OpenRouter"]);
    expect(mappings.map((mapping) => mapping.option.label)).toEqual([
      "OpenRouter",
      "Option 2",
      "OpenRouter (2)",
    ]);
  });

  it("provides a no-color theme object for UI-gated extensions", () => {
    expect(PLAIN_PI_EXTENSION_THEME.fg("accent", "ready")).toBe("ready");
    expect(PLAIN_PI_EXTENSION_THEME.bold("done")).toBe("done");
    expect(PLAIN_PI_EXTENSION_THEME.getThinkingBorderColor("medium")("thinking")).toBe("thinking");
  });
});

describe("Pi subagent child launcher env", () => {
  it("defaults embedded subagent launches to the Pi CLI", () => {
    const env: { PI_SUBAGENT_PI_COMMAND?: string } = {};

    ensurePiSubagentChildLauncherEnv(env);

    expect(env.PI_SUBAGENT_PI_COMMAND).toBe("pi");
  });

  it("preserves an explicit subagent launcher override", () => {
    const env = { PI_SUBAGENT_PI_COMMAND: "custom-pi-wrapper pi" };

    ensurePiSubagentChildLauncherEnv(env, "/opt/pi/bin/pi");

    expect(env.PI_SUBAGENT_PI_COMMAND).toBe("custom-pi-wrapper pi");
  });

  it("uses the configured Pi binary when no launcher override exists", () => {
    const env: { PI_SUBAGENT_PI_COMMAND?: string } = {};

    ensurePiSubagentChildLauncherEnv(env, "/opt/pi/bin/pi");

    expect(env.PI_SUBAGENT_PI_COMMAND).toBe("/opt/pi/bin/pi");
  });

  it("replaces the adapter default when a configured Pi binary appears later", () => {
    const env = { PI_SUBAGENT_PI_COMMAND: "pi" };

    ensurePiSubagentChildLauncherEnv(env, "/opt/pi/bin/pi");

    expect(env.PI_SUBAGENT_PI_COMMAND).toBe("/opt/pi/bin/pi");
  });

  it("resets an adapter-owned configured Pi binary for later default sessions", () => {
    const env: { PI_SUBAGENT_PI_COMMAND?: string } = {};

    ensurePiSubagentChildLauncherEnv(env, "/opt/pi/bin/pi");
    ensurePiSubagentChildLauncherEnv(env);

    expect(env.PI_SUBAGENT_PI_COMMAND).toBe("pi");
  });
});

describe("Pi subagent prompt expansion", () => {
  it("includes project scope for project-local inline agent mentions", () => {
    const prompt = buildPiSubagentPrompt("Please @scout(inspect the repo).", [
      {
        name: "scout",
        displayName: "Scout",
        scope: "project",
      },
    ]);

    expect(prompt).toContain('Launch the "scout" subagent from the project agent scope');
    expect(prompt).toContain('using scope/source "project"');
    expect(prompt).toContain("inspect the repo");
  });
});

describe("Pi subagent transcript helpers", () => {
  it("records parent turn ids for async subagent launch acknowledgements", () => {
    const parentTurnIds = new Map<string, string>();

    recordPiSubagentParentTurnIds({
      parentTurnId: "turn-parent-1",
      subagentParentTurnIds: parentTurnIds,
      transcriptTargets: [{ threadId: "child-provider-1" }, { threadId: "" }, {}],
    });

    expect(parentTurnIds.get("child-provider-1")).toBe("turn-parent-1");
    expect(parentTurnIds.size).toBe(1);
  });

  it("uses each multi-subagent child's own prompt and session file", () => {
    const args = {
      children: [
        { agent: "scout", task: "Inspect the repo" },
        { agent: "writer", task: "Draft the summary" },
      ],
    };
    const details = {
      children: [
        { threadId: "child-provider-1", sessionFile: "/tmp/pi-scout.jsonl" },
        { threadId: "child-provider-2", sessionFile: "/tmp/pi-writer.jsonl" },
      ],
    };

    const receiverAgents = piSubagentReceiverAgents({ args, details });

    expect(receiverAgents).toMatchObject([
      {
        threadId: "child-provider-1",
        agentId: "scout",
        prompt: "Inspect the repo",
        sessionFile: "/tmp/pi-scout.jsonl",
      },
      {
        threadId: "child-provider-2",
        agentId: "writer",
        prompt: "Draft the summary",
        sessionFile: "/tmp/pi-writer.jsonl",
      },
    ]);
    expect(
      piSubagentPromptTextForReceiver({
        args,
        details,
        receiverAgent: receiverAgents[0],
      }),
    ).toBe("Inspect the repo");
    expect(
      piSubagentPromptTextForReceiver({
        args,
        details,
        receiverAgent: receiverAgents[1],
      }),
    ).toBe("Draft the summary");
  });

  it("carries failed state into session transcript turn completions", () => {
    expect(makePiSubagentTurnCompletedPayload(false)).toEqual({
      state: "completed",
      stopReason: null,
    });
    expect(makePiSubagentTurnCompletedPayload(true)).toEqual({
      state: "failed",
      stopReason: null,
      errorMessage: "Subagent failed",
    });
  });

  it("suppresses exact session transcript replays while allowing appended content", () => {
    const emittedTranscripts = new Map<string, string>();

    expect(
      recordPiSubagentSessionTranscriptEmission({
        emittedTranscripts,
        providerThreadId: "child-provider-1",
        sessionFile: "/tmp/pi-child.jsonl",
        sessionContent: '{"type":"message","id":"one"}\n',
      }),
    ).toBe("recorded");
    expect(
      recordPiSubagentSessionTranscriptEmission({
        emittedTranscripts,
        providerThreadId: "child-provider-1",
        sessionFile: "/tmp/pi-child.jsonl",
        sessionContent: '{"type":"message","id":"one"}\n',
      }),
    ).toBe("replayed");
    expect(
      recordPiSubagentSessionTranscriptEmission({
        emittedTranscripts,
        providerThreadId: "child-provider-1",
        sessionFile: "/tmp/pi-child.jsonl",
        sessionContent: '{"type":"message","id":"one"}\n{"type":"message","id":"two"}\n',
      }),
    ).toBe("recorded");
  });

  it("only falls back to synthetic transcripts when session import is unavailable", () => {
    expect(
      shouldEmitPiSubagentFallbackTranscript({
        transcriptResult: "unavailable",
        messageText: "Final child answer",
      }),
    ).toBe(true);
    expect(
      shouldEmitPiSubagentFallbackTranscript({
        transcriptResult: "replayed",
        messageText: "Final child answer",
      }),
    ).toBe(false);
    expect(
      shouldEmitPiSubagentFallbackTranscript({
        transcriptResult: "emitted",
        messageText: "Final child answer",
      }),
    ).toBe(false);
    expect(
      shouldEmitPiSubagentFallbackTranscript({
        transcriptResult: "unavailable",
        messageText: "",
      }),
    ).toBe(false);
  });

  it("keys prompt item ids by child thread and transcript source", () => {
    const sourceKey = makePiSubagentSourceKey({
      kind: "subagent_result",
      parentThreadId: "thread-1",
      providerThreadId: "child-provider-1",
      sessionFile: "/tmp/pi-child.jsonl",
    });
    const laterSourceKey = makePiSubagentSourceKey({
      kind: "subagent_result",
      parentThreadId: "thread-1",
      providerThreadId: "child-provider-1",
      sessionFile: "/tmp/pi-child-later.jsonl",
    });
    const first = makePiSubagentPromptItemId({
      providerThreadId: "child-provider-1",
      sourceKey,
    });
    const replay = makePiSubagentPromptItemId({
      providerThreadId: "child-provider-1",
      sourceKey,
    });
    const laterPrompt = makePiSubagentPromptItemId({
      providerThreadId: "child-provider-1",
      sourceKey: laterSourceKey,
    });

    expect(replay).toBe(first);
    expect(laterPrompt).not.toBe(first);
    expect(first).toMatch(/^pi-subagent-prompt-[a-f0-9]{24}$/);
  });

  it("uses the same session transcript source across Pi import surfaces", () => {
    const messageSurface = makePiSubagentSourceKey({
      kind: "subagent_result",
      parentThreadId: "thread-1",
      providerThreadId: "child-provider-1",
      sessionFile: "/tmp/pi-child.jsonl",
    });
    const toolSurface = makePiSubagentSourceKey({
      kind: "subagent",
      parentThreadId: "thread-1",
      providerThreadId: "child-provider-1",
      sessionFile: "/tmp/pi-child.jsonl",
      toolCallId: "call-1",
    });

    expect(toolSurface).toBe(messageSurface);
    expect(
      makePiSubagentPromptItemId({
        providerThreadId: "child-provider-1",
        sourceKey: toolSurface,
      }),
    ).toBe(
      makePiSubagentPromptItemId({
        providerThreadId: "child-provider-1",
        sourceKey: messageSurface,
      }),
    );
  });

  it("scopes session transcript ids to the parent Synara thread", () => {
    const firstParent = makePiSubagentSourceKey({
      kind: "subagent_result",
      parentThreadId: "thread-1",
      providerThreadId: "child-provider-1",
      sessionFile: "/tmp/pi-child.jsonl",
    });
    const secondParent = makePiSubagentSourceKey({
      kind: "subagent_result",
      parentThreadId: "thread-2",
      providerThreadId: "child-provider-1",
      sessionFile: "/tmp/pi-child.jsonl",
    });

    expect(secondParent).not.toBe(firstParent);
    expect(
      makePiSubagentPromptItemId({
        providerThreadId: "child-provider-1",
        sourceKey: secondParent,
      }),
    ).not.toBe(
      makePiSubagentPromptItemId({
        providerThreadId: "child-provider-1",
        sourceKey: firstParent,
      }),
    );
  });
});
