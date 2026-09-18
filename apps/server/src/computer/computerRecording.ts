import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { release, platform as osPlatform } from "node:os";
import { join } from "node:path";

import type { ComputerPoint, ComputerRect, ComputerUiNode } from "@synara/contracts";

/**
 * Structured session recording for computer use — the `computer_recording`
 * artifact.
 *
 * What it is: an append-only NDJSON document per recording session, one file
 * per session under the server state dir (`computer-recordings/`). Each file
 * is a header line naming the session, the thread it belongs to, the turn it
 * opened on, the fidelity it was started with, and an environment fingerprint
 * — then one `step` line per recorded tool call or `computer_run` step, then
 * an `end` line when the session closes.
 *
 * What it is not: it is not a screen recording. No screenshot, frame, or
 * video bytes are ever written, at any fidelity. The records are structured
 * action/outcome evidence — what was asked, what it resolved to, what was
 * dispatched, what the backend could prove — the same facts the local audit
 * log keeps, plus the target identity a replay needs.
 *
 * Redaction is the default and the contract:
 *
 * - `redacted` fidelity stores payload-bearing arguments (typed text, set
 *   values, clipboard writes, launch argument lists, file paths) as
 *   `{chars, sha256}` — length plus a content hash, never the plaintext. The
 *   hash lets a later reader prove two payloads were the same text without
 *   the file ever holding it.
 * - `full` fidelity keeps those payloads verbatim so a replay can re-issue
 *   them. It exists because replaying a text step needs the text; it is an
 *   explicit per-session opt-in (the tool asks for fresh consent), and it
 *   still never stores a payload that landed on a protected field.
 * - A target that resolved to a protected text control — an AX secure text
 *   field or any role spelling `secure`/`password` — is marked `secure` on
 *   the resolution, and the step's payloads are length+hash even under `full`
 *   fidelity. There is no flag that lifts this.
 *
 * Window titles and accessibility labels of resolved nodes are hashed, never
 * stored verbatim — a title carries a document name, which is exactly the
 * kind of incidental secret a recording must not collect. The *declared*
 * target keeps the label the caller wrote, because re-resolution needs it;
 * that string came from the model, not off the user's screen.
 *
 * Bounds: at most {@link COMPUTER_RECORDING_MAX_STEPS} steps and
 * {@link COMPUTER_RECORDING_MAX_BYTES} bytes per session (crossing either
 * closes the session), and across sessions at most
 * {@link COMPUTER_RECORDING_MAX_SESSIONS} files,
 * {@link COMPUTER_RECORDING_MAX_TOTAL_BYTES} bytes, and
 * {@link COMPUTER_RECORDING_MAX_AGE_MS} of age — the sweep deletes the oldest
 * closed sessions first. Open sessions are never swept.
 *
 * Writes are serialized on a private promise chain and every failure is
 * swallowed — the same contract {@link ComputerAuditLog} keeps: evidence
 * collection must never fail the action it records.
 *
 * @module computer/computerRecording
 */

export const COMPUTER_RECORDING_FORMAT_VERSION = 1;

/** Most steps one session holds; crossing it closes the session. */
export const COMPUTER_RECORDING_MAX_STEPS = 2_000;
/** Most bytes one session file may reach; crossing it closes the session. */
export const COMPUTER_RECORDING_MAX_BYTES = 4 * 1024 * 1024;
/** Most session files the directory keeps, open ones included in the count. */
export const COMPUTER_RECORDING_MAX_SESSIONS = 64;
/** Aggregate ceiling across every session file. */
export const COMPUTER_RECORDING_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Sessions older than this are swept regardless of the other caps. */
export const COMPUTER_RECORDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Resolutions/dispatches a single step record carries; a pathological call is cut off here. */
export const COMPUTER_RECORDING_CAPTURE_MAX_ENTRIES = 64;

const RECORDING_ID_PREFIX = "crec-";
const RECORDING_FILE_SUFFIX = ".jsonl";

