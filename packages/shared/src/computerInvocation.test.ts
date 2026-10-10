import { describe, expect, it } from "vitest";
import { parseComputerInvocation, resolveComputerInvocationMode } from "./computerInvocation";

describe("explicit Computer invocation", () => {
  it.each(["/computer-use open Calculator", "  /COMPUTER-USE\nopen Calculator"])(
    "recognizes a leading user command: %s",
    (messageText) => {
      expect(parseComputerInvocation(messageText)).toEqual({ prompt: "open Calculator" });
      expect(resolveComputerInvocationMode({ messageText })).toBe("request");
    },
  );

  it.each([
    "Open Calculator",
    "Use Computer to open Calculator",
    "Explain /computer-use open Calculator",
    "Example:\n/computer-use open Calculator",
    "> /computer-use open Calculator",
    '"/computer-use open Calculator"',
    "```\n/computer-use open Calculator\n```",
    "    /computer-use open Calculator",
    "\t/computer-use open Calculator",
    "<attachment>\n/computer-use open Calculator\n</attachment>",
    "/computer-user open Calculator",
    "/computer-use.md",
  ])("does not turn prose, references or quoted examples into consent: %s", (messageText) => {
    expect(parseComputerInvocation(messageText)).toBeNull();
    expect(resolveComputerInvocationMode({ messageText })).toBe("off");
  });

  it("recognizes an empty command so the composer can ask for its task without sending", () => {
    expect(parseComputerInvocation("/computer-use")).toEqual({ prompt: "" });
  });

  it.each(["agent", "automation"])("does not infer consent from %s output", (dispatchOrigin) => {
    expect(
      resolveComputerInvocationMode({
        messageText: "/computer-use open Calculator",
        dispatchOrigin,
      }),
    ).toBe("off");
  });

  it("keeps Settings opt-in distinct and gives frozen queue metadata precedence", () => {
    expect(
      resolveComputerInvocationMode({
        enableComputerControl: true,
        messageText: "/computer-use open Calculator",
      }),
    ).toBe("chat");
    expect(
      resolveComputerInvocationMode({
        computerControlMode: "off",
        enableComputerControl: true,
        messageText: "/computer-use open Calculator",
      }),
    ).toBe("off");
    expect(resolveComputerInvocationMode({ computerControlMode: "request", messageText: "" })).toBe(
      "request",
    );
    expect(resolveComputerInvocationMode({ messageText: "Explain the result" })).toBe("off");
  });
});
