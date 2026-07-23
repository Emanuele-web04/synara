import type { TerminalSessionSnapshot } from "@synara/contracts";

export interface SnapshotReplayTerminal {
  cols: number;
  rows: number;
  resize(cols: number, rows: number): void;
  write(data: string, callback?: () => void): void;
}

export interface TerminalGridDimensions {
  cols: number;
  rows: number;
}

export class RecoveredGridFinalizationError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "RecoveredGridFinalizationError";
    this.cause = cause;
  }
}

export interface DeferredTerminalOutput {
  data: string;
  byteLength: number;
}

export interface RecoveredGridOutputBuffer {
  enqueue(output: DeferredTerminalOutput): void;
  drain(): DeferredTerminalOutput[];
  drainPrefix(count: number): DeferredTerminalOutput[];
  size(): number;
}

/**
 * Hold live output while xterm is temporarily staged at a recovered grid.
 * Draining is explicit so the runtime can release every byte only after the
 * local and backend grids have converged again.
 */
export function createRecoveredGridOutputBuffer(): RecoveredGridOutputBuffer {
  const queued: DeferredTerminalOutput[] = [];
  return {
    enqueue(output) {
      queued.push(output);
    },
    drain() {
      return queued.splice(0, queued.length);
    },
    drainPrefix(count) {
      return queued.splice(0, Math.max(0, Math.min(queued.length, Math.trunc(count))));
    },
    size() {
      return queued.length;
    },
  };
}

export function hasRecoveredGrid(
  snapshot: TerminalSessionSnapshot,
): snapshot is TerminalSessionSnapshot & { recoveredCols: number; recoveredRows: number } {
  return snapshot.recoveredCols !== undefined && snapshot.recoveredRows !== undefined;
}

export function snapshotReplayPayload(snapshot: TerminalSessionSnapshot): string {
  return `${snapshot.replayPreamble ?? ""}${snapshot.history}`;
}

export function snapshotHasReplayPayload(snapshot: TerminalSessionSnapshot): boolean {
  return snapshot.history.length > 0 || (snapshot.replayPreamble?.length ?? 0) > 0;
}