/** `sha256:`-prefixed hex — prefixed so a hash can never be mistaken for the text it summarizes. */
export function sha256Hex(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

// ── Record schema ──────────────────────────────────────────────────

export type ComputerRecordingFidelity = "redacted" | "full";

/**
 * The action family a step belongs to — descriptive, for the reader and the
 * replay classifier; dispatch decisions are made on `tool`, not this field.
 */
export type ComputerRecordingActionClass =
  | "pointer"
  | "keyboard"
  | "text"
  | "semantic"
  | "clipboard"
  | "window"
  | "lifecycle"
  | "batch"
  | "replay"
  | "observation";

/**
 * The environment the session was recorded under, used by replay to detect
 * drift before it resolves a single target. Every field is best-effort: a
 * backend that cannot answer one simply omits it, and `unknown` fields are
 * the fingerprint reporting "not observed", not failing the recording.
 */
export interface ComputerRecordingEnvironment {
  /** `process.platform` — the OS family the window ids came from. */
  readonly platform: string;
  /** `os.release()` — the OS build, e.g. `24.5.0`. */
  readonly osRelease?: string;
  /** The availability's backend name, e.g. `cua`, when the backend answered. */
  readonly backend?: string;
  /** The manager's desktop dialect (`macos`/`linux`), which decides shortcut spelling. */
  readonly dialect?: string;
  readonly computerId?: string;
  /** The desktop's logical size — the only display geometry this layer can see. */
  readonly display?: { readonly width: number; readonly height: number; readonly scale?: number };
  /**
   * `sha256:` of the display tuple. The proxy for "display arrangement" this
   * surface can measure: a different monitor layout presents a different
   * logical screen size, which is what makes absolute coordinates meaningless.
   */
  readonly displayHash?: string;
  /**
   * `sha256:` of the desktop's accessibility tree *shape* — roles and child
   * structure only, no labels or values — at session start. Absent when the
   * tree could not be read (macOS answers trees only scoped to a window).
   */
  readonly elementTreeHash?: string;
  /** The running apps the backend reported at start, with bundle version when readable. */
  readonly apps: readonly {
    readonly name: string;
    readonly bundleId?: string;
    readonly version?: string;
  }[];
}

export interface ComputerRecordingHeader {
  readonly kind: "header";
  readonly formatVersion: typeof COMPUTER_RECORDING_FORMAT_VERSION;
  readonly recordingId: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly startedAt: string;
  readonly fidelity: ComputerRecordingFidelity;
  readonly environment: ComputerRecordingEnvironment;
}

/** How a step's target was resolved — the "via" is what replay re-runs. */
export type ComputerRecordingResolutionVia =
  | "coordinate"
  | "semantic"
  | "window"
  | "keyboard"
  | "app"
  | "process";

/**
 * What a resolution established, recorded rather than remembered: the window
 * the input landed on, the process and app that own it, and — for a semantic
 * target — where the control sat in the accessibility tree.
 *
 * Identity fields are deliberately hashed where the raw value could carry a
 * document name or user content (`windowTitleHash`, `labelHash`); `app` and
 * `bundleId` stay verbatim because replay needs to name the application.
 * `point` is recorded for coordinate resolutions so a replay can re-map the
 * point through the window's *fresh* bounds rather than trusting the pixels.
 */
export interface ComputerRecordedResolution {
  readonly via: ComputerRecordingResolutionVia;
  readonly windowId?: string;
  readonly pid?: number;
  readonly app?: string;
  readonly bundleId?: string;
  readonly appVersion?: string;
  readonly windowTitleHash?: string;
  readonly windowBounds?: ComputerRect;
  /** Desktop point the resolution produced (coordinate and semantic paths). */
  readonly point?: ComputerPoint;
  /**
   * Child-index path from the accessibility root to the resolved node — the
   * element-token path replay re-walks on a fresh tree. Backend-provided when
   * the node carries `nodePath`, computed from tree position otherwise.
   */
  readonly nodePath?: readonly number[];
  readonly role?: string;
  readonly labelHash?: string;
  /** True when the resolved control is a protected text field — see the module doc. */
  readonly secure?: boolean;
  /** Shape hash of the resolved window's subtree at resolution time. */
  readonly elementTreeHash?: string;
}

/** One backend dispatch inside a step: the action name and what it could prove. */
export interface ComputerRecordedDispatch {
  readonly action: string;
  readonly windowId?: string;
  readonly point?: ComputerPoint;
  /** The delivery ladder verdict the wire result carried — the verification evidence kind. */
  readonly delivery?: {
    readonly path?: string;
    readonly verified?: string;
    readonly effect?: string;
  };
}

/** The gate's answer for this call — what approval state the step ran under. */
export interface ComputerRecordingApproval {
  readonly required: boolean;
  readonly decision:
    | "granted"
    | "denied"
    | "unavailable" /** A gated call whose provider ran it without a gate — the trusted-baseline case. */
    | "skipped"
    | "not-required";
}

/**
 * The target the caller declared, verbatim — the replay key. `label`/`role`
 * are the semantic spec; `x`/`y` are the screenshot pixels as written (the
 * resolved desktop point rides on `resolutions`/`dispatches`, because the
 * pixels are meaningless without their frame).
 */
export interface ComputerRecordingDeclaredTarget {
  readonly x?: number;
  readonly y?: number;
  readonly label?: string;
  readonly role?: string;
  readonly windowId?: string;
  readonly pid?: number;
  readonly app?: string;
}

/** One recorded call — a tool invocation or one `computer_run` step. */
export interface ComputerRecordingStep {
  readonly kind: "step";
  /** Sequence within the session, assigned by the store. */
  readonly seq: number;
  readonly ts: string;
  /** The tool name as the model sees it; `computer_<type>` for run steps. */
  readonly tool: string;
  readonly actionClass: ComputerRecordingActionClass;
  readonly threadId: string;
  readonly turnId?: string;
  readonly approval: ComputerRecordingApproval;
  readonly declaredTarget?: ComputerRecordingDeclaredTarget;
  /** Every resolution the call performed, in order. */
  readonly resolutions: readonly ComputerRecordedResolution[];
  /** The call's arguments after redaction — see the module doc for the rules. */
  readonly args: Record<string, unknown>;
  /**
   * Summary of the step's primary payload (typed text, set value, clipboard
   * write), when it had one. `captured` means `full` fidelity stored the
   * plaintext on `args`; `protected` means a secure field kept it hashed even
   * under `full`.
   */
  readonly payload?: {
    readonly chars: number;
    readonly sha256: string;
    readonly captured?: true;
    readonly protected?: true;
  };
  /**
   * A read-back payload (clipboard contents), always summarized — the text
   * itself is never written to the recording at any fidelity, so unlike
   * `payload` there is no `captured` marker: there is nothing to point at.
   */
  readonly result?: {
    readonly chars: number;
    readonly sha256: string;
  };
  readonly dispatches: readonly ComputerRecordedDispatch[];
  readonly effect: "verified" | "dispatched-unknown" | "not-dispatched" | "refused" | "error";
  readonly code?: string;
  readonly latencyMs: number;
}

export type ComputerRecordingEndReason =
  | "stopped"
  | "thread-removed"
  | "control-revoked"
  | "step-cap"
  | "byte-cap"
  | "disposed";

export interface ComputerRecordingEnd {
  readonly kind: "end";
  readonly ts: string;
  readonly reason: ComputerRecordingEndReason;
  readonly steps: number;
}

export interface ComputerRecordingSummary {
  readonly recordingId: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly fidelity: ComputerRecordingFidelity;
  readonly steps: number;
  readonly closed: boolean;
  readonly reason?: ComputerRecordingEndReason;
  readonly bytes: number;
}

export interface ComputerRecordingDocument {
  readonly header: ComputerRecordingHeader;
  readonly steps: readonly ComputerRecordingStep[];
  readonly end?: ComputerRecordingEnd;
}

/** The part of a step the caller supplies; the store owns kind/seq/ts. */
export type ComputerRecordingStepInput = Omit<ComputerRecordingStep, "kind" | "seq" | "ts">;

// ── Redaction ──────────────────────────────────────────────────────

/**
 * Argument keys whose values are user payloads — the same boundary the audit
 * log draws. Under `redacted` fidelity these become `{chars, sha256}`; under
 * `full` they stay verbatim unless the step's target is a protected field.
 */
const COMPUTER_RECORDING_SENSITIVE_ARGS: ReadonlySet<string> = new Set([
  "text",
  "value",
  "arguments",
  "files",
  "clipboard",
  "contents",
  "data",
  "payload",
]);

/** Longest stored non-payload string; a label or path longer than this is cut. */
const COMPUTER_RECORDING_MAX_STRING = 256;

/**
 * The roles a text payload must never be recorded through in plaintext, at
 * any fidelity: AX secure text fields on macOS and the AT-SPI password
 * spellings elsewhere. Matched loosely on purpose — a role naming `secure` or
 * `password` anywhere in itself is treated as protected, because the cost of
 * an over-broad hash is a replay that cannot retype, while the cost of a
 * miss is a password on disk.
 */
export function isProtectedComputerRole(role: string | undefined): boolean {
  if (role === undefined) return false;
  const lowered = role.toLowerCase();
  return lowered.includes("secure") || lowered.includes("password");
}

export interface ComputerRecordingRedactedArgs {
  readonly args: Record<string, unknown>;
  /** The first payload-bearing string field, summarized — the step's `payload`. */
  readonly payload?: ComputerRecordingStep["payload"];
}

/**
 * Project a call's raw arguments onto what the session's fidelity may keep.
 * Structural fields (coordinates, keys, paths, ids) pass through; payload
 * fields hash or stay verbatim per the rules in the module doc. `protected`
 * is the resolution's verdict — a step that landed on a secure field keeps
 * nothing verbatim no matter the fidelity.
 */
export function redactComputerRecordingArgs(
  args: Record<string, unknown>,
  options: { readonly fidelity: ComputerRecordingFidelity; readonly protected?: boolean },
): ComputerRecordingRedactedArgs {
  const secure = options.protected === true;
  const verbatim = options.fidelity === "full" && !secure;
  let payload: ComputerRecordingRedactedArgs["payload"];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const redacted = redactValue(key, value, verbatim, secure, 0);
    out[key] = redacted.value;
    if (payload === undefined && redacted.payload !== undefined) payload = redacted.payload;
  }
  return payload === undefined ? { args: out } : { args: out, payload };
}

