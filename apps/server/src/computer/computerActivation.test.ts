import { describe, expect, it } from "vitest";
import { computerActivationMetadata } from "./computerActivation";

describe("user dispatch Computer activation", () => {
  it("recognizes the real nested message.send shape and keeps its generation", () => {
    expect(
      computerActivationMetadata({
        message: { text: "/computer-use inspect Notes" },
        computerControlMode: "off",
        computerControlGeneration: 7,
      }),
    ).toEqual({
      computerControlMode: "request",
      enableComputerControl: true,
      computerControlGeneration: 7,
    });
  });
  it("recognizes a selected skill at both dispatch boundaries", () => {
    const skills = [{ name: "computer-use" }];
    expect(
      computerActivationMetadata({ message: { text: "inspect", skills } }).enableComputerControl,
    ).toBe(true);
    expect(
      computerActivationMetadata({ messageText: "inspect", skills }).enableComputerControl,
    ).toBe(true);
  });
  it("ordinary next turns do not inherit the invocation", () => {
    expect(computerActivationMetadata({ messageText: "write tests" }).enableComputerControl).toBe(
      false,
    );
  });
  it.each(["agent", "automation"] as const)(
    "does not treat %s text as user consent",
    (dispatchOrigin) => {
      expect(
        computerActivationMetadata({ messageText: "/computer-use click", dispatchOrigin })
          .enableComputerControl,
      ).toBe(false);
    },
  );
});
