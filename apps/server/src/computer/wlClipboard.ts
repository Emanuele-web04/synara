/**
 * Clipboard access through the wl-clipboard binaries.
 *
 * The clipboard reached here is seat0's, the human's, and that is deliberate.
 * A Wayland client binds its data device to one seat — seat0 for every Qt and
 * GTK toolkit build we drive — no matter which seat delivered its input, so the
 * dedicated synara-agent seat cannot hold a private working clipboard: a
 * synthesized Ctrl+C on it either fails the compositor's serial validation
 * silently or writes the human's clipboard anyway. These helpers therefore
 * address the selection directly and never synthesize copy/paste keystrokes.
 *
 * No `--seat` flag is passed, which leaves wl-clipboard on the first seat the
 * compositor advertises. That is seat0: it exists from compositor startup,
 * while the agent seat only appears once the KWin plugin creates it.
 */
import { spawn } from "node:child_process";

import { desktopApplicationEnvironment } from "./desktopAppEnvironment.ts";
import { commandOnPath } from "./provisioning/systemPackages.ts";

import {
  assertComputerClipboardWriteFits,
  ComputerBackendError,
  MAX_COMPUTER_CLIPBOARD_BYTES,
} from "./ComputerBackend.ts";

/** Enough stderr to quote a wl-clipboard diagnostic, never enough to hold a payload. */
const MAX_CLIPBOARD_STDERR_BYTES = 8 * 1024;
/**
 * A selection is served by the application that owns it, so a wedged app can
 * hold the pipe open indefinitely. The deadline bounds what that costs a turn.
 */
const CLIPBOARD_TIMEOUT_MS = 5_000;
/**
 * How long a paste-once offer is watched before its pipe is let go. An offer
 * ends when it is pasted or replaced, and paste always replaces it with the
 * human's clipboard within seconds; this only bounds a restore that failed.
 */
const PASTE_OFFER_WATCH_MS = 30_000;

const WL_COPY = "wl-copy";
const WL_PASTE = "wl-paste";
const WL_CLIPBOARD_PACKAGE = "wl-clipboard";
export const CLIPBOARD_SETUP_INCOMPLETE_MESSAGE =
  "Clipboard setup is incomplete. Install wl-clipboard and make sure wl-copy and wl-paste are on Synara's PATH, then click Set up again.";

/** Both directions must be installed before advertising clipboard support. */
export function wlClipboardToolsPresent(
  hasCommand: (command: string) => boolean = commandOnPath,
): boolean {
  return hasCommand(WL_COPY) && hasCommand(WL_PASTE);
}

/**
 * Generic type name: wl-paste picks any offered `text/*` representation, and
 * refuses a selection that has none. Without it wl-paste falls back to the
 * first offered type and would stream an image's raw bytes as "text".
 */
const CLIPBOARD_READ_TYPE = "text";
/**
 * Explicit on the write side because wl-copy otherwise infers the type from the
 * content, and infers zero bytes as `application/x-zerosize`, which reads back
 * as a non-text selection. wl-copy offers the same text aliases either way.
 */
const CLIPBOARD_WRITE_TYPE = "text/plain";

/** wl-clipboard is not localized, so its diagnostics are stable to match on. */
const EMPTY_CLIPBOARD_PATTERN = /nothing is copied/i;
const NON_TEXT_CLIPBOARD_PATTERN = /not available as requested type|no suitable type of content/i;

export interface ClipboardCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to stdin, never to argv, so clipboard text stays out of /proc cmdline. */
  readonly input?: string;
  /**
   * wl-copy forks a background child that keeps serving the selection and
   * inherits the parent's stderr, so waiting for the pipes to close would wait
   * for the next clipboard change. Only the parent's exit is awaited.
   */
  readonly forks?: boolean;
  /**
   * For a forking command: keep the stderr pipe the background child inherits
   * and report, as `forkExited`, when it closes — that is, when the child has
   * exited. wl-copy's child points stdin and stdout at /dev/null but keeps
   * stderr, so this is the only handle on it.
   *
   * The command is also started as the leader of its own process group, which
   * its fork inherits (wl-copy forks without `setsid`), so `endFork` can end a
   * child whose pid nothing reports.
   */
  readonly observeFork?: boolean;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export interface ClipboardCommandResult {
  /** `exited` carries a real status; the other outcomes mean the child was killed. */
  readonly outcome: "exited" | "timed-out" | "output-limit";
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Settles when a forked child has exited; see `ClipboardCommandSpec.observeFork`. */
  readonly forkExited?: Promise<void>;
  /** Ends that forked child now, if it is still running. */
  readonly endFork?: () => void;
}

export type ClipboardCommandRunner = (
  spec: ClipboardCommandSpec,
) => Promise<ClipboardCommandResult>;