function redactValue(
  key: string,
  value: unknown,
  verbatim: boolean,
  secure: boolean,
  depth: number,
): { readonly value: unknown; readonly payload?: ComputerRecordingStep["payload"] } {
  if (value === null || value === undefined) return { value: undefined };
  if (typeof value === "number" || typeof value === "boolean") return { value };
  if (typeof value === "string") {
    if (COMPUTER_RECORDING_SENSITIVE_ARGS.has(key)) {
      const sha256 = sha256Hex(value);
      const summary = {
        chars: value.length,
        sha256,
        ...(verbatim ? { captured: true as const } : {}),
        ...(secure ? { protected: true as const } : {}),
      };
      return verbatim ? { value, payload: summary } : { value: summary, payload: summary };
    }
    return {
      value:
        value.length > COMPUTER_RECORDING_MAX_STRING
          ? `${value.slice(0, COMPUTER_RECORDING_MAX_STRING)}…`
          : value,
    };
  }
  if (Array.isArray(value)) {
    if (key === "steps") {
      // A computer_run's step list is its declaration: count and types like
      // the audit log; the per-step records carry the redacted detail.
      return {
        value: {
          count: value.length,
          types: value
            .map((step) =>
              step !== null && typeof step === "object" && !Array.isArray(step)
                ? String(Reflect.get(step, "type") ?? "unknown")
                : "unknown",
            )
            .slice(0, 64),
        },
      };
    }
    if (COMPUTER_RECORDING_SENSITIVE_ARGS.has(key)) {
      if (verbatim) {
        const items = value.map((item) => (typeof item === "string" ? item : "[non-string]"));
        return {
          value: items,
          payload: {
            chars: items.join("").length,
            sha256: sha256Hex(items.join("")),
            captured: true,
          },
        };
      }
      const joined = value.map((item) => String(item)).join("");
      return { value: { items: value.length, sha256: sha256Hex(joined) } };
    }
    return {
      value: value
        .slice(0, 64)
        .map((item) =>
          typeof item === "number" || typeof item === "boolean"
            ? item
            : typeof item === "string"
              ? item.slice(0, COMPUTER_RECORDING_MAX_STRING)
              : "[object]",
        ),
    };
  }
  if (typeof value === "object" && depth < 2) {
    const inner: Record<string, unknown> = {};
    let payload: ComputerRecordingStep["payload"];
    for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactValue(innerKey, innerValue, verbatim, secure, depth + 1);
      inner[innerKey] = redacted.value;
      if (payload === undefined && redacted.payload !== undefined) payload = redacted.payload;
    }
    return { value: inner, ...(payload ? { payload } : {}) };
  }
  return { value: `[${typeof value}]` };
}

