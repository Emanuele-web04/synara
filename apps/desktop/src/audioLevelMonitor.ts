import * as ChildProcess from "node:child_process";
import * as Readline from "node:readline";

import type {
  DesktopAudioInputDevice,
  DesktopAudioLevelSource,
  DesktopAudioLevelStatus,
} from "@synara/contracts";

const MAX_HELPER_STDERR_CHARS = 4_000;
const LIST_INPUTS_TIMEOUT_MS = 5_000;
/** Core Audio UIDs are short; anything longer is not a device the helper listed. */
export const MAX_MICROPHONE_ID_LENGTH = 512;

/** What one renderer asked for: a source and, for the microphone, which device. */
export interface AudioLevelSubscription {
  source: DesktopAudioLevelSource;
  /** Core Audio UID; `null` follows the Mac's default input. */
  microphoneId: string | null;
}

export type AudioLevelHelperMessage =
  | { type: "ready" }
  | { type: "audio-level"; level: number }
  | { type: "error"; code: string; message: string };

export function parseAudioLevelMessage(line: string): AudioLevelHelperMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.type === "ready") return { type: "ready" };
  if (
    value.type === "audio-level" &&
    typeof value.level === "number" &&
    Number.isFinite(value.level)
  ) {
    return { type: "audio-level", level: Math.min(1, Math.max(0, value.level)) };
  }
  if (value.type === "error" && typeof value.code === "string") {
    return {
      type: "error",
      code: value.code,
      message: typeof value.message === "string" ? value.message : value.code,
    };
  }
  return null;
}

/** Combines what every subscriber asked for: mixed requests listen to both. */
export function combineAudioLevelSources(
  sources: Iterable<DesktopAudioLevelSource>,
): DesktopAudioLevelSource | null {
  let system = false;
  let microphone = false;
  for (const source of sources) {
    if (source !== "microphone") system = true;
    if (source !== "system") microphone = true;
  }
  if (system && microphone) return "both";
  if (system) return "system";
  if (microphone) return "microphone";
  return null;
}

/**
 * Combines every subscription. Sources merge as in `combineAudioLevelSources`;
 * every renderer reads the same setting, so the newest microphone choice wins.
 */
export function combineAudioLevelSubscriptions(
  subscriptions: Iterable<AudioLevelSubscription>,
): AudioLevelSubscription | null {
  const all = [...subscriptions];
  const source = combineAudioLevelSources(all.map((subscription) => subscription.source));
  if (!source) return null;
  let microphoneId: string | null = null;
  if (source !== "system") {
    for (const subscription of all) {
      if (subscription.source !== "system") microphoneId = subscription.microphoneId;
    }
  }
  return { source, microphoneId };
}

function sameSubscription(
  left: AudioLevelSubscription | null,
  right: AudioLevelSubscription | null,
): boolean {
  return left?.source === right?.source && left?.microphoneId === right?.microphoneId;
}

function helperArguments({ source, microphoneId }: AudioLevelSubscription): string[] {
  const args = ["--audio-level"];
  if (source !== "microphone") args.push("--source", "system");
  if (source !== "system") {
    args.push("--source", "microphone");
    if (microphoneId) args.push("--input-device", microphoneId);
  }
  return args;
}

export function parseAudioInputsMessage(output: string): DesktopAudioInputDevice[] {
  for (const line of output.split("\n")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const value = parsed as Record<string, unknown>;
    if (value.type !== "audio-inputs" || !Array.isArray(value.devices)) continue;
    const devices: DesktopAudioInputDevice[] = [];
    for (const raw of value.devices as unknown[]) {
      if (!raw || typeof raw !== "object") continue;
      const device = raw as Record<string, unknown>;
      if (
        typeof device.id !== "string" ||
        device.id.length === 0 ||
        device.id.length > MAX_MICROPHONE_ID_LENGTH
      ) {
        continue;
      }
      devices.push({
        id: device.id,
        name: typeof device.name === "string" && device.name.length > 0 ? device.name : device.id,
        bluetooth: device.bluetooth === true,
        default: device.default === true,
      });
    }
    return devices;
  }
  return [];
}