/** Reads the seat0 clipboard as text; an empty clipboard reads as `""`. */
export async function readWlClipboard(run: ClipboardCommandRunner): Promise<string> {
  const result = await runClipboardCommand(run, {
    command: WL_PASTE,
    args: ["--no-newline", "--type", CLIPBOARD_READ_TYPE],
    maxOutputBytes: MAX_COMPUTER_CLIPBOARD_BYTES,
  });
  if (result.outcome === "output-limit") {
    throw new ComputerBackendError(
      `The desktop clipboard holds more than ${MAX_COMPUTER_CLIPBOARD_BYTES} bytes of text, which is past the limit this tool reads.`,
    );
  }
  if (result.outcome === "timed-out") {
    throw new ComputerBackendError(
      `${WL_PASTE} did not return within ${CLIPBOARD_TIMEOUT_MS}ms; the application owning the clipboard is not serving it.`,
      { retryable: true },
    );
  }
  if (result.code === 0) return result.stdout;
  // An empty clipboard is a non-zero exit rather than empty output, and is a
  // normal state the agent should read as "nothing copied", not as a failure.
  if (EMPTY_CLIPBOARD_PATTERN.test(result.stderr)) return "";
  if (NON_TEXT_CLIPBOARD_PATTERN.test(result.stderr)) {
    throw new ComputerBackendError(
      "The desktop clipboard holds non-text content, such as an image or a file, which cannot be read as text.",
    );
  }
  throw new ComputerBackendError(
    `${WL_PASTE} failed to read the desktop clipboard: ${describeFailure(result)}`,
  );
}

/** Replaces the seat0 clipboard, which discards whatever the human last copied. */
export async function writeWlClipboard(run: ClipboardCommandRunner, text: string): Promise<void> {
  assertComputerClipboardWriteFits(text);
  const result = await runClipboardCommand(run, {
    command: WL_COPY,
    args: ["--type", CLIPBOARD_WRITE_TYPE],
    input: text,
    forks: true,
  });
  if (result.outcome === "exited" && result.code === 0) return;
  throw new ComputerBackendError(
    `${WL_COPY} failed to write the desktop clipboard: ${describeFailure(result)}`,
    { retryable: result.outcome === "timed-out" },
  );
}

/**
 * Offers `text` on the seat0 clipboard for exactly one paste, and says when
 * that paste has read it.
 *
 * `wl-copy --paste-once` serves a single request and exits, and it also exits
 * when anything else takes the clipboard — so `consumed` settles when the
 * target has read the payload or the offer was replaced, and the caller puts
 * the human's clipboard back then rather than after a guessed delay. Resolves,
 * like `writeWlClipboard`, once the payload is on the clipboard.
 */
export async function writeWlClipboardForPaste(
  run: ClipboardCommandRunner,
  text: string,
): Promise<{ readonly consumed: Promise<void>; readonly withdraw: () => void }> {
  assertComputerClipboardWriteFits(text);
  const result = await runClipboardCommand(run, {
    command: WL_COPY,
    args: ["--paste-once", "--type", CLIPBOARD_WRITE_TYPE],
    input: text,
    forks: true,
    observeFork: true,
  });
  if (result.outcome === "exited" && result.code === 0) {
    const consumed =
      result.forkExited ??
      Promise.reject(new Error(`${WL_COPY} gave no handle on its paste-once offer.`));
    // The caller may never look (a shortcut that failed before the paste).
    consumed.catch(() => undefined);
    // Withdrawing an offer nobody pasted clears the clipboard: the compositor
    // drops a selection whose source is gone.
    return { consumed, withdraw: () => result.endFork?.() };
  }
  throw new ComputerBackendError(
    `${WL_COPY} failed to write the desktop clipboard: ${describeFailure(result)}`,
    { retryable: result.outcome === "timed-out" },
  );
}

