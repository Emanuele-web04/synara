/** Driver diagnostics are persisted in logs. Only fixed vocabulary and numeric
 * native error/identity fields may cross this boundary; never copy native error
 * messages, labels, element values, titles or arbitrary structured payloads. */
const DELIVERY_PATHS = ["ax", "pixel", "semantic", "keyboard", "menu"] as const;
const ACTUATORS = [
  "ax_press",
  "ax_focus",
  "ax_action",
  "pixel_click",
  "pixel_selection",
  "cgevent_wheel",
] as const;
const FOCUS_MUTATIONS = ["none", "without_raise", "foreground"] as const;
const RESTORE_STATUSES = [
  "not-needed",
  "restored",
  "failed",
  "unobservable",
  "user-changed",
] as const;
const OBSERVATIONS = ["frame-unchanged", "fresh-frame", "target-window-closed"] as const;
const ERROR_MESSAGES = {
  ax_action_refused: "The accessibility action was refused before dispatch.",
  ax_action_uncertain: "The accessibility action was submitted but its result is uncertain.",
  ax_dispatch_failed: "The accessibility actuator reported a native error.",
  pixel_dispatch_failed: "The pointer actuator reported a native error.",
  action_task_failed: "The native action task failed.",
  focus_restore_unavailable: "The previous key window could not be identified safely.",
  focus_restore_failed: "The previous key window could not be restored and verified.",
} as const;

export interface CuaActionDiagnostics {
  readonly delivery_path?: (typeof DELIVERY_PATHS)[number];
  readonly actuator?: (typeof ACTUATORS)[number];
  readonly focus_mutation?: (typeof FOCUS_MUTATIONS)[number];
  readonly restore_status?: (typeof RESTORE_STATUSES)[number];
  readonly error_code?: keyof typeof ERROR_MESSAGES;
  readonly observation?: (typeof OBSERVATIONS)[number];
  readonly scroll_delta_y?: number;
  readonly ax_error?: number;
  readonly prior_pid?: number;
  readonly prior_window_id?: number;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const member = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;

const integer = (value: unknown, min: number, max: number): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;

/** Read the diagnostics envelope of a driver's structuredContent. */
export function parseCuaActionDiagnostics(value: unknown): CuaActionDiagnostics | undefined {
  const source = record(record(value)?.diagnostics);
  if (!source) return undefined;
  const fields = {
    delivery_path: member(source.delivery_path, DELIVERY_PATHS),
    actuator: member(source.actuator, ACTUATORS),
    focus_mutation: member(source.focus_mutation, FOCUS_MUTATIONS),
    restore_status: member(source.restore_status, RESTORE_STATUSES),
    error_code: member(
      source.error_code,
      Object.keys(ERROR_MESSAGES) as (keyof typeof ERROR_MESSAGES)[],
    ),
    observation: member(source.observation, OBSERVATIONS),
    scroll_delta_y:
      typeof source.scroll_delta_y === "number" &&
      Number.isFinite(source.scroll_delta_y) &&
      Math.abs(source.scroll_delta_y) <= 1_000_000
        ? source.scroll_delta_y
        : undefined,
    ax_error: integer(source.ax_error, -0x80000000, 0x7fffffff),
    prior_pid: integer(source.prior_pid, 1, 0x7fffffff),
    prior_window_id: integer(source.prior_window_id, 1, 0xffffffff),
  };
  const entries = Object.entries(fields).filter(([, field]) => field !== undefined);
  return entries.length ? (Object.fromEntries(entries) as CuaActionDiagnostics) : undefined;
}

/** Human-readable reason generated from reviewed static codes, never app data. */
export function cuaActionDiagnosticMessage(diagnostics: CuaActionDiagnostics): string | undefined {
  return diagnostics.error_code ? ERROR_MESSAGES[diagnostics.error_code] : undefined;
}
