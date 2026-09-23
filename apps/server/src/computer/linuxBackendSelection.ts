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

import { KWIN_SERVICE } from "./kwinDbus.ts";

/**
 * Every Linux backend `SYNARA_COMPUTER_BACKEND` can name. Each backend adds
 * its choice here beside its detection tier in `selectLinuxBackend`, and its
 * constructor in the service layer's factory table, so the three cannot drift.
 */
export const LINUX_BACKEND_CHOICES = ["kwin"] as const;
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

/**
 * Whether this session is one the KWin plugin can be reached in at all.
 *
 * The same predicate `KWinComputerBackend` gates on, and it has to be: the
 * backend refuses a non-Wayland session outright, so selecting it for one is
 * selecting a backend that is already known to refuse. `XDG_SESSION_TYPE` is
 * what logind sets; a present `WAYLAND_DISPLAY` stands in for a session started
 * outside a login manager, where the variable is often simply absent.
 */
export function waylandSession(env: NodeJS.ProcessEnv): boolean {
  const sessionType = env.XDG_SESSION_TYPE ?? (env.WAYLAND_DISPLAY ? "wayland" : "");
  return sessionType.toLowerCase() === "wayland";
}

export interface LinuxBackendSelectionDependencies {
  readonly env?: NodeJS.ProcessEnv;
  /** The parsed `SYNARA_COMPUTER_BACKEND`, when it names a Linux tier. */
  readonly override?: LinuxBackendChoice;
  /**
   * Whether a name is owned on the session bus. Rejects when the bus itself is
   * unreachable, which the caller distinguishes from an unowned name.
   */
  readonly busNameHasOwner: (name: string) => Promise<boolean>;
}

/**
 * Resolves the Linux backend in order: the override, then each detection tier.
 * `undefined` means no Linux tier claims this host.
 *
 * The KWin tier asks the session bus who owns `org.kde.KWin` rather than
 * reading `XDG_CURRENT_DESKTOP`. The compositor is the thing that decides
 * whether the KWin plugin can load; the env var is a label a login manager
 * sets and a user can override, and on a KDE session started from a tty it is
 * often simply absent. Plasma on X11 owns the name too, and there the plugin's
 * dedicated seat does not exist, so the tier claims only a Wayland session.
 */
export async function selectLinuxBackend(
  dependencies: LinuxBackendSelectionDependencies,
): Promise<LinuxBackendSelection | undefined> {
  const env = dependencies.env ?? process.env;
  if (dependencies.override !== undefined) {
    return {
      choice: dependencies.override,
      forced: true,
      reason: `SYNARA_COMPUTER_BACKEND=${dependencies.override} selected this backend explicitly, so no other backend is tried.`,
    };
  }

  // An unreachable session bus is not evidence that KWin is absent, but it is
  // proof that the KWin plugin cannot be reached: every call to it goes over
  // that bus. It leaves this tier unclaimed rather than failing selection.
  const kwinUp = await dependencies.busNameHasOwner(KWIN_SERVICE).catch(() => false);
  if (kwinUp && waylandSession(env)) {
    return {
      choice: "kwin",
      forced: false,
      reason: `${KWIN_SERVICE} is owned on the session bus, so this is a KWin session and the KWin plugin applies.`,
    };
  }
  return undefined;
}