async function runClipboardCommand(
  run: ClipboardCommandRunner,
  spec: ClipboardCommandSpec,
): Promise<ClipboardCommandResult> {
  try {
    return await run(spec);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new ComputerBackendError(
        `${spec.command} is not installed, so the desktop clipboard cannot be used. Install the ${WL_CLIPBOARD_PACKAGE} package.`,
        { cause: error },
      );
    }
    throw new ComputerBackendError(
      `Failed to run ${spec.command}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function describeFailure(result: ClipboardCommandResult): string {
  if (result.outcome === "timed-out") return `timed out after ${CLIPBOARD_TIMEOUT_MS}ms`;
  if (result.outcome === "output-limit")
    return `produced more than ${MAX_COMPUTER_CLIPBOARD_BYTES} bytes`;
  const detail = result.stderr.trim().split("\n")[0];
  return detail && detail.length > 0 ? detail : `exit status ${result.code ?? "unknown"}`;
}

/**
 * Spawns one wl-clipboard process. Only spawn failures reject — an ENOENT for a
 * missing binary — so every exit status is mapped in one place above.
 *
 * `env` overrides the inherited environment and is how a nested compositor's
 * clipboard is reached: wl-clipboard talks to whichever `WAYLAND_DISPLAY` it is
 * handed, so the same code addresses the ambient session and a Tier 3 one.
 *
 * The process gets the desktop session's variables and nothing of the
 * server's (see `desktopApplicationEnvironment`): `wl-copy` forks and stays
 * alive holding the selection, and it has no use for the server's auth token
 * or provider keys.
 */
export function spawnClipboardCommand(
  spec: ClipboardCommandSpec,
  env?: NodeJS.ProcessEnv,
): Promise<ClipboardCommandResult> {
  const maxOutputBytes = spec.maxOutputBytes ?? MAX_COMPUTER_CLIPBOARD_BYTES;
  const timeoutMs = spec.timeoutMs ?? CLIPBOARD_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const observeFork = spec.forks === true && spec.observeFork === true;
    const child = spawn(spec.command, [...spec.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: desktopApplicationEnvironment(process.env, env),
      // Its own process group, so the fork it leaves behind can be signalled.
      ...(observeFork ? { detached: true } : {}),
    });
    const stdout = new ChunkBuffer(maxOutputBytes);
    const stderr = new ChunkBuffer(MAX_CLIPBOARD_STDERR_BYTES);
    let outcome: ClipboardCommandResult["outcome"] = "exited";
    let settled = false;

    const timer = setTimeout(() => {
      outcome = "timed-out";
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A forking wl-copy leaves its background child holding these pipes, so
      // they are released here rather than waited on — except stderr when the
      // caller watches the child through it.
      child.stdout.destroy();
      const fork =
        observeFork && outcome === "exited" && code === 0 ? watchForkExit(child) : undefined;
      if (!fork) child.stderr.destroy();
      // An output-limit run has no usable stdout — the buffer refuses to
      // pretend its truncated prefix is the real thing.
      const readStdout = () => {
        try {
          return stdout.text();
        } catch {
          return "";
        }
      };
      resolve({
        outcome,
        code,
        stdout: readStdout(),
        stderr: stderr.diagnostic(),
        ...(fork ? { forkExited: fork.exited, endFork: fork.end } : {}),
      });
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.push(chunk)) return;
      outcome = "output-limit";
      child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("exit", (code) => {
      if (spec.forks === true || outcome !== "exited") settle(code);
    });
    child.on("close", (code) => settle(code));

    // The child may exit before it consumes the payload, which surfaces as an
    // exit status rather than as an unhandled stdin error.
    child.stdin.on("error", () => undefined);
    child.stdin.end(spec.input ?? "");
  });
}

/**
 * Watches the forked child holding `child`'s stderr pipe: `exited` settles when
 * the pipe's last writer is gone, and `end` signals the child's process group
 * (the command's own, see `observeFork`) while it is still there. Bounded: an
 * offer still open after the watch is stale, and is ended rather than left on
 * the clipboard for the life of the server.
 */
function watchForkExit(child: ReturnType<typeof spawn>): {
  readonly exited: Promise<void>;
  readonly end: () => void;
} {
  const stream = child.stderr;
  if (!stream || stream.destroyed || stream.readableEnded) {
    return { exited: Promise.resolve(), end: () => undefined };
  }
  let open = true;
  const end = () => {
    // Only while the pipe is open: a live member keeps the group, so its id
    // cannot have been reused by anything else.
    if (!open || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  };
  const exited = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      end();
      open = false;
      stream.destroy();
      reject(
        new Error(`${WL_COPY}'s paste-once offer was still open after ${PASTE_OFFER_WATCH_MS}ms.`),
      );
    }, PASTE_OFFER_WATCH_MS);
    timer.unref?.();
    const done = () => {
      open = false;
      clearTimeout(timer);
      resolve();
    };
    stream.once("close", done);
    stream.once("end", done);
    // Drained so the child can never block on a full pipe; the text is not read.
    stream.resume();
    // The watch must not keep the server alive on its own.
    (stream as { unref?: () => void }).unref?.();
  });
  return { exited, end };
}

class ChunkBuffer {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private overflowed = false;

  constructor(private readonly limit: number) {}

  /** `false` once the limit is passed, and the chunk is dropped. */
  push(chunk: Buffer): boolean {
    if (this.overflowed || this.bytes + chunk.byteLength > this.limit) {
      this.overflowed = true;
      return false;
    }
    this.bytes += chunk.byteLength;
    this.chunks.push(chunk);
    return true;
  }

  /**
   * Throws after an overflow rather than returning the arbitrary prefix that
   * survived: a truncated read must be recognizable as one, never mistaken for
   * the clipboard's actual contents.
   */
  text(): string {
    if (this.overflowed) {
      throw new ComputerBackendError(
        `The stream exceeded its ${this.limit} byte limit, so no usable text was captured.`,
      );
    }
    return Buffer.concat(this.chunks).toString("utf8");
  }

  diagnostic(): string {
    return (
      Buffer.concat(this.chunks).toString("utf8") +
      (this.overflowed ? " [diagnostic truncated]" : "")
    );
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as Record<string, unknown>).code
    : undefined;
}
