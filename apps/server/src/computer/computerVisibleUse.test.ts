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
      "Bring Resolve to foreground",
      "Put Resolve in the foreground",
      "put the window on my screen",
      "take over my desktop and do it",
      "make the app visible",
      "use foreground mode",
      "let me see it work",
      "drive my screen",
      "porta il browser in primo piano",
      "mostrami il browser sullo schermo",
    ]) {
      expect(messageRequestsVisibleUse(text), text).toBe(true);
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
    "Show me the browser, but never steal focus",
    "Use foreground mode? No, stay in the background",
    "Watch prices on Newegg and summarize them",
    "Show me the PR titles in your response",
    "Show me the browser logs",
    "I want to see the window tests",
    "Move the validation to the front end",
    "Use foreground colors from the theme",
    "> Show me the browser\nExplain this instruction",
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
    "try again",
    "Ok, continue",
    "continua pure",
  ])("keeps the current task's explicit visibility grant on %s", (continuation) => {
    const messages = [
      message({ text: "Bring Resolve to foreground" }),
      message({ role: "assistant", text: "I opened the project." }),
      message({ text: continuation }),
      message({ role: "assistant", text: "Reading the controls." }),
      message({ text: "keep going" }),
    ];
    expect(computerForegroundAuthorizationForMessages(messages).userRequestedVisibleUse).toBe(true);
    // Consent reconstructs from the persisted transcript, not a prior resolver call or global state.
    expect(
      computerForegroundAuthorizationForMessages(structuredClone(messages)).userRequestedVisibleUse,
    ).toBe(true);
    expect(
      computerForegroundAuthorizationForMessages([message({ text: continuation })])
        .userRequestedVisibleUse,
    ).toBe(false);
  });

  it.each([
    "stop",
    "no, keep working in the background",
    "New task: open Calculator and multiply 12 by 3",
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
      expect(computerForegroundAuthorizationForMessages(messages).userRequestedVisibleUse).toBe(
        answer === "Yes",
      );
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

  it.each(["Ok", "yes, please", "Sì"])(
    "accepts %s as confirmation of the immediately preceding visibility question",
    (reply) => {
      expect(
        computerForegroundAuthorizationForMessages([
          message({ text: "use Helium in the background" }),
          message({
            role: "assistant",
            text: "This menu needs visible access. Can I bring Helium to the front?",
          }),
          message({ text: reply }),
        ]).userRequestedVisibleUse,
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

  it("refuses a thread with no user message at all", () => {
    expect(
      computerForegroundAuthorizationForMessages([message({ role: "assistant", text: "hello" })])
        .userRequestedVisibleUse,
    ).toBe(false);
    expect(computerForegroundAuthorizationForMessages([]).userRequestedVisibleUse).toBe(false);
  });
});
