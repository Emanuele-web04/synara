import { join } from "node:path";
import { ServerConfig } from "../../config.ts";
import { Effect, Layer, Option } from "effect";
import type { ComputerAvailability } from "@synara/contracts";

import { CUA_HOST_SOCKET_ENV } from "@synara/shared/cuaDriverProtocol";
import { ComputerManager } from "../ComputerManager.ts";
import { CuaComputerBackend } from "../CuaComputerBackend.ts";
import { FakeComputerBackend } from "../FakeComputerBackend.ts";
import { HyprlandComputerBackend } from "../HyprlandComputerBackend.ts";
import { KWinComputerBackend } from "../KWinComputerBackend.ts";
import { NestedComputerBackend } from "../nestedComputerBackend.ts";
import { nestedAtspiMode, parseNestedSizeEnv } from "../nestedKWinSession.ts";
import { sessionBusNameHasOwner } from "../sessionBusNames.ts";
import { UnavailableComputerBackend } from "../UnavailableComputerBackend.ts";
import { ComputerService, type ComputerServiceShape } from "../Services/ComputerService.ts";
import type { ComputerBackend } from "../ComputerBackend.ts";
import {
  CheckingComputerBackend,
  SwitchableComputerBackend,
} from "../switchableComputerBackend.ts";
import {
  isLinuxBackendChoice,
  nestedModeForChoice,
  parseComputerBackendOverride,
  selectLinuxBackend,
  type ComputerBackendOverride,
  type LinuxBackendChoice,
  type LinuxBackendSelectionDependencies,
} from "../linuxBackendSelection.ts";
import { resolveBrowserHostCapability } from "../../browserAutomation/browserHostRpcClient.ts";
import {
  activeComputerGuidanceProfile,
  setActiveComputerGuidanceProfile,
} from "../../agentGateway/computerGuidance.ts";

export interface ComputerServiceLiveOptions {
  /** Inject a real or fake backend. */
  readonly backend?: ComputerBackend;
  /** Test/embedding override for the final availability decision. */
  readonly supported?: boolean;
  /** Test override for the host platform; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /**
   * Test override for backend selection: the environment the override, the
   * host socket and the Linux tiers are read from (defaults to the process
   * environment), and the Linux detection probes (default to the live host).
   */
  readonly selection?: Partial<Omit<LinuxBackendSelectionDependencies, "override">>;
  /** Test override for `COMPUTER_SELECTION_STARTUP_BUDGET_MS`. */
  readonly selectionBudgetMs?: number;
  /** Test override for how a selected Linux tier is constructed. */
  readonly linuxBackends?: Partial<Record<LinuxBackendChoice, () => ComputerBackend>>;
}

/**
 * The constructor behind each Linux choice. Keyed by the choice so a backend
 * that registers a tier in `linuxBackendSelection.ts` cannot forget to say how
 * it is built; the type fails the build otherwise.
 */
const LINUX_BACKENDS: Record<LinuxBackendChoice, () => ComputerBackend> = {
  // Constructed, not connected: the backend touches the compositor on first
  // real use, and its `provision()` is the settings panel's one-click setup.
  kwin: () => new KWinComputerBackend(),
  // The same real-desktop tier on a Hyprland session: the plugin loads live
  // through hyprctl, so construction touches nothing.
  hyprland: () => new HyprlandComputerBackend(),
  // Constructed, not booted: the nested compositor is expensive and — in
  // window mode — visible, so nothing may appear because a server started.
  // The backend boots its session on first real use. The geometry comes from
  // `SYNARA_COMPUTER_NESTED_SIZE=WxH`. A session that fails to boot stays
  // failed: falling back to the real desktop would hand an agent the human's
  // screen right after an operator asked for an isolated one.
  nested: () => makeNestedBackend("nested"),
  "nested-window": () => makeNestedBackend("nested-window"),
};

function makeNestedBackend(choice: "nested" | "nested-window"): ComputerBackend {
  const size = parseNestedSizeEnv(process.env.SYNARA_COMPUTER_NESTED_SIZE);
  return new NestedComputerBackend({
    mode: nestedModeForChoice(choice) ?? "virtual",
    ...(size ? { size } : {}),
    atspiMode: nestedAtspiMode(),
  });
}

let warnedMissingControlStatePath = false;

/**
 * How long startup waits for Linux backend selection, and then for its passive
 * probe, before carrying on without the answer. A healthy host answers both in
 * milliseconds, so this only ever matters on a wedged session bus, where each
 * question would otherwise hold boot for its full D-Bus timeout.
 */
