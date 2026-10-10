import type { ComputerControlMode } from "@synara/contracts";
import { resolveComputerInvocationMode } from "@synara/shared/computerInvocation";

/** Freeze explicit turn intent without promoting a slash invocation to chat access. */
export function computerActivationMetadata(input: {
  readonly enableComputerControl?: boolean | undefined;
  readonly computerControlMode?: ComputerControlMode | undefined;
  readonly computerControlGeneration?: number | undefined;
  /** Only the decider supplies fresh, user-authored text; replay uses frozen mode. */
  readonly userMessageText?: string | undefined;
  readonly dispatchOrigin?: string | undefined;
}): {
  computerControlMode: ComputerControlMode;
  enableComputerControl: boolean;
  computerControlGeneration: number;
} {
  const computerControlMode =
    input.userMessageText === undefined
      ? resolveComputerInvocationMode(input)
      : resolveComputerInvocationMode({
          messageText: input.userMessageText,
          dispatchOrigin: input.dispatchOrigin,
          enableComputerControl:
            input.computerControlMode === "chat" ||
            (input.computerControlMode === undefined && input.enableComputerControl === true),
        });
  return {
    computerControlMode,
    enableComputerControl: computerControlMode !== "off",
    computerControlGeneration: input.computerControlGeneration ?? 0,
  };
}
