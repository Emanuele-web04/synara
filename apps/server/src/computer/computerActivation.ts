import type { ComputerControlMode } from "@synara/contracts";
import { isComputerInvocation } from "@synara/shared/computerInvocation";

/** Normalize durable user intent once, including older clients and saved queue entries. */
export function computerActivationMetadata(input: {
  readonly computerControlMode?: ComputerControlMode | undefined;
  readonly enableComputerControl?: boolean | undefined;
  readonly computerControlGeneration?: number | undefined;
  readonly messageText?: string | undefined;
  readonly text?: string | undefined;
  readonly dispatchOrigin?: "user" | "automation" | "agent" | undefined;
  readonly skills?: readonly { name: string }[] | undefined;
  readonly message?: { text: string; skills?: readonly { name: string }[] | undefined } | undefined;
}): {
  computerControlMode: ComputerControlMode;
  enableComputerControl: boolean;
  computerControlGeneration: number;
} {
  const computerControlMode =
    (input.dispatchOrigin === undefined || input.dispatchOrigin === "user") &&
    isComputerInvocation({
      text: input.messageText ?? input.message?.text ?? input.text,
      skills: input.skills ?? input.message?.skills,
    })
      ? "request"
      : (input.computerControlMode ?? (input.enableComputerControl === true ? "chat" : "off"));
  return {
    computerControlMode,
    enableComputerControl: computerControlMode !== "off",
    computerControlGeneration: input.computerControlGeneration ?? 0,
  };
}