export const COMPUTER_SELECTION_STARTUP_BUDGET_MS = 1_500;

const CHECKING_MESSAGE = "Synara is still detecting this computer's desktop.";

export function makeComputerServiceLayer(options: ComputerServiceLiveOptions = {}) {
  return Layer.effect(
    ComputerService,
    Effect.gen(function* () {
      const platform = options.platform ?? process.platform;
      const plan: BackendPlan = options.backend
        ? { kind: "ready", backend: options.backend }
        : planBackend(platform, options.selection, options.linuxBackends);
      // Linux selection and its passive probe share one startup budget. What
      // is known when it runs out is what the manager starts on; the rest
      // arrives in the background (see `LinuxBackendStartup`).
      const linux =
        plan.kind === "linux"
          ? yield* Effect.promise(() =>
              LinuxBackendStartup.begin(
                plan,
                options.selectionBudgetMs ?? COMPUTER_SELECTION_STARTUP_BUDGET_MS,
              ),
            )
          : undefined;
      const backend = linux?.slot.backend ?? (plan as ReadyBackendPlan).backend;
      const config = yield* Effect.serviceOption(ServerConfig);
      if (Option.isNone(config) && !warnedMissingControlStatePath) {
        warnedMissingControlStatePath = true;
        yield* Effect.logWarning(
          "computer control state path unavailable; using in-memory control state",
        );
      }
      const manager = new ComputerManager({
        backend,
        ...(Option.isSome(config)
          ? {
              controlStatePath: join(config.value.stateDir, "computer-control.json"),
              // Beside the control state: the bounded mutating-call audit log,
              // local-only and dropped-oldest past its caps.
              auditLogPath: join(config.value.stateDir, "computer-audit.jsonl"),
            }
          : {}),
      });
      // The session-start guidance describes the one desktop this process
      // drives, and it is rendered by provider adapters that never see the
      // backend, so the manager's profile is registered here — where the
      // backend is chosen — for the lifetime of the service, registered again
      // whenever the Linux slot takes a different backend, and cleared only if
      // it is still the one this service registered.
      // Every occupant change from here on is a desktop operation of its own:
      // see `ComputerManager.replaceDesktop`.
      linux?.serializeSwaps((swap) => manager.replaceDesktop(swap));
      let guidanceProfile = manager.guidanceProfile;
      setActiveComputerGuidanceProfile(guidanceProfile);
      linux?.onBackendChanged(() => {
        if (activeComputerGuidanceProfile() !== guidanceProfile) return;
        guidanceProfile = manager.guidanceProfile;
        setActiveComputerGuidanceProfile(guidanceProfile);
      });
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          linux?.stop();
          if (activeComputerGuidanceProfile() === guidanceProfile) {
            setActiveComputerGuidanceProfile(undefined);
          }
          await manager.dispose();
        }),
      );
      let availability: ComputerAvailability;
      if (options.supported === undefined) {
        // The passive probe, never the establishing read. Boot runs for every
        // user of every build, long before anyone has asked for a desktop —
        // and on a Linux compositor backend the establishing read installs a
        // plugin and loads it into the live desktop.
        availability = linux
          ? yield* Effect.promise(() => linux.probeWithinBudget())
          : yield* Effect.promise(() => backend.probeAvailability());
      } else if (options.supported) {
        availability = { kind: "available", backend: "test-override" };
      } else {
        availability = {
          kind: "backend-unavailable",
          message: "Computer support is disabled by the service configuration.",
        };
      }
      return {
        // Supported backends remain routable even before setup grants access,
        // and so is a slot still selecting its tier. Read as the slot's
        // occupant changes: selection may land on no backend at all.
        get supported() {
          return (
            options.supported ??
            !((linux?.slot.current ?? backend) instanceof UnavailableComputerBackend)
          );
        },
        // A Linux probe that outlived the budget lands here when it answers.
        get availability() {
          return options.supported === undefined && linux
            ? (linux.probedAvailability ?? availability)
            : availability;
        },
        manager,
      } satisfies ComputerServiceShape;
    }),
  );
}

/**
 * Linux backend selection, off the startup path.
 *
 * Selection and the passive probe both ask the session bus, and a wedged bus
 * answers each question only at its D-Bus timeout. `begin` waits for
 * selection for at most the budget; the manager is built on a slot holding the
 * selected backend, or a "checking" placeholder when selection is still
 * running, and the slot takes the selected backend whenever it arrives. The
 * probe gets what is left of the same budget.
 *
 * It also answers `desktop-gone`: when the occupant's desktop has ended for
 * good, selection runs again and a different tier replaces it. An explicit
 * override is never re-selected — the operator named that backend, and a
 * silent fallback would hand the agent a desktop nobody chose.
 */