/**
 * A payload a call *returned* (clipboard read), summarized under the same
 * rules — except verbatim retention is never offered here, because the
 * contract's "no raw clipboard contents" line holds at every fidelity.
 */
export function redactComputerRecordingResult(
  value: string,
): NonNullable<ComputerRecordingStep["result"]> {
  return { chars: value.length, sha256: sha256Hex(value) };
}

// ── Identity helpers ───────────────────────────────────────────────

/**
 * The child-index path from the tree root to `node`, when the node can be
 * found in this tree at all. Backend-provided `nodePath` wins — it is the
 * driver's own re-resolution token — and the computed path is the fallback a
 * backend that does not assign paths (the fake, some AT-SPI walks) still
 * gets.
 */
export function uiTreeNodePath(
  root: ComputerUiNode,
  node: ComputerUiNode,
): readonly number[] | undefined {
  if (node.nodePath !== undefined) return node.nodePath;
  const found = findNodePath(root, node, []);
  return found ?? undefined;
}

function findNodePath(
  node: ComputerUiNode,
  wanted: ComputerUiNode,
  path: number[],
): number[] | undefined {
  if (node === wanted) return path;
  for (const [index, child] of node.children.entries()) {
    const found = findNodePath(child, wanted, [...path, index]);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * The node at `path` in a fresh tree, or undefined when the shape changed
 * enough that the path no longer resolves — replay treats that as drift.
 */
export function uiTreeNodeAtPath(
  root: ComputerUiNode,
  path: readonly number[],
): ComputerUiNode | undefined {
  let node: ComputerUiNode = root;
  for (const index of path) {
    const child = node.children[index];
    if (child === undefined) return undefined;
    node = child;
  }
  return node;
}

/**
 * `sha256:` of the tree's *shape*: roles and child structure only — never a
 * label, a value, or a window id. Two reads of an unchanged window produce
 * the same hash; an edit, an added row, or a different document produce a
 * different one. It is a drift signal, not an identity: a changed hash beside
 * an exactly-matched element still lets replay classify `match`.
 */
export function uiTreeShapeHash(root: ComputerUiNode, windowId?: string): string {
  return sha256Hex(shapeString(root, windowId));
}

function shapeString(node: ComputerUiNode, windowId: string | undefined): string {
  // A subtree owned by another window is pruned whole rather than walked: the
  // scoped hash must not move when an unrelated window's contents change.
  if (windowId !== undefined && node.windowId !== null && node.windowId !== windowId) return "";
  const children = node.children
    .map((child) => shapeString(child, windowId))
    .filter((entry) => entry.length > 0)
    .join(",");
  return `${node.role}${node.truncated === true ? "!" : ""}{${children}}`;
}

/**
 * Best-effort `CFBundleShortVersionString` (falling back to `CFBundleVersion`)
 * out of a `.app`'s Info.plist — the app-bundle version the fingerprint
 * carries. Only ever called on macOS paths the app list itself reported; a
 * missing or unreadable plist is simply an absent field.
 */
export async function readMacAppBundleVersion(
  launchPath: string | undefined,
): Promise<string | undefined> {
  if (launchPath === undefined || osPlatform() !== "darwin") return undefined;
  const plist = await readFile(join(launchPath, "Contents", "Info.plist"), "utf8").catch(
    () => undefined,
  );
  if (plist === undefined) return undefined;
  const match =
    /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/.exec(plist) ??
    /<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/.exec(plist);
  const version = match?.[1]?.trim();
  return version === undefined || version.length === 0 || version.length > 128
    ? undefined
    : version;
}

/** The OS half of the environment fingerprint — everything here is free to compute. */
export function computerEnvironmentBase(): Pick<
  ComputerRecordingEnvironment,
  "platform" | "osRelease"
> {
  return { platform: osPlatform(), osRelease: release() };
}

// ── The store ──────────────────────────────────────────────────────

export interface ComputerRecordingStoreOptions {
  /** Directory the session files live in; undefined disables the store. */
  readonly dir?: string | undefined;
  readonly now?: () => Date;
  /** Retention knobs, injectable so tests can shrink them. */
  readonly maxSteps?: number;
  readonly maxBytes?: number;
  readonly maxSessions?: number;
  readonly maxTotalBytes?: number;
  readonly maxAgeMs?: number;
}

interface OpenSession {
  readonly recordingId: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly fidelity: ComputerRecordingFidelity;
  readonly filePath: string;
  readonly startedAt: string;
  steps: number;
  bytes: number;
  closed: boolean;
  endedAt?: string;
  endReason?: ComputerRecordingEndReason;
}

function sanitizeRecordingId(recordingId: string): string | undefined {
  if (
    recordingId.length === 0 ||
    recordingId.length > 128 ||
    !/^[A-Za-z0-9._-]+$/.test(recordingId)
  ) {
    return undefined;
  }
  return recordingId;
}

/**
 * Append-only per-session NDJSON store. One open session per thread — a
 * second `start` for the same thread refuses rather than interleaving two
 * artifacts' step sequences into one file. Sessions are keyed by thread
 * because that is the identity the records bind to; a recording outlives its
 * turn on purpose (the file is the audit artifact, not the turn's scratch).
 */
export class ComputerRecordingStore {
  private chain: Promise<void> = Promise.resolve();
  private readonly openByThread = new Map<string, OpenSession>();
  private readonly openById = new Map<string, OpenSession>();
  private readonly now: () => Date;
  private readonly maxSteps: number;
  private readonly maxBytes: number;
  private readonly maxSessions: number;
  private readonly maxTotalBytes: number;
  private readonly maxAgeMs: number;

  constructor(private readonly options: ComputerRecordingStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.maxSteps = options.maxSteps ?? COMPUTER_RECORDING_MAX_STEPS;
    this.maxBytes = options.maxBytes ?? COMPUTER_RECORDING_MAX_BYTES;
    this.maxSessions = options.maxSessions ?? COMPUTER_RECORDING_MAX_SESSIONS;
    this.maxTotalBytes = options.maxTotalBytes ?? COMPUTER_RECORDING_MAX_TOTAL_BYTES;
    this.maxAgeMs = options.maxAgeMs ?? COMPUTER_RECORDING_MAX_AGE_MS;
  }

  get enabled(): boolean {
    return this.options.dir !== undefined;
  }

  /** The open session for a thread — the lookup `recordComputerStep` runs on. */
  activeForThread(
    threadId: string,
  ): { recordingId: string; fidelity: ComputerRecordingFidelity } | undefined {
    const session = this.openByThread.get(threadId);
    return session === undefined || session.closed
      ? undefined
      : { recordingId: session.recordingId, fidelity: session.fidelity };
  }

  /** Fidelity a session was opened with, for the caller redacting a record. */
  fidelityFor(recordingId: string): ComputerRecordingFidelity | undefined {
    return this.openById.get(recordingId)?.fidelity;
  }

  /**
   * Open a session file and write its header, after sweeping retention so a
   * new file cannot be the one that overflows the caps. Throws
   * `ComputerRecordingError` when the store is disabled or the thread already
   * has an open session.
   */
  async start(input: {
    readonly threadId: string;
    readonly turnId?: string;
    readonly fidelity: ComputerRecordingFidelity;
    readonly environment: ComputerRecordingEnvironment;
  }): Promise<ComputerRecordingSummary> {
    const dir = this.options.dir;
    if (dir === undefined) {
      throw new ComputerRecordingError(
        "Computer recording is unavailable: this server has no state directory.",
      );
    }
    if (this.openByThread.get(input.threadId)?.closed === false) {
      throw new ComputerRecordingError(
        "A computer recording is already open for this thread; stop it before starting another.",
      );
    }
    const recordingId = `${RECORDING_ID_PREFIX}${randomBytes(9).toString("hex")}`;
    const startedAt = this.now().toISOString();
    const header: ComputerRecordingHeader = {
      kind: "header",
      formatVersion: COMPUTER_RECORDING_FORMAT_VERSION,
      recordingId,
      threadId: input.threadId,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      startedAt,
      fidelity: input.fidelity,
      environment: input.environment,
    };
    const filePath = join(dir, `${recordingId}${RECORDING_FILE_SUFFIX}`);
    const line = `${JSON.stringify(header)}\n`;
    // The sweep reserves this file's slot: it must not be the file that
    // overflows the caps it was supposed to stay inside.
    await this.sweep({ files: 1, bytes: Buffer.byteLength(line, "utf8") }).catch(() => undefined);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(filePath, line, { mode: 0o600 });
    const session: OpenSession = {
      recordingId,
      threadId: input.threadId,
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      fidelity: input.fidelity,
      filePath,
      startedAt,
      steps: 0,
      bytes: Buffer.byteLength(line, "utf8"),
      closed: false,
    };
    this.openByThread.set(input.threadId, session);
    this.openById.set(recordingId, session);
    return this.summaryOf(session);
  }

  /**
   * Queue one step record. Fire-and-forget like the audit log — never throws,
   * never awaited: a recording failure must not fail the action it records.
   * The store assigns `seq` and `ts`; a step arriving after the cap closes
   * the session is dropped.
   */
  appendStep(threadId: string, step: ComputerRecordingStepInput): void {
    const session = this.openByThread.get(threadId);
    if (session === undefined || session.closed) return;
    // Steps and bytes are accounted synchronously at accept time: a burst of
    // appends must see the cap before the write chain has drained, or every
    // queued step would land past the bound the cap exists to keep.
    session.steps += 1;
    const line = `${JSON.stringify({ kind: "step", seq: session.steps, ts: this.now().toISOString(), ...step })}\n`;
    session.bytes += Buffer.byteLength(line, "utf8");
    this.chain = this.chain.then(() => this.writeLine(session, line));
    // A step that hits a cap is still written — the end line lands behind it.
    if (session.steps >= this.maxSteps) this.closeSession(session, "step-cap");
    else if (session.bytes > this.maxBytes) this.closeSession(session, "byte-cap");
  }

  /** Close a session — explicit stop, cap, teardown. Idempotent. */
  async stop(
    recordingId: string,
    reason: ComputerRecordingEndReason,
  ): Promise<ComputerRecordingSummary | undefined> {
    const session = this.openById.get(recordingId);
    if (session === undefined) return undefined;
    this.closeSession(session, reason);
    // The end line rides the same chain the steps did, so it lands after every
    // queued step and cannot interleave with one still in flight.
    await this.flush();
    return this.summaryOf(session, true);
  }

  /**
   * Mark the session closed and enqueue its end line — never awaits the write
   * chain, so it is safe to call from inside a chain step (the cap paths).
   */
  private closeSession(session: OpenSession, reason: ComputerRecordingEndReason): void {
    if (session.closed) return;
    session.closed = true;
    session.endedAt = this.now().toISOString();
    session.endReason = reason;
    this.openByThread.delete(session.threadId);
    this.openById.delete(session.recordingId);
    const end: ComputerRecordingEnd = {
      kind: "end",
      ts: session.endedAt,
      reason,
      steps: session.steps,
    };
    const line = `${JSON.stringify(end)}\n`;
    session.bytes += Buffer.byteLength(line, "utf8");
    this.chain = this.chain.then(() => this.writeLine(session, line));
    void this.sweep().catch(() => undefined);
  }

  /** Close whatever session the thread has open, when it has one. */
  async stopForThread(
    threadId: string,
    reason: ComputerRecordingEndReason,
  ): Promise<ComputerRecordingSummary | undefined> {
    const session = this.openByThread.get(threadId);
    if (session === undefined) return undefined;
    return this.stop(session.recordingId, reason);
  }

  /** Close every open session — manager teardown. */
  async stopAll(reason: ComputerRecordingEndReason): Promise<void> {
    // The copy survives each stop removing its own entry from the live map.
    for (const session of Array.from(this.openById.values())) {
      await this.stop(session.recordingId, reason).catch(() => undefined);
    }
    await this.flush();
  }

  /** Every session file's summary, open ones first then newest-first. */
  async list(): Promise<ComputerRecordingSummary[]> {
    const dir = this.options.dir;
    if (dir === undefined) return [];
    const names = await readdir(dir).catch(() => [] as string[]);
    const summaries: ComputerRecordingSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(RECORDING_FILE_SUFFIX)) continue;
      const recordingId = name.slice(0, -RECORDING_FILE_SUFFIX.length);
      const open = this.openById.get(recordingId);
      if (open !== undefined) {
        summaries.push(this.summaryOf(open));
        continue;
      }
      const filePath = join(dir, name);
      const parsed = await this.readFile(filePath).catch(() => undefined);
      if (parsed === undefined) continue;
      summaries.push(
        this.summaryOfParsed(recordingId, parsed, await stat(filePath).catch(() => undefined)),
      );
    }
    return summaries.toSorted((a, b) =>
      a.closed === b.closed ? b.startedAt.localeCompare(a.startedAt) : a.closed ? 1 : -1,
    );
  }

  /** The full document — the export and replay read. Throws when absent. */
  async read(recordingId: string): Promise<ComputerRecordingDocument> {
    const dir = this.options.dir;
    const safe = sanitizeRecordingId(recordingId);
    if (dir === undefined || safe === undefined) {
      throw new ComputerRecordingError(`No computer recording ${JSON.stringify(recordingId)}.`);
    }
    const parsed = await this.readFile(join(dir, `${safe}${RECORDING_FILE_SUFFIX}`)).catch(
      () => undefined,
    );
    if (parsed === undefined || parsed.header === undefined) {
      throw new ComputerRecordingError(`No computer recording ${JSON.stringify(recordingId)}.`);
    }
    return {
      header: parsed.header,
      steps: parsed.steps,
      ...(parsed.end !== undefined ? { end: parsed.end } : {}),
    };
  }

  /** The raw file — the export surface's bytes, already redacted at write time. */
  async export(recordingId: string): Promise<string> {
    const dir = this.options.dir;
    const safe = sanitizeRecordingId(recordingId);
    if (dir === undefined || safe === undefined) {
      throw new ComputerRecordingError(`No computer recording ${JSON.stringify(recordingId)}.`);
    }
    await this.flush().catch(() => undefined);
    const contents = await readFile(join(dir, `${safe}${RECORDING_FILE_SUFFIX}`), "utf8").catch(
      () => undefined,
    );
    if (contents === undefined) {
      throw new ComputerRecordingError(`No computer recording ${JSON.stringify(recordingId)}.`);
    }
    return contents;
  }

  /** Delete one session file — the deletion API's semantics: the file is gone. */
  async delete(recordingId: string): Promise<boolean> {
    const dir = this.options.dir;
    const safe = sanitizeRecordingId(recordingId);
    if (dir === undefined || safe === undefined) return false;
    // A delete on an open session closes it first: the record must not keep
    // collecting into a file the caller just asked to remove.
    const open = this.openById.get(safe);
    if (open !== undefined) await this.stop(safe, "stopped").catch(() => undefined);
    await rm(join(dir, `${safe}${RECORDING_FILE_SUFFIX}`), { force: true });
    return true;
  }

  /** Settles once every queued append has landed — the dispose path's drain. */
  async flush(): Promise<void> {
    await this.chain;
  }

  /**
   * Raw append; the bytes were already accounted at enqueue time, so a
   * dropped write only skews the summary's `bytes` downward from the truth,
   * never the cap.
   */
  private async writeLine(session: OpenSession, line: string): Promise<void> {
    try {
      await appendFile(session.filePath, line, { mode: 0o600 });
    } catch {
      // Evidence collection must never fail the action it records.
    }
  }

  private summaryOf(session: OpenSession, closedFile = false): ComputerRecordingSummary {
    return {
      recordingId: session.recordingId,
      threadId: session.threadId,
      ...(session.turnId !== undefined ? { turnId: session.turnId } : {}),
      startedAt: session.startedAt,
      ...(session.endedAt !== undefined ? { endedAt: session.endedAt } : {}),
      fidelity: session.fidelity,
      steps: session.steps,
      closed: session.closed || closedFile,
      ...(session.endReason !== undefined ? { reason: session.endReason } : {}),
      bytes: session.bytes,
    };
  }

  private summaryOfParsed(
    recordingId: string,
    parsed: ParsedRecordingFile,
    fileStat: { size: number } | undefined,
  ): ComputerRecordingSummary {
    const header = parsed.header;
    return {
      recordingId,
      threadId: header?.threadId ?? "unknown",
      ...(header?.turnId !== undefined ? { turnId: header.turnId } : {}),
      startedAt: header?.startedAt ?? "",
      ...(parsed.end !== undefined ? { endedAt: parsed.end.ts } : {}),
      fidelity: header?.fidelity ?? "redacted",
      steps: parsed.steps.length,
      closed: parsed.end !== undefined,
      ...(parsed.end !== undefined ? { reason: parsed.end.reason } : {}),
      bytes: fileStat?.size ?? 0,
    };
  }

  /**
   * The retention sweep: closed sessions older than the age cap go first,
   * then oldest-first until the file count and total bytes fit. Open sessions
   * are skipped — a live recording cannot be deleted under itself — and count
   * toward the totals so the sweep knows what it cannot reclaim.
   */
  private async sweep(
    reserve: { readonly files?: number; readonly bytes?: number } = {},
  ): Promise<void> {
    const dir = this.options.dir;
    if (dir === undefined) return;
    const names = await readdir(dir).catch(() => [] as string[]);
    interface Candidate {
      name: string;
      mtimeMs: number;
      size: number;
      open: boolean;
    }
    const files: Candidate[] = [];
    for (const name of names) {
      if (!name.endsWith(RECORDING_FILE_SUFFIX)) continue;
      const fileStat = await stat(join(dir, name)).catch(() => undefined);
      if (fileStat === undefined) continue;
      files.push({
        name,
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
        open: this.openById.has(name.slice(0, -RECORDING_FILE_SUFFIX.length)),
      });
    }
    const cutoff = this.now().getTime() - this.maxAgeMs;
    const aged = files.filter((file) => !file.open && file.mtimeMs < cutoff);
    for (const file of aged) await rm(join(dir, file.name), { force: true }).catch(() => undefined);
    const remaining = files
      .filter((file) => !aged.includes(file))
      .toSorted((a, b) => a.mtimeMs - b.mtimeMs);
    // The reserved slot counts against the caps before its file exists, so
    // a `start` sweeping for its own header cannot overshoot by one.
    let count = remaining.length + (reserve.files ?? 0);
    let totalBytes = remaining.reduce((total, file) => total + file.size, 0) + (reserve.bytes ?? 0);
    for (const file of remaining) {
      if (count <= this.maxSessions && totalBytes <= this.maxTotalBytes) break;
      if (file.open) continue;
      await rm(join(dir, file.name), { force: true }).catch(() => undefined);
      count -= 1;
      totalBytes -= file.size;
    }
  }

  private async readFile(filePath: string): Promise<ParsedRecordingFile> {
    const raw = await readFile(filePath, "utf8");
    return parseRecordingText(raw);
  }
}