/** Asks the helper for the Mac's input devices. Opens no device; fails closed to an empty list. */
export function listAudioInputDevices(
  helperPath: string,
  execFile: typeof ChildProcess.execFile = ChildProcess.execFile,
): Promise<DesktopAudioInputDevice[]> {
  return new Promise((resolve) => {
    execFile(
      helperPath,
      ["--list-audio-inputs"],
      { timeout: LIST_INPUTS_TIMEOUT_MS, encoding: "utf8" },
      (error, stdout) => {
        resolve(error ? [] : parseAudioInputsMessage(String(stdout)));
      },
    );
  });
}

export interface AudioLevelMonitorOptions {
  helperPath: string;
  /** Every level the helper reports, in 0..1, while at least one subscriber is on. */
  onLevel: (level: number) => void;
  onError?: (message: string) => void;
  /** Injectable for tests. */
  spawn?: typeof ChildProcess.spawn;
}

/**
 * Owns the `--audio-level` helper process for the desktop.
 *
 * The helper only runs while some renderer has asked for levels: the first
 * subscriber spawns it, a change of source or microphone restarts it,
 * and the last one leaving terminates it, so an idle app holds no audio tap or
 * microphone and shows no recording indicator. A helper that fails (old macOS,
 * missing grant) is not respawned; the next subscription change tries again.
 */
export class AudioLevelMonitor {
  #options: AudioLevelMonitorOptions;
  #spawn: typeof ChildProcess.spawn;
  #child: ChildProcess.ChildProcess | null = null;
  #childSubscription: AudioLevelSubscription | null = null;
  #subscribers = new Map<number, AudioLevelSubscription>();
  #status: DesktopAudioLevelStatus = "off";

  constructor(options: AudioLevelMonitorOptions) {
    this.#options = options;
    this.#spawn = options.spawn ?? ChildProcess.spawn;
  }

  get status(): DesktopAudioLevelStatus {
    return this.#status;
  }

  get isRunning(): boolean {
    return this.#child !== null;
  }

  /** `null` drops the subscriber; a source subscribes or switches it. */
  setSubscription(
    subscriberId: number,
    source: DesktopAudioLevelSource | null,
    microphoneId: string | null = null,
  ): DesktopAudioLevelStatus {
    if (source) this.#subscribers.set(subscriberId, { source, microphoneId });
    else this.#subscribers.delete(subscriberId);

    const wanted = combineAudioLevelSubscriptions(this.#subscribers.values());
    if (!wanted) {
      this.#stopHelper();
      this.#status = "off";
      return "off";
    }
    if (!sameSubscription(wanted, this.#childSubscription)) {
      this.#stopHelper();
      this.#startHelper(wanted);
    }
    return this.#status;
  }

  dispose(): void {
    this.#subscribers.clear();
    this.#stopHelper();
    this.#status = "off";
  }

  #startHelper(subscription: AudioLevelSubscription): void {
    this.#status = "active";
    this.#childSubscription = subscription;
    const child = this.#spawn(this.#options.helperPath, helperArguments(subscription), {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.#child = child;

    const lines = Readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (this.#child !== child) return;
      const message = parseAudioLevelMessage(line);
      if (!message) return;
      if (message.type === "audio-level") this.#options.onLevel(message.level);
      else if (message.type === "error") {
        this.#status = "unavailable";
        this.#options.onError?.(`${message.code}: ${message.message}`);
      }
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length >= MAX_HELPER_STDERR_CHARS) return;
      stderr = `${stderr}${chunk}`.slice(0, MAX_HELPER_STDERR_CHARS);
    });

    child.once("error", () => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#childSubscription = null;
      this.#status = "unavailable";
      this.#options.onError?.("The audio level helper could not start.");
    });
    child.once("close", (code) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#childSubscription = null;
      this.#status = "unavailable";
      // A dead reader leaves the trail at rest instead of frozen mid-swing.
      this.#options.onLevel(0);
      const diagnostic = stderr.trim();
      if (code !== 0 && diagnostic.length > 0) {
        this.#options.onError?.(`Audio level helper: ${diagnostic}`);
      }
    });
  }

  #stopHelper(): void {
    const child = this.#child;
    this.#child = null;
    this.#childSubscription = null;
    if (!child) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // Best effort; the helper also exits itself once its parent is gone.
    }
  }
}