class LinuxBackendStartup {
  readonly slot: SwitchableComputerBackend;
  probedAvailability: ComputerAvailability | undefined;

  private current: SelectedBackend;
  private readonly settled: Promise<ComputerBackend | undefined>;
  private readonly changeListeners = new Set<() => void>();
  private reselecting = false;
  private stopped = false;
  /** How a swap reaches the slot once the manager exists; see `serializeSwaps`. */
  private runSwap: (swap: () => Promise<void>) => Promise<void> = (swap) => swap();

  static async begin(plan: LinuxBackendPlan, budgetMs: number): Promise<LinuxBackendStartup> {
    const deadline = performance.now() + budgetMs;
    const selecting = plan.select().catch(
      (error: unknown): SelectedBackend => ({
        backend: new UnavailableComputerBackend(describeError(error)),
      }),
    );
    const early = await withinBudget(selecting, budgetMs);
    return new LinuxBackendStartup(plan, selecting, early, deadline);
  }

  private constructor(
    private readonly plan: LinuxBackendPlan,
    selecting: Promise<SelectedBackend>,
    early: SelectedBackend | undefined,
    private readonly deadline: number,
  ) {
    this.current = early ?? { backend: new CheckingComputerBackend(CHECKING_MESSAGE) };
    this.slot = new SwitchableComputerBackend(this.current.backend, {
      onDesktopGone: (gone) => this.reselect(gone),
    });
    this.settled = early
      ? Promise.resolve(early.backend)
      : selecting.then(async (selected) => {
          if (this.stopped) {
            await selected.backend.dispose();
            return undefined;
          }
          await this.adopt(selected);
          return selected.backend;
        });
  }

  /**
   * Routes every later occupant change through `run` — the manager's desktop
   * operation queue — so a swap never lands in the middle of an action. Until
   * the manager exists nothing can be running, and swaps apply directly.
   */
  serializeSwaps(run: (swap: () => Promise<void>) => Promise<void>): void {
    this.runSwap = run;
  }

  onBackendChanged(listener: () => void): void {
    this.changeListeners.add(listener);
  }

  /** The passive probe of the selected backend, or "checking" past the budget. */
  async probeWithinBudget(): Promise<ComputerAvailability> {
    const probing = this.settled.then((backend) =>
      backend ? backend.probeAvailability() : undefined,
    );
    void probing.then(
      (late) => {
        if (late !== undefined) this.probedAvailability = late;
      },
      () => undefined,
    );
    const inBudget = await withinBudget(probing, Math.max(0, this.deadline - performance.now()));
    return inBudget ?? { kind: "checking", message: CHECKING_MESSAGE };
  }

  stop(): void {
    this.stopped = true;
    this.changeListeners.clear();
  }

  private async adopt(
    selected: SelectedBackend,
    options?: { readonly desktopChanged?: boolean },
  ): Promise<void> {
    this.current = selected;
    await this.runSwap(() => this.slot.swap(selected.backend, options));
    for (const listener of this.changeListeners) listener();
  }

  private reselect(gone: ComputerBackend): void {
    if (this.plan.forced || this.reselecting || this.stopped) return;
    this.reselecting = true;
    void this.plan
      .select()
      .then(async (next) => {
        // The same tier again is the occupant's own reconnect to handle (a
        // backend that reports desktop-gone keeps looking for its desktop;
        // see the event's contract); a newer occupant already replaced the
        // one that reported.
        if (this.stopped || this.slot.current !== gone || next.choice === this.current.choice) {
          await next.backend.dispose();
          return;
        }
        await this.adopt(next, { desktopChanged: true });
        await gone.dispose();
      })
      .catch(() => undefined)
      .finally(() => {
        this.reselecting = false;
      });
  }
}

/**
 * The backend this server drives, in order: the explicit override, the Linux
 * tier that claims this host, the Cua host where one is reachable, and
 * otherwise a backend that says why there is none.
 *
 * An override is honored or refused, never bypassed: a malformed value and a
 * Linux choice off Linux both become the unavailable backend carrying the
 * reason, so an operator typo shows up as an availability card listing the
 * backends that do exist rather than as a different backend that seems to
 * ignore the variable.
 *
 * Cua comes after the Linux tiers on purpose. The desktop app always
 * configures its host socket, on Linux too, so socket presence cannot be what
 * decides between a compositor backend and the observation-only Cua host;
 * Cua on Linux is reached by naming it, or as what is left when no tier
 * claims the host.
 */
