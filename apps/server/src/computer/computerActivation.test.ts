import { describe, expect, it } from "vitest";
import { computerActivationMetadata } from "./computerActivation";

describe("user dispatch Computer activation", () => {
  it("enables chat control from the switch and keeps its generation", () => {
    expect(
      computerActivationMetadata({
        enableComputerControl: true,
        computerControlGeneration: 7,
      }),
    ).toEqual({
      computerControlMode: "chat",
      enableComputerControl: true,
      computerControlGeneration: 7,
    });
  });
  it("stays off when the switch is off and defaults the generation", () => {
    expect(computerActivationMetadata({ enableComputerControl: false })).toEqual({
      computerControlMode: "off",
      enableComputerControl: false,
      computerControlGeneration: 0,
    });
    expect(computerActivationMetadata({})).toEqual({
      computerControlMode: "off",
      enableComputerControl: false,
      computerControlGeneration: 0,
    });
  });
  it("freezes a deliberate user command as request mode without changing its generation", () => {
    expect(
      computerActivationMetadata({
        enableComputerControl: false,
        userMessageText: "/computer-use open Calculator",
        computerControlGeneration: 3,
      }),
    ).toEqual({
      computerControlMode: "request",
      enableComputerControl: true,
      computerControlGeneration: 3,
    });
  });
  it("replays the frozen mode instead of promoting an enabled request to chat", () => {
    expect(
      computerActivationMetadata({ computerControlMode: "request", enableComputerControl: true })
        .computerControlMode,
    ).toBe("request");
    expect(
      computerActivationMetadata({ computerControlMode: "off", enableComputerControl: true })
        .enableComputerControl,
    ).toBe(false);
  });
  it("re-evaluates fresh edited text rather than inheriting one-shot intent", () => {
    expect(
      computerActivationMetadata({
        computerControlMode: "request",
        enableComputerControl: true,
        userMessageText: "Explain the result",
      }).computerControlMode,
    ).toBe("off");
    expect(
      computerActivationMetadata({
        computerControlMode: "chat",
        userMessageText: "Explain the result",
      }).computerControlMode,
    ).toBe("chat");
  });
  it.each(["agent", "automation"])(
    "never infers request consent from %s text",
    (dispatchOrigin) => {
      expect(
        computerActivationMetadata({
          userMessageText: "/computer-use open Calculator",
          dispatchOrigin,
        }).enableComputerControl,
      ).toBe(false);
    },
  );
});
