/**
 * Which computer backend this Linux host gets, decided once at startup.
 *
 * One rule outranks everything here: **the agent never drives the seat the
 * human is sitting at.** Every backend this module can resolve gives the agent
 * a seat of its own — a compositor plugin's dedicated seat on the desktop the
 * human is looking at, or a private nested compositor everywhere else. There
 * is no shared-seat backend: anything that attached virtual devices to the
 * human's own `wl_seat` would move their real cursor, so no such backend
 * exists in the tree to be selected, forced, or fallen back to.
 *
 * Beyond that rule, an explicit ordered resolution with **no fallback in any
 * direction**. A tier that fails stays failed, and the backend it produces
 * explains why — an operator who named a backend is debugging that backend,
 * and quietly giving them a different one wastes the next hour of their life.
 *
 * The resolution order: the `SYNARA_COMPUTER_BACKEND` override, then the
 * detection tiers each Linux backend registers here, best desktop first. A
 * host no tier claims gets no Linux selection, and `Layers/ComputerService.ts`
 * falls through to the Cua host when one is configured and to the unavailable
 * backend otherwise.
 */

/**
 * Every Linux backend `SYNARA_COMPUTER_BACKEND` can name. Each backend adds
 * its choice here beside its detection tier in `selectLinuxBackend`, and its
 * constructor in the service layer's factory table, so the three cannot drift.
 */
export const LINUX_BACKEND_CHOICES = [] as const;
export type LinuxBackendChoice = (typeof LINUX_BACKEND_CHOICES)[number];

/**
 * Every backend `SYNARA_COMPUTER_BACKEND` can name, in the order the service
 * layer resolves them: the test double and the Cua host are platform-neutral
 * and win on any host; the Linux choices are refused off Linux.
 */
export const COMPUTER_BACKEND_OVERRIDES = ["fake", "cua", ...LINUX_BACKEND_CHOICES] as const;
export type ComputerBackendOverride = (typeof COMPUTER_BACKEND_OVERRIDES)[number];

export interface LinuxBackendSelection {
  readonly choice: LinuxBackendChoice;
  /**
   * The choice came from `SYNARA_COMPUTER_BACKEND`. A forced choice that then
   * fails must stay failed and say so.
   */
  readonly forced: boolean;
  /** Why this backend, in one sentence, for the availability card and logs. */
  readonly reason: string;
}

export class InvalidComputerBackendOverrideError extends Error {
  constructor(readonly value: string) {
    super(
      `SYNARA_COMPUTER_BACKEND=${JSON.stringify(value)} is not a backend Synara has. ` +
        `Use one of: ${COMPUTER_BACKEND_OVERRIDES.join(", ")}.`,
    );
    this.name = "InvalidComputerBackendOverrideError";
  }
}

/**
 * The override, or `undefined` when none is set.
 *
 * A typo throws instead of being ignored. Every other env var here degrades to
 * a default on bad input, but this one names the backend: silently ignoring
 * `SYNARA_COMPUTER_BACKEND=protal` would boot the wrong tier and look like the
 * override does not work.
 */
export function parseComputerBackendOverride(
  value: string | undefined,
): ComputerBackendOverride | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const lowered = trimmed.toLowerCase();
  const match = COMPUTER_BACKEND_OVERRIDES.find((choice) => choice === lowered);
  if (!match) throw new InvalidComputerBackendOverrideError(trimmed);
  return match;
}

/** Whether an override names one of the Linux tiers rather than a neutral backend. */
export function isLinuxBackendChoice(
  override: ComputerBackendOverride | undefined,
): override is LinuxBackendChoice {
  return override !== undefined && (LINUX_BACKEND_CHOICES as readonly string[]).includes(override);
}

export interface LinuxBackendSelectionDependencies {
  readonly env?: NodeJS.ProcessEnv;
  /** The parsed `SYNARA_COMPUTER_BACKEND`, when it names a Linux tier. */
  readonly override?: LinuxBackendChoice;
}

/**
 * Resolves the Linux backend in order: the override, then each detection tier.
 * `undefined` means no Linux tier claims this host.
 */
export async function selectLinuxBackend(
  dependencies: LinuxBackendSelectionDependencies,
): Promise<LinuxBackendSelection | undefined> {
  if (dependencies.override !== undefined) {
    return {
      choice: dependencies.override,
      forced: true,
      reason: `SYNARA_COMPUTER_BACKEND=${dependencies.override} selected this backend explicitly, so no other backend is tried.`,
    };
  }
  return undefined;
}
