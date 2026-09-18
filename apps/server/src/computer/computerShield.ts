/**
 * Masked-activation canary flags.
 *
 * `SYNARA_CUA_MASKED_ACTIVATION` arms the feature globally; it is off by
 * default and only ever meaningful on the macOS CUA dialect. Arming alone
 * changes nothing: a second, per-app opt-in list names the bundle ids the
 * shield may cover. Both must hold for a given activation to be masked.
 *
 * `SYNARA_CUA_MASKED_APPS` is that opt-in list — comma/semicolon/whitespace
 * separated bundle identifiers, matched case-insensitively against the
 * target window's owning app. The env list is the canary's configuration
 * surface: a real UI would manage the same per-app consent from settings,
 * writing the same set the way the denylist and the permission cards already
 * persist theirs. Keeping it env-only for the canary means no persisted
 * state can arm masking on an upgrade.
 *
 * The naming is deliberately scary rather than invisible: the shield veils a
 * real window activation, so reaching for it should be a decision the
 * operator made on purpose.
 */

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

/** The global canary flag; unset means masked activation never engages. */
export function cuaMaskedActivationEnabled(): boolean {
  return envFlagEnabled(process.env.SYNARA_CUA_MASKED_ACTIVATION);
}

/**
 * The per-app opt-in set: lowercased bundle identifiers. Empty (the default)
 * means no app is opted in, so the feature stays inert even while armed.
 */
export function cuaMaskedActivationOptIn(): ReadonlySet<string> {
  const raw = process.env.SYNARA_CUA_MASKED_APPS ?? "";
  return new Set(
    raw
      .split(/[\s,;]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/** Whether `bundleId` names an app the canary list opted in. */
export function maskedActivationOptedIn(
  optIn: ReadonlySet<string>,
  bundleId: string | undefined,
): boolean {
  return bundleId !== undefined && optIn.has(bundleId.trim().toLowerCase());
}