export class ComputerRecordingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerRecordingError";
  }
}

// ── The readable view ──────────────────────────────────────────────

/**
 * One plain-English line per recorded step — the history view
 * `computer_recording_read` returns beside the document. Built only from
 * what the file already holds, so it inherits every redaction: a label the
 * caller declared reads back, a window title never does (only its role and
 * owning app are named), and a payload reports its size and treatment, not
 * its text.
 */
export function computerRecordingHistoryLines(
  document: ComputerRecordingDocument,
): readonly string[] {
  const { header, steps, end } = document;
  const environment = header.environment;
  const lines: string[] = [
    `recording ${header.recordingId} — thread ${header.threadId}` +
      (header.turnId !== undefined ? ` turn ${header.turnId}` : "") +
      ` — fidelity ${header.fidelity}` +
      ` — started ${header.startedAt}` +
      ` — platform ${environment.platform}` +
      (environment.backend !== undefined ? ` backend ${environment.backend}` : "") +
      (end === undefined ? " — OPEN" : ""),
  ];
  for (const step of steps) lines.push(historyStepLine(step));
  if (end !== undefined) {
    lines.push(
      `end ${end.ts} — ${end.reason} after ${end.steps} step${end.steps === 1 ? "" : "s"}`,
    );
  }
  return lines;
}

