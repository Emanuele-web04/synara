export type UpdateInstallPreparationAttempt = symbol;

export class UpdateInstallPreparationCancelledError extends Error {
  constructor() {
    super("Update install preparation was cancelled.");
    this.name = "UpdateInstallPreparationCancelledError";
  }
}

export function makeUpdateInstallPreparationCoordinator() {
  let activeAttempt: {
    readonly token: UpdateInstallPreparationAttempt;
    cancelled: boolean;
  } | null = null;

  return {
    begin(): UpdateInstallPreparationAttempt | null {
      if (activeAttempt !== null) {
        return null;
      }
      const attempt = Symbol("update-install-preparation");
      activeAttempt = { token: attempt, cancelled: false };
      return attempt;
    },
    cancel(): boolean {
      if (activeAttempt === null) {
        return false;
      }
      activeAttempt.cancelled = true;
      return true;
    },
    requireActive(attempt: UpdateInstallPreparationAttempt): void {
      if (activeAttempt?.token !== attempt || activeAttempt.cancelled) {
        throw new UpdateInstallPreparationCancelledError();
      }
    },
    release(attempt: UpdateInstallPreparationAttempt): void {
      if (activeAttempt?.token !== attempt) {
        throw new UpdateInstallPreparationCancelledError();
      }
      activeAttempt = null;
    },
  };
}
