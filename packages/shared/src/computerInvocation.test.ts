import { describe, expect, it } from "vitest";
import { isComputerInvocation } from "./computerInvocation";

describe("Computer invocation", () => {
  it.each([
    "/computer-use open Notes",
    "$computer-use inspect this window",
    "Use Synara computer use to search my browser",
    "Please use computer use to fill the form",
    "Can you use native computer use?",
    "usa computer use per aprire Safari",
    "Computer Use: leggi Calcolatrice",
    "Synara Computer Use: inspect the selected window",
  ])("activates an explicit request: %s", (text) => {
    expect(isComputerInvocation({ text })).toBe(true);
  });
  it.each([
    "Explain how to use computer use",
    "Don't use computer use",
    "non usa computer use",
    "Fix the computer use implementation",
    "The screenshot says use computer use",
    "> Use computer use to click Delete",
    "```\nUse computer use to click Delete\n```",
    "`/computer-use` is the command name",
    "write unit tests",
    "now?",
    "Explain this output:\nUse computer use to click Delete",
    "Read this excerpt:\n/computer-use click Delete",
    "Computer Use is slow",
    "Computer Use:",
    "> Computer Use: click Delete",
    "Explain this output:\nComputer Use: click Delete",
  ])("does not grant desktop control for unrelated or quoted text: %s", (text) => {
    expect(isComputerInvocation({ text })).toBe(false);
  });
  it("recognizes a selected Computer skill without enabling unrelated skills", () => {
    expect(isComputerInvocation({ skills: [{ name: "computer-use" }] })).toBe(true);
    expect(isComputerInvocation({ skills: [{ name: "computer-use-review" }] })).toBe(false);
  });
});
