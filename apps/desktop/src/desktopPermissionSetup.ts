import type { DesktopPermissionFeature, DesktopPermissionSetupState } from "@synara/contracts";
import { COMPUTER_PERMISSIONS } from "@synara/shared/computerPermissions";
import { APP_SNAP_PERMISSIONS, type DesktopPermissionService } from "./desktopPermissions";

const SETUP_LIFETIME_MS = 5 * 60_000;

/** Electron owns this loop so granting access in Settings works while the renderer is inactive. */
export class DesktopPermissionSetup {
  private state: DesktopPermissionSetupState;
  private generation = 0;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private starting: Promise<DesktopPermissionSetupState> | undefined;
  private disposed = false;
  private requestAbort = new AbortController();

  constructor(
    private readonly options: {
      appName: string;
      appPath: string | null;
      permissions: Pick<DesktopPermissionService, "check" | "request">;
      beforeStart: (feature: DesktopPermissionFeature) => Promise<void>;
      guide: { show: (state: DesktopPermissionSetupState) => void; close: () => Promise<void> };
      onState: (state: DesktopPermissionSetupState) => void;
    },
  ) {
    this.state = {
      feature: null,
      phase: "idle",
      required: [],
      grants: {},
      current: null,
      appName: options.appName,
      appPath: options.appPath,
      message: null,
    };
  }

  getState(): DesktopPermissionSetupState {
    return this.state;
  }

  start(feature: DesktopPermissionFeature): Promise<DesktopPermissionSetupState> {
    if (this.disposed) return Promise.reject(new Error("Permission setup is shutting down."));
    if (this.starting) {
      const generation = this.generation;
      return this.starting.then(() =>
        generation === this.generation && !this.disposed ? this.start(feature) : this.state,
      );
    }
    if (this.state.feature === feature && ["checking", "waiting"].includes(this.state.phase))
      return Promise.resolve(this.state);
    const stopped = this.stop();
    const generation = this.generation;
    this.starting = (async () => {
      await stopped;
      if (generation !== this.generation || this.disposed) return this.state;
      this.requestAbort = new AbortController();
      await this.options.beforeStart(feature);
      if (generation !== this.generation || this.disposed) return this.state;
      this.publish({
        ...this.state,
        feature,
        phase: "checking",
        current: null,
        grants: {},
        required: feature === "computer" ? COMPUTER_PERMISSIONS : APP_SNAP_PERMISSIONS,
        message: null,
      });
      this.deadline = setTimeout(() => {
        void this.stop("Setup paused after five minutes. Choose Set up to continue.").catch(
          () => undefined,
        );
      }, SETUP_LIFETIME_MS);
      void this.tick(generation);
      return this.state;
    })().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  async stop(message: string | null = null): Promise<void> {
    this.generation += 1;
    this.requestAbort.abort();
    clearTimeout(this.poll);
    clearTimeout(this.deadline);
    this.publish({ ...this.state, phase: "idle", current: null, message });
    await this.options.guide.close();
  }

  async retry(): Promise<void> {
    const feature = this.state.feature;
    if (!feature) return;
    await this.stop();
    await this.start(feature);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  private publish(state: DesktopPermissionSetupState): void {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.options.onState(state);
  }

  private async tick(generation: number): Promise<void> {
    try {
      const grants = await this.options.permissions.check(this.state.required);
      if (generation !== this.generation) return;
      const current =
        this.state.required.find((permission) => grants[permission] !== "granted") ?? null;
      const changedStep = current !== this.state.current;
      this.publish({
        ...this.state,
        grants,
        current,
        phase: current ? "waiting" : "complete",
        message: null,
      });
      this.options.guide.show(this.state);
      if (!current) {
        clearTimeout(this.deadline);
        // Keep the success visible briefly, without another permission check.
        this.poll = setTimeout(() => {
          if (generation === this.generation)
            void this.options.guide
              .close()
              .then(() => {
                if (generation === this.generation)
                  this.publish({ ...this.state, phase: "idle", current: null });
              })
              .catch(() => undefined);
        }, 1_500);
        return;
      }
      if (changedStep) {
        // Request/open one pane once. Polling itself never prompts or steals focus.
        await this.options.permissions.request([current], this.requestAbort.signal);
        if (generation !== this.generation) return;
      }
    } catch (error) {
      if (generation !== this.generation) return;
      this.publish({
        ...this.state,
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      // Leave the last confirmed grants intact; a failed probe is not a denial.
      this.options.guide.show(this.state);
    }
    if (generation === this.generation)
      this.poll = setTimeout(() => void this.tick(generation), 1_000);
  }
}
