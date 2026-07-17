const onboardingPendingKey = "synara-companion-onboarding-pending";

type OnboardingStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

function browserStorage(): OnboardingStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function markPostPairOnboardingPending(
  storage: OnboardingStorage | undefined = browserStorage(),
): void {
  try {
    storage?.setItem(onboardingPendingKey, "true");
  } catch {
    // Pairing must still succeed when private browsing blocks local storage.
  }
}

export function clearPostPairOnboardingPending(
  storage: OnboardingStorage | undefined = browserStorage(),
): void {
  try {
    storage?.removeItem(onboardingPendingKey);
  } catch {
    // The flag is only a convenience; settings remain available without it.
  }
}

export function isPostPairOnboardingPending(
  storage: OnboardingStorage | undefined = browserStorage(),
): boolean {
  try {
    return storage?.getItem(onboardingPendingKey) === "true";
  } catch {
    return false;
  }
}