function historyStepLine(step: ComputerRecordingStep): string {
  const time = step.ts.length >= 19 ? step.ts.slice(11, 19) : step.ts;
  const parts = [`#${step.seq} ${time} ${step.tool}`];
  const declared = step.declaredTarget;
  const resolution =
    step.resolutions.find((entry) => entry.windowId !== undefined) ?? step.resolutions[0];
  const targetBits: string[] = [];
  if (declared?.label !== undefined) targetBits.push(`"${declared.label}"`);
  if (resolution?.role !== undefined) targetBits.push(resolution.role);
  if (declared?.windowId !== undefined || resolution?.windowId !== undefined) {
    targetBits.push(`window ${declared?.windowId ?? resolution?.windowId}`);
  }
  if (resolution?.app !== undefined) targetBits.push(`in ${resolution.app}`);
  if (targetBits.length > 0) parts.push(`on ${targetBits.join(" ")}`);
  if (step.approval.required) {
    parts.push(`approval ${step.approval.decision}`);
  }
  if (step.payload !== undefined) {
    const treatment =
      step.payload.protected === true
        ? "protected"
        : step.payload.captured === true
          ? "captured"
          : "hashed";
    parts.push(`payload ${step.payload.chars} chars ${treatment}`);
  }
  const verdict = step.dispatches.find((dispatch) => dispatch.delivery?.verified !== undefined)
    ?.delivery?.verified;
  parts.push(
    `→ ${step.effect}${step.code !== undefined ? ` (${step.code})` : ""}` +
      (verdict !== undefined ? ` verified:${verdict}` : ""),
  );
  return parts.join(" ");
}

interface ParsedRecordingFile {
  header?: ComputerRecordingHeader;
  steps: ComputerRecordingStep[];
  end?: ComputerRecordingEnd;
}

/**
 * Parse a session file into header, steps, and end. Malformed lines are
 * dropped rather than failing the read — a truncated final line is what a
 * crash mid-append leaves, and the rest of the document is still evidence.
 */
export function parseRecordingText(raw: string): ParsedRecordingFile {
  const parsed: ParsedRecordingFile = { steps: [] };
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || typeof record !== "object") continue;
    const kind = Reflect.get(record, "kind");
    if (kind === "header") parsed.header = record as ComputerRecordingHeader;
    else if (kind === "step") parsed.steps.push(record as ComputerRecordingStep);
    else if (kind === "end") parsed.end = record as ComputerRecordingEnd;
  }
  return parsed;
}