function planBackend(
  platform: NodeJS.Platform,
  selection: ComputerServiceLiveOptions["selection"],
  linuxBackends: ComputerServiceLiveOptions["linuxBackends"],
): BackendPlan {
  const env = selection?.env ?? process.env;
  let override: ComputerBackendOverride | undefined;
  try {
    override = parseComputerBackendOverride(env.SYNARA_COMPUTER_BACKEND);
  } catch (error) {
    return { kind: "ready", backend: new UnavailableComputerBackend(describeError(error)) };
  }
  if (override === "fake") return { kind: "ready", backend: new FakeComputerBackend() };
  if (override === "cua") return { kind: "ready", backend: makeCuaBackend() };
  if (isLinuxBackendChoice(override) && platform !== "linux") {
    return {
      kind: "ready",
      backend: new UnavailableComputerBackend(
        `SYNARA_COMPUTER_BACKEND=${override} names a Linux desktop backend, and this server runs on ${platform}.`,
        { availability: { kind: "unsupported-platform", platform } },
      ),
    };
  }
  if (platform !== "linux") return { kind: "ready", backend: fallbackBackend(platform, env) };
  const forcedChoice = isLinuxBackendChoice(override) ? override : undefined;
  return {
    kind: "linux",
    forced: forcedChoice !== undefined,
    select: async () => {
      const linux = await selectLinuxBackend({
        env,
        busNameHasOwner: selection?.busNameHasOwner ?? sessionBusNameHasOwner,
        ...(selection?.hyprlandSessionPresent
          ? { hyprlandSessionPresent: selection.hyprlandSessionPresent }
          : {}),
        ...(forcedChoice !== undefined ? { override: forcedChoice } : {}),
      });
      if (!linux) return { backend: fallbackBackend(platform, env) };
      // Annotated: with no tier registered the choice is `never`, and so
      // would the factory be.
      const make: () => ComputerBackend =
        linuxBackends?.[linux.choice] ?? LINUX_BACKENDS[linux.choice];
      return { backend: make(), choice: linux.choice };
    },
  };
}

/**
 * Where selection lands when no Linux tier claims the host (which on Linux
 * does not happen today, but the fallthrough is kept honest) and on every
 * other platform.
 */
function fallbackBackend(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ComputerBackend {
  // macOS runs the bundled host the desktop app provisions; on other
  // platforms the same backend is routable when a host endpoint is
  // configured explicitly (the provisioned upstream driver serving the
  // same socket protocol). No endpoint means no backend — the gate is
  // reachability, never platform optimism.
  const hostEndpoint = env[CUA_HOST_SOCKET_ENV]?.trim();
  if (platform === "darwin" || hostEndpoint) return makeCuaBackend();
  return new UnavailableComputerBackend(
    `No computer backend is configured for this server running on ${platform}.`,
    {
      availability:
        platform === "linux"
          ? {
              kind: "backend-unavailable",
              message: "No computer backend is available on this server.",
            }
          : { kind: "unsupported-platform", platform },
    },
  );
}

interface SelectedBackend {
  readonly backend: ComputerBackend;
  /** The Linux tier, when selection chose one; compared on re-selection. */
  readonly choice?: LinuxBackendChoice;
}

/**
 * What startup does to find its backend: use one it already has, or run Linux
 * selection, which asks the session bus and so may take as long as a wedged
 * bus makes it. `forced` is an explicit override, which is never re-selected.
 */
type BackendPlan = ReadyBackendPlan | LinuxBackendPlan;

interface ReadyBackendPlan {
  readonly kind: "ready";
  readonly backend: ComputerBackend;
}

interface LinuxBackendPlan {
  readonly kind: "linux";
  readonly forced: boolean;
  readonly select: () => Promise<SelectedBackend>;
}

/** The value, if `promise` settles with one inside `budgetMs`; a rejection is not waited out. */
async function withinBudget<A>(promise: Promise<A>, budgetMs: number): Promise<A | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), budgetMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.catch(() => undefined), expired]);
  } finally {
    clearTimeout(timer);
  }
}

function makeCuaBackend(): ComputerBackend {
  return new CuaComputerBackend({ capability: resolveBrowserHostCapability() ?? undefined });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const ComputerServiceLive = makeComputerServiceLayer();
