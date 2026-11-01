// Provider-owned quota evidence. Unknown or stale reset times stay manual.
export interface UsageLimitWindows {
  readonly windows: Readonly<Record<string, string | null>>;
  // Codex notifications are patches, including credit/overage permissions.
  readonly codexCredits?: { readonly hasCredits?: boolean; readonly unlimited?: boolean };
  readonly codexAllowed?: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function resetAt(value: unknown, nowMs: number): string | null {
  const milliseconds =
    typeof value === "number" && Number.isFinite(value)
      ? value * 1_000
      : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value)
        ? Date.parse(value)
        : Number.NaN;
  return Number.isFinite(milliseconds) && milliseconds > nowMs && milliseconds <= 8.64e15
    ? new Date(milliseconds).toISOString()
    : null;
}

export function usageLimitResetAt(
  evidence: UsageLimitWindows | undefined,
  nowMs: number,
): string | null {
  if (
    evidence?.codexAllowed === true ||
    evidence?.codexCredits?.hasCredits === true ||
    evidence?.codexCredits?.unlimited === true
  ) {
    return null;
  }
  let latest: string | null = null;
  for (const value of Object.values(evidence?.windows ?? {})) {
    const reset = resetAt(value, nowMs);
    if (reset === null) return null;
    if (latest === null || reset > latest) latest = reset;
  }
  return latest;
}

export function codexErrorCode(value: unknown): string | undefined {
  const error = record(value);
  const info = error?.codexErrorInfo ?? error?.codex_error_info;
  // Codex serializes unit variants as strings and data variants as one-key objects.
  const object = record(info);
  const code =
    typeof info === "string"
      ? info.trim()
      : object && Object.keys(object).length === 1
        ? Object.keys(object)[0]
        : undefined;
  return code === "serverOverloaded" ? "server_overloaded" : code || undefined;
}

export function isCodexUsageLimitError(code: string | undefined, value?: unknown): boolean {
  if (code === "usageLimitExceeded" || code === "rateLimitExceeded") return true;
  const error = record(value);
  const info = record(error?.codexErrorInfo ?? error?.codex_error_info);
  return (
    code === "responseTooManyFailedAttempts" &&
    record(info?.responseTooManyFailedAttempts)?.httpStatusCode === 429
  );
}

export function codexUsageLimitWindows(
  value: unknown,
  nowMs: number,
  previous?: UsageLimitWindows,
): UsageLimitWindows | undefined {
  const root = record(value);
  if (!root) return previous;
  const byId = record(root.rateLimitsByLimitId);
  const snapshot = byId
    ? record(byId.codex)
    : "rateLimits" in root
      ? record(root.rateLimits)
      : root;
  // Other buckets do not update this account's canonical Codex quota.
  if (byId && !("codex" in byId)) return previous;
  if (!snapshot) return undefined;
  if (snapshot.limitId !== undefined && snapshot.limitId !== "codex") return previous;

  const windows = { ...previous?.windows };
  let observed = previous !== undefined;
  for (const name of ["primary", "secondary"] as const) {
    if (!(name in snapshot)) continue;
    observed = true;
    if (snapshot[name] === null) {
      delete windows[name];
      continue;
    }
    const window = record(snapshot[name]);
    if (!window) {
      if (name in windows) windows[name] = null;
      continue;
    }
    if (typeof window.usedPercent === "number" && Number.isFinite(window.usedPercent)) {
      if (window.usedPercent < 100) delete windows[name];
      else
        windows[name] =
          "resetsAt" in window ? resetAt(window.resetsAt, nowMs) : (windows[name] ?? null);
    } else if ("usedPercent" in window) {
      // A malformed replacement cannot turn an existing exhausted window into allowance.
      if (name in windows) windows[name] = null;
    } else if ("resetsAt" in window && name in windows) {
      windows[name] = resetAt(window.resetsAt, nowMs);
    }
  }

  let credits = previous?.codexCredits;
  if (snapshot.credits === null) credits = undefined;
  else {
    const patch = record(snapshot.credits);
    if (patch) {
      observed = true;
      credits = {
        ...credits,
        ...(typeof patch.hasCredits === "boolean" ? { hasCredits: patch.hasCredits } : {}),
        ...(typeof patch.unlimited === "boolean" ? { unlimited: patch.unlimited } : {}),
      };
    }
  }
  const allowed = typeof snapshot.allowed === "boolean" ? snapshot.allowed : previous?.codexAllowed;
  return observed
    ? {
        windows,
        ...(credits !== undefined ? { codexCredits: credits } : {}),
        ...(allowed !== undefined ? { codexAllowed: allowed } : {}),
      }
    : undefined;
}

export function claudeUsageLimitWindows(
  previous: UsageLimitWindows | undefined,
  value: unknown,
  nowMs: number,
): UsageLimitWindows | undefined {
  const root = record(value);
  const info = record(root?.rate_limit_info) ?? root;
  if (!info) return previous;
  // Actual overage bypass is account-wide. A named allowed window only clears
  // that window: its five-hour refill cannot erase a rejected weekly allowance.
  if (
    info.overageStatus === "allowed" ||
    info.overageStatus === "allowed_warning" ||
    info.isUsingOverage === true ||
    info.overageInUse === true
  )
    return { windows: {} };
  if (info.status === "allowed" || info.status === "allowed_warning") {
    if (typeof info.rateLimitType !== "string") return { windows: {} };
    const windows = { ...previous?.windows };
    delete windows[info.rateLimitType];
    return { windows };
  }
  if (info.status !== "rejected") return previous;
  const knownWindows = [
    "five_hour",
    "seven_day",
    "seven_day_opus",
    "seven_day_sonnet",
    "seven_day_overage_included",
    "overage",
  ];
  const name =
    typeof info.rateLimitType === "string" && knownWindows.includes(info.rateLimitType)
      ? info.rateLimitType
      : "unknown";
  const reset =
    info.errorCode === "credits_required" ||
    (name === "overage" && info.overageDisabledReason === "out_of_credits")
      ? null
      : resetAt(
          name === "overage" ? (info.overageResetsAt ?? info.resetsAt) : info.resetsAt,
          nowMs,
        );
  return { windows: { ...previous?.windows, [name]: reset } };
}
