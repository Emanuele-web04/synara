import type { ServerConsumeCodexResetCreditInput } from "@synara/contracts";

const storageKey = (accountId: string) => `synara:codex-reset-attempt:${accountId}`;

/** An uncertain redemption survives popover unmounts, reconnects and page reloads. */
export function readCodexResetAttempt(
  accountId: string,
): ServerConsumeCodexResetCreditInput | null {
  const value = localStorage.getItem(storageKey(accountId));
  if (value === null) return null;
  const attempt: unknown = JSON.parse(value);
  if (
    typeof attempt !== "object" ||
    attempt === null ||
    !("accountId" in attempt) ||
    attempt.accountId !== accountId ||
    !("idempotencyKey" in attempt) ||
    typeof attempt.idempotencyKey !== "string" ||
    !attempt.idempotencyKey ||
    ("creditId" in attempt && typeof attempt.creditId !== "string")
  )
    throw new Error(
      "The previous Codex reset attempt could not be read. No new reset was requested.",
    );
  return attempt as ServerConsumeCodexResetCreditInput;
}

export function prepareCodexResetAttempt(
  accountId: string,
  creditId?: string,
): ServerConsumeCodexResetCreditInput {
  const previous = readCodexResetAttempt(accountId);
  if (previous) {
    if (previous.creditId !== creditId)
      throw new Error("Retry the previous reset before choosing another one.");
    return previous;
  }
  const attempt = {
    accountId,
    idempotencyKey: crypto.randomUUID(),
    ...(creditId ? { creditId } : {}),
  };
  // Persist before submitting. If storage is unavailable, fail before spending a credit.
  localStorage.setItem(storageKey(accountId), JSON.stringify(attempt));
  return attempt;
}

export function finishCodexResetAttempt(attempt: ServerConsumeCodexResetCreditInput): void {
  if (readCodexResetAttempt(attempt.accountId)?.idempotencyKey === attempt.idempotencyKey) {
    localStorage.removeItem(storageKey(attempt.accountId));
  }
}