export async function snapshotReplayIdentity(snapshot: TerminalSessionSnapshot): Promise<string> {
  if (snapshot.historyRecordIdentity) return snapshot.historyRecordIdentity;
  const recoveredGridPrefix = hasRecoveredGrid(snapshot)
    ? `${snapshot.recoveredCols}x${snapshot.recoveredRows}\u0000`
    : "";
  const payload = new TextEncoder().encode(
    `${recoveredGridPrefix}${snapshotReplayPayload(snapshot)}`,
  );
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return `legacy:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function shouldReplayColdSnapshot(
  snapshot: TerminalSessionSnapshot,
  outputEventVersionAtOpen: number,
  currentOutputEventVersion: number,
  hasRetainedRecoveredOutput = false,
): boolean {
  if (hasRetainedRecoveredOutput) return true;
  return (
    snapshotHasReplayPayload(snapshot) &&
    outputEventVersionAtOpen === 0 &&
    currentOutputEventVersion === 0
  );
}

/** Preserve the pre-existing destination-grid replay behavior for legacy logs. */
export function replaySnapshotAtDestinationGrid(
  terminal: SnapshotReplayTerminal,
  snapshot: TerminalSessionSnapshot,
  onParsed?: () => void,
): void {
  const payload = snapshotReplayPayload(snapshot);
  if (payload.length > 0) {
    terminal.write("\u001bc");
    terminal.write(payload, onParsed);
    return;
  }
  terminal.write("\u001bc", onParsed);
}

function writeAndWait(terminal: SnapshotReplayTerminal, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      terminal.write(data, resolve);
    } catch (error) {
      reject(error);
    }
  });
}

function gridsMatch(left: TerminalGridDimensions, right: TerminalGridDimensions): boolean {
  return left.cols === right.cols && left.rows === right.rows;
}

function currentGrid(terminal: SnapshotReplayTerminal): TerminalGridDimensions {
  return { cols: terminal.cols, rows: terminal.rows };
}

function isUsableGrid(dimensions: TerminalGridDimensions | undefined): boolean {
  return (
    dimensions !== undefined &&
    Number.isSafeInteger(dimensions.cols) &&
    Number.isSafeInteger(dimensions.rows) &&
    dimensions.cols > 0 &&
    dimensions.rows > 0
  );
}

function tryResizeLocalGrid(
  terminal: SnapshotReplayTerminal,
  dimensions: TerminalGridDimensions,
): unknown | null {
  try {
    if (!gridsMatch(currentGrid(terminal), dimensions)) {
      terminal.resize(dimensions.cols, dimensions.rows);
    }
  } catch (error) {
    return error;
  }

  return gridsMatch(currentGrid(terminal), dimensions)
    ? null
    : new Error(`Terminal resize did not reach ${dimensions.cols}x${dimensions.rows}`);
}

function restoreBackendOpenGrid(
  terminal: SnapshotReplayTerminal,
  backendOpenDimensions: TerminalGridDimensions,
  cause: unknown,
  existingFailure?: unknown,
): void {
  const firstFailure = existingFailure ?? tryResizeLocalGrid(terminal, backendOpenDimensions);
  if (firstFailure === null) return;

  // A partially applied xterm resize can throw after changing one dimension.
  // Retry the known backend grid once; output remains buffered unless the
  // dimensions can then be verified exactly.
  const retryFailure = tryResizeLocalGrid(terminal, backendOpenDimensions);
  if (retryFailure === null) return;

  throw new RecoveredGridFinalizationError(
    "Terminal replay could not restore the backend-open grid",
    { cause, firstFailure, retryFailure },
  );
}

function ensureBackendOpenGrid(
  terminal: SnapshotReplayTerminal,
  backendOpenDimensions: TerminalGridDimensions,
): void {
  const failure = tryResizeLocalGrid(terminal, backendOpenDimensions);
  if (failure === null) return;
  restoreBackendOpenGrid(terminal, backendOpenDimensions, failure, failure);
}

export async function replaySnapshotAtBackendOpenGrid(options: {
  terminal: SnapshotReplayTerminal;
  snapshot: TerminalSessionSnapshot;
  backendOpenDimensions: TerminalGridDimensions;
}): Promise<void> {
  const { terminal, snapshot, backendOpenDimensions } = options;
  ensureBackendOpenGrid(terminal, backendOpenDimensions);
  await writeAndWait(terminal, "\u001bc");
  ensureBackendOpenGrid(terminal, backendOpenDimensions);
  const payload = snapshotReplayPayload(snapshot);
  if (payload.length > 0) await writeAndWait(terminal, payload);
}

async function finalizeRecoveredGrid(options: {
  terminal: SnapshotReplayTerminal;
  backendOpenDimensions: TerminalGridDimensions;
  measureFinalGrid: () => TerminalGridDimensions | undefined;
  resizeBackend: (dimensions: TerminalGridDimensions) => Promise<void>;
}): Promise<void> {
  const { terminal, backendOpenDimensions, measureFinalGrid, resizeBackend } = options;
  let measuredDimensions: TerminalGridDimensions | undefined;
  try {
    const proposedDimensions = measureFinalGrid();
    if (isUsableGrid(proposedDimensions)) measuredDimensions = proposedDimensions;
  } catch {
    // Container or renderer measurement is best-effort during recovery. The
    // backend-open grid is the deterministic destination when it is unavailable.
  }

  const destinationDimensions = measuredDimensions ?? backendOpenDimensions;
  const destinationFailure = tryResizeLocalGrid(terminal, destinationDimensions);
  if (destinationFailure !== null) {
    restoreBackendOpenGrid(terminal, backendOpenDimensions, destinationFailure, destinationFailure);
    return;
  }

  if (gridsMatch(destinationDimensions, backendOpenDimensions)) return;

  try {
    await resizeBackend(destinationDimensions);
  } catch (error) {
    // If the only backend resize cannot be confirmed, return xterm to the grid
    // the backend was known to use before allowing buffered output to drain.
    restoreBackendOpenGrid(terminal, backendOpenDimensions, error);
    throw error;
  }
}

export async function replaySnapshotAtRecoveredGrid(options: {
  terminal: SnapshotReplayTerminal;
  snapshot: TerminalSessionSnapshot & { recoveredCols: number; recoveredRows: number };
  backendOpenDimensions: TerminalGridDimensions;
  measureFinalGrid: () => TerminalGridDimensions | undefined;
  resizeBackend: (dimensions: TerminalGridDimensions) => Promise<void>;
  isActive?: () => boolean;
}): Promise<void> {
  const { terminal, snapshot, backendOpenDimensions, measureFinalGrid, resizeBackend } = options;
  const isActive = options.isActive ?? (() => true);

  // ED 2 clears only the viewport. Deliberately omit ED 3 so existing scrollback
  // remains available, then wait for xterm's parser before a potentially lossy shrink.
  await writeAndWait(terminal, "\u001b[2J\u001b[H");
  if (!isActive()) throw new Error("Terminal replay was aborted");

  let replayFailed = false;
  let replayFailure: unknown;
  try {
    terminal.resize(snapshot.recoveredCols, snapshot.recoveredRows);
    if (terminal.cols !== snapshot.recoveredCols || terminal.rows !== snapshot.recoveredRows) {
      throw new Error(
        `Terminal staging resize did not reach ${snapshot.recoveredCols}x${snapshot.recoveredRows}`,
      );
    }
    await writeAndWait(terminal, snapshotReplayPayload(snapshot));
  } catch (error) {
    replayFailed = true;
    replayFailure = error;
  }

  // Staging and parsing are both guarded. Finalization either verifies a
  // measured destination, verifies the backend-open fallback, or throws the
  // sentinel error that tells the runtime to keep live output buffered.
  await finalizeRecoveredGrid({
    terminal,
    backendOpenDimensions,
    measureFinalGrid: replayFailed ? () => undefined : measureFinalGrid,
    resizeBackend,
  });

  if (replayFailed) throw replayFailure;
  if (!isActive()) throw new Error("Terminal replay was aborted");
}

export interface ReplayIdentityState {
  appliedHistoryRecordIdentity: string | null;
  pendingHistoryRecordIdentity: string | null;
  pendingHistoryReplayPromise: Promise<void> | null;
}

export async function applyReplayOnce(
  state: ReplayIdentityState,
  identity: string | undefined,
  replay: () => Promise<void>,
): Promise<boolean> {
  if (identity && state.appliedHistoryRecordIdentity === identity) {
    return false;
  }

  const pendingReplay = state.pendingHistoryReplayPromise;
  if (pendingReplay) {
    if (identity && state.pendingHistoryRecordIdentity === identity) {
      await pendingReplay;
      return false;
    }
    await pendingReplay.catch(() => undefined);
    return applyReplayOnce(state, identity, replay);
  }

  if (identity) state.pendingHistoryRecordIdentity = identity;
  const replayPromise = Promise.resolve().then(replay);
  state.pendingHistoryReplayPromise = replayPromise;
  try {
    await replayPromise;
    if (identity) state.appliedHistoryRecordIdentity = identity;
    return true;
  } finally {
    if (state.pendingHistoryReplayPromise === replayPromise) {
      state.pendingHistoryReplayPromise = null;
    }
    if (identity && state.pendingHistoryRecordIdentity === identity) {
      state.pendingHistoryRecordIdentity = null;
    }
  }
}
