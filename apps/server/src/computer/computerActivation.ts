import type { ComputerControlMode } from "@synara/contracts";

/** Durable user intent follows the Settings switch only. */
export function computerActivationMetadata(input: {
  readonly enableComputerControl?: boolean | undefined;
  readonly computerControlGeneration?: number | undefined;
}): {
  computerControlMode: ComputerControlMode;
  enableComputerControl: boolean;
  computerControlGeneration: number;
} {
  const enabled = input.enableComputerControl === true;
  const computerControlMode = enabled ? ("chat" as const) : ("off" as const);
  return {
    computerControlMode,
    enableComputerControl: computerControlMode !== "off",
    computerControlGeneration: input.computerControlGeneration ?? 0,
  };
}
