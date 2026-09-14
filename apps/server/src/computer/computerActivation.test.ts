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
  it("ignores message text and skills: the switch is the only consent", () => {
    expect(
      computerActivationMetadata({
        enableComputerControl: false,
        computerControlGeneration: 3,
      } as unknown as {
        enableComputerControl?: boolean;
        computerControlGeneration?: number;
        messageText?: string;
      }).enableComputerControl,
    ).toBe(false);
  });
});
