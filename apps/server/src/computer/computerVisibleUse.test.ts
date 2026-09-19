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
      computerForegroundAuthorizationForMessages([message({ text: "show me Helium" })])
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
