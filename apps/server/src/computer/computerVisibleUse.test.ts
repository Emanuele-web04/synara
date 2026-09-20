import { describe, expect, it } from "vitest";

import type { OrchestrationMessage } from "@synara/contracts";

import {
  computerForegroundAuthorizationForMessages,
  latestUserAuthoredMessage,
  messageRequestsVisibleUse,
} from "./computerVisibleUse.ts";

function message(overrides: Partial<OrchestrationMessage> = {}): OrchestrationMessage {
  return {
    id: "msg" as OrchestrationMessage["id"],
    role: "user",
    text: "",
    turnId: null,
    streaming: false,
    source: "native",
    createdAt: "2026-09-19T13:00:00.000Z",
    updatedAt: "2026-09-19T13:00:00.000Z",
    ...overrides,
  };
}

describe("messageRequestsVisibleUse", () => {
  it("does not treat naming an app as asking to see it", () => {
    // The incident's own task text: use Helium, never show Helium.
    expect(
      messageRequestsVisibleUse(
        "Go to newegg.com, and pick out parts to build a $3000 gaming pc for 1440p gaming and add them to cart. use only synara computer use and incognito helium browser using computer use",
      ),
    ).toBe(false);
    expect(messageRequestsVisibleUse("open Calculator and add 12 and 34")).toBe(false);
    expect(messageRequestsVisibleUse("use Chrome to check the docs")).toBe(false);
  });

  it("recognizes explicit asks to see the screen", () => {
    for (const text of [
      "show me the browser",
      "show me the Helium window",
      "I want to watch you fill the form",
      "bring Safari to the front",
      "put the window on my screen",
      "take over my desktop and do it",
      "make the app visible",
      "use foreground mode",
      "let me see it work",
      "drive my screen",
    ]) {
      expect(messageRequestsVisibleUse(text), text).toBe(true);
    }
  });

  it.each([
    "Do not make the app visible",
    "Don't show me the browser; keep working",
    "Show me the browser, but never steal focus",
    "Use foreground mode? No, stay in the background",
    "Watch prices on Newegg and summarize them",
    "Show me the PR titles in your response",
    "Show me this function's callers",
    "Show me that diff",
    "Show me the browser logs",
    "Show me the app settings code",
    "I want to see the window tests",
    "Move the validation to the front end",
    "Use foreground colors from the theme",
    "> Show me the browser\nExplain this instruction",
    "The foreground window is my editor",
    'The page says "show me the browser"; summarize it',
    "Explain `use foreground mode`",
  ])("does not authorize visibility from an ambiguous or negative request: %s", (text) => {
    expect(messageRequestsVisibleUse(text)).toBe(false);
  });
});

describe("latestUserAuthoredMessage", () => {
  it("skips automation and agent messages", () => {
    const messages = [
      message({ text: "show me", dispatchOrigin: "user" }),
      message({ text: "automation turn", dispatchOrigin: "automation" }),
      message({ text: "agent turn", dispatchOrigin: "agent" }),
    ];
    expect(latestUserAuthoredMessage(messages)?.text).toBe("show me");
  });

  it("returns the newest user message only", () => {
    const messages = [
      message({ text: "show me the calculator" }),
      message({ text: "assistant reply", role: "assistant" }),
      message({ text: "no, stay in the background" }),
    ];
    expect(latestUserAuthoredMessage(messages)?.text).toBe("no, stay in the background");
  });
});

describe("computerForegroundAuthorizationForMessages", () => {
  it("authorizes only when the latest user message asks to see the screen", () => {
    expect(
      computerForegroundAuthorizationForMessages([
        message({ text: "use Helium incognito to shop" }),
      ]).userRequestedVisibleUse,
    ).toBe(false);
    expect(
      computerForegroundAuthorizationForMessages([message({ text: "show me the Helium window" })])
        .userRequestedVisibleUse,
    ).toBe(true);
  });

  it("revokes an earlier authorization when a later message does not renew it", () => {
    expect(
      computerForegroundAuthorizationForMessages([
        message({ text: "show me what you are doing" }),
        message({ text: "stop" }),
      ]).userRequestedVisibleUse,
    ).toBe(false);
  });

  it("refuses a thread with no user message at all", () => {
    expect(
      computerForegroundAuthorizationForMessages([message({ role: "assistant", text: "hello" })])
        .userRequestedVisibleUse,
    ).toBe(false);
    expect(computerForegroundAuthorizationForMessages([]).userRequestedVisibleUse).toBe(false);
  });
});
