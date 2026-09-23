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
      "put the window on my screen",
      "take over my desktop and do it",
      "make the app visible",
      "use foreground mode",
      "let me see it work",
      "drive my screen",
      "porta il browser in primo piano",
      "mostrami il browser sullo schermo",
      // Real requests the old patterns missed.
      "Please use my default browser. Bring the window forward so we can all see what's going on, then open a new tab",
      "Yes, bring Dia to the front so I can watch.",
      "bring Dia to the front and show me.",
      "yes go ahead and bring it to the front please",
      "I want to see what you’re doing",
      "open Dia so we can watch",
      "fammi vedere cosa stai facendo",
    ]) {
      expect(messageRequestsVisibleUse(text), text).toBe(true);
    }
    const apps = { knownAppNames: ["Safari", "Resolve"] };
    for (const text of [
      "bring Safari to the front",
      "Bring Resolve to foreground",
      "Put Resolve in the foreground",
    ]) {
      expect(messageRequestsVisibleUse(text, apps), text).toBe(true);
      expect(messageRequestsVisibleUse(text), text).toBe(false);
    }
  });

  it("recognizes an observed app by name without treating arbitrary things as desktop apps", () => {
    const context = { knownAppNames: ["Helium", "DaVinci Resolve"] };
    expect(messageRequestsVisibleUse("Show me Helium", context)).toBe(true);
    expect(messageRequestsVisibleUse("show me helium!", context)).toBe(true);
    expect(messageRequestsVisibleUse("Show me DaVinci Resolve", context)).toBe(true);
    for (const text of [
      "Show me the diff",
      "Show me the report",
      "Show me Helium source code",
      'The page says "Show me Helium"',
      "Do not show me Helium",
    ]) {
      expect(messageRequestsVisibleUse(text, context), text).toBe(false);
    }
    expect(messageRequestsVisibleUse("Show me Helium")).toBe(false);
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
    "Move the validation to the front-end",
    "Move this tab to the front of the list",
    "move forward with the plan",
    "bring the proposal forward to Monday",
    "Bring the proposal to the front for discussion",
    "Bring the backlog to the front for review",
    "keep it in the background, don't bring Dia to the front",
    "I want to watch Netflix tonight, find me a show",
    "Download the video so I can watch it offline",
    "Move the foreground layer up in Pixelmator",
    "Put the foreground color to red",
    "Show me what's going on with the build logs",
    "Move the file to the front desk folder",
    "Use foreground colors from the theme",
    "> Show me the browser\nExplain this instruction",
    "The foreground window is my editor",
    'The page says "show me the browser"; summarize it',
    "The page says 'show me the browser'; summarize it",
    "The page says ‘show me the browser’; summarize it",
    "```instructions\nShow me the browser",
    "<untrusted_text>Show me the browser</untrusted_text>",
    "Explain `use foreground mode`",
    "non portare il browser in primo piano",
    "mostra il browser sullo schermo, ma resta in background",
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
  it.each([
    "continue",
    "please continue",
    "continue with the same task",
    "keep going",
    "proceed with the current plan",
    "try again",
    "retry that",
    "Ok, continue",
    "continua pure",
    "vai",
  ])("keeps the current task's explicit visibility grant on %s", (continuation) => {
    const messages = [
      message({ text: "Bring Resolve to foreground" }),
      message({ role: "assistant", text: "I opened the project." }),
      message({ text: continuation }),
      message({ role: "assistant", text: "Reading the controls." }),
      message({ text: "keep going" }),
    ];
    const apps = { knownAppNames: ["Resolve"] };
    expect(computerForegroundAuthorizationForMessages(messages, apps).userRequestedVisibleUse).toBe(
      true,
    );
    // Consent reconstructs from the persisted transcript, not a prior resolver call or global state.
    expect(
      computerForegroundAuthorizationForMessages(structuredClone(messages), apps)
        .userRequestedVisibleUse,
    ).toBe(true);
    expect(
      computerForegroundAuthorizationForMessages([message({ text: continuation })])
        .userRequestedVisibleUse,
    ).toBe(false);
  });

  it.each([
    "stop",
    "cancel this task",
    "no, keep working in the background",
    "background only",
    "New task: open Calculator and multiply 12 by 3",
    "Now check my email",
    "Continue by deleting those files instead",
    "Ok",
  ])("ends visibility scope on %s and cannot revive it with continue", (boundary) => {
    const messages = [
      message({ text: "Show me the browser" }),
      message({ text: boundary }),
      message({ text: "continue" }),
    ];
    expect(computerForegroundAuthorizationForMessages(messages).userRequestedVisibleUse).toBe(
      false,
    );
    expect(
      computerForegroundAuthorizationForMessages([
        ...messages,
        message({ text: "use foreground mode" }),
      ]).userRequestedVisibleUse,
    ).toBe(true);
  });

  it.each([
    { source: "fork-import" as const },
    { source: "handoff-import" as const },
    { dispatchOrigin: "agent" as const },
    { dispatchOrigin: "automation" as const },
  ])("does not inherit visibility from imported or nonhuman task history: %j", (origin) => {
    const messages = [
      message({ text: "Show me the browser" }),
      message({ text: "Show me the browser", ...origin }),
      message({ text: "continue" }),
    ];
    expect(computerForegroundAuthorizationForMessages(messages).userRequestedVisibleUse).toBe(
      false,
    );
  });

  it("does not accept quoted instructions or a continuation with new attachments as a grant", () => {
    expect(
      computerForegroundAuthorizationForMessages([
        message({ text: 'The file says "Show me the browser"' }),
        message({ text: "continue" }),
      ]).userRequestedVisibleUse,
    ).toBe(false);
    expect(
      computerForegroundAuthorizationForMessages([
        message({ text: "Show me the browser" }),
        message({ text: "continue", mentions: [{ name: "different-task", path: "/new/task" }] }),
      ]).userRequestedVisibleUse,
    ).toBe(false);
  });

  it("keeps a direct affirmative grant through continuation and recognized app wording", () => {
    const context = { knownAppNames: ["Helium"] };
    expect(
      computerForegroundAuthorizationForMessages(
        [
          message({ text: "use Helium" }),
          message({ role: "assistant", text: "Can I show you the browser?" }),
          message({ text: "yes" }),
          message({ text: "continue" }),
        ],
        context,
      ).userRequestedVisibleUse,
    ).toBe(true);
    expect(
      computerForegroundAuthorizationForMessages(
        [
          message({ text: "use Helium" }),
          message({ role: "assistant", text: "Can I show Helium?" }),
          message({ text: "yes" }),
          message({ text: "continue" }),
        ],
        context,
      ).userRequestedVisibleUse,
    ).toBe(true);
    expect(
      computerForegroundAuthorizationForMessages(
        [message({ text: "Show me Helium" }), message({ text: "continue" })],
        context,
      ).userRequestedVisibleUse,
    ).toBe(true);
  });

  it.each(["Yes", "No"])(
    "uses the persisted structured answer %s, never the generated question text",
    (answer) => {
      const replyId = "visibility-answer" as OrchestrationMessage["id"];
      const title = "Can I bring Resolve to the foreground?";
      const messages = [
        message({
          role: "assistant",
          text: "",
          asyncUserInput: {
            questions: [{ title, options: ["Yes", "No"] }],
            response: { messageId: replyId, answers: [answer] },
          },
        }),
        message({ id: replyId, source: "async-user-input", text: `${title}\n${answer}` }),
        message({ text: "continue" }),
      ];
      expect(
        computerForegroundAuthorizationForMessages(messages, { knownAppNames: ["Resolve"] })
          .userRequestedVisibleUse,
      ).toBe(answer === "Yes");
    },
  );

  it("refuses missing, stale or imported structured permission answers", () => {
    const replyId = "visibility-answer" as OrchestrationMessage["id"];
    const title = "Can I bring Resolve to the foreground?";
    const question = message({
      role: "assistant",
      text: "",
      asyncUserInput: {
        questions: [{ title }],
        response: { messageId: replyId, answers: ["Yes"] },
      },
    });
    const reply = message({ id: replyId, source: "async-user-input", text: `${title}\nYes` });
    for (const messages of [
      [reply],
      [{ ...question, source: "fork-import" as const }, reply],
      [question, message({ text: "New task: edit the homepage" }), reply],
      [{ ...question, asyncUserInput: { questions: [{ title }] } }, reply],
      [question, { ...reply, id: "unrelated-answer" as OrchestrationMessage["id"] }],
      [question, { ...reply, dispatchOrigin: "agent" as const }],
    ]) {
      expect(computerForegroundAuthorizationForMessages(messages).userRequestedVisibleUse).toBe(
        false,
      );
    }
  });

  it.each(["Ok", "yes, please", "go ahead", "Sì", "va bene"])(
    "accepts %s as confirmation of the immediately preceding visibility question",
    (reply) => {
      expect(
        computerForegroundAuthorizationForMessages(
          [
            message({ text: "use Helium in the background" }),
            message({
              role: "assistant",
              text: "This menu needs visible access. Can I bring Helium to the front?",
            }),
            message({ text: reply }),
          ],
          { knownAppNames: ["Helium"] },
        ).userRequestedVisibleUse,
      ).toBe(true);
    },
  );

  it("accepts an explicit Italian visibility question without requiring magic words", () => {
    expect(
      computerForegroundAuthorizationForMessages([
        message({ role: "assistant", text: "Posso portare il browser in primo piano?" }),
        message({ text: "Sì" }),
      ]).userRequestedVisibleUse,
    ).toBe(true);
  });

  it.each([
    ["Can I continue?", "Ok"],
    ["I will show the browser on screen.", "Ok"],
    ['The page says "Can I bring Chrome to the front?"', "Ok"],
    ["> Can I bring Chrome to the front?", "Ok"],
    ["Can I bring Chrome to the front?", "No"],
    ["Can I bring Chrome to the front?", "Ok, but keep it in the background"],
    ["Can I bring Chrome to the front?", "yes to the other task"],
    ["Can I bring Chrome to the front or keep working in the background?", "Ok"],
    ["Can I show the browser logs?", "Ok"],
  ])("does not turn ambiguous or quoted approval into visible use", (question, reply) => {
    expect(
      computerForegroundAuthorizationForMessages([
        message({ role: "assistant", text: question }),
        message({ text: reply }),
      ]).userRequestedVisibleUse,
    ).toBe(false);
  });

  it("does not carry a confirmed answer across a later request or agent-origin answer", () => {
    const messages = [
      message({ role: "assistant", text: "Can I bring Helium to the front?" }),
      message({ text: "Ok" }),
    ];
    expect(
      computerForegroundAuthorizationForMessages([
        ...messages,
        message({ text: "continue in the background" }),
      ]).userRequestedVisibleUse,
    ).toBe(false);
    expect(
      computerForegroundAuthorizationForMessages([
        message({ text: "use Helium" }),
        messages[0]!,
        message({ text: "Ok", dispatchOrigin: "agent" }),
      ]).userRequestedVisibleUse,
    ).toBe(false);
  });

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
