// Publishes theme edits once from GlobalAccountDialogs, through the regular profile mutation.
// The debounce coalesces color-picker drags; account writes and onboarding take precedence.
import type { AccountStatus } from "@synara/contracts";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { accountQueryKeys } from "~/lib/accountReactQuery";
import { resolveProfileThemeAccent } from "~/theme/theme.logic";
import { ACCOUNT_STATUS_WRITE_KEY, type useAccount } from "./useAccount";
import { readProfileThemeAccent, useTheme } from "./useTheme";

export function useProfileThemeAccentSync(account: ReturnType<typeof useAccount>) {
  const queryClient = useQueryClient();
  const { themeState } = useTheme();
  const { light, dark } = resolveProfileThemeAccent(themeState);
  const writing = useIsMutating({ mutationKey: ACCOUNT_STATUS_WRITE_KEY });
  const lastAttempt = useRef<string | null>(null);
  const {
    me,
    profileSyncEnabled,
    updateProfile: { mutate },
  } = account;

  useEffect(() => {
    if (!profileSyncEnabled || !me?.profile || me.profile.accentColor) {
      lastAttempt.current = null;
      return;
    }
    const stored = me.profile.themeAccent;
    if (stored?.light?.toLowerCase() === light && stored?.dark?.toLowerCase() === dark) {
      lastAttempt.current = null;
      return;
    }
    const attempt = JSON.stringify([me.id, me.organization.id, light, dark]);
    // Do not loop on failures or an older server that omits this optional field.
    if (writing > 0 || lastAttempt.current === attempt) return;

    const timer = setTimeout(() => {
      const status = queryClient.getQueryData<AccountStatus>(accountQueryKeys.status());
      if (
        status?.state !== "signed-in" ||
        status.me.id !== me.id ||
        status.me.organization.id !== me.organization.id ||
        queryClient.isMutating({ mutationKey: ACCOUNT_STATUS_WRITE_KEY }) > 0
      )
        return;
      const profile = status.me.profile;
      const current = readProfileThemeAccent();
      if (!profile || profile.accentColor || current.light !== light || current.dark !== dark)
        return;
      if (
        profile.themeAccent?.light?.toLowerCase() === light &&
        profile.themeAccent?.dark?.toLowerCase() === dark
      )
        return;

      lastAttempt.current = attempt;
      // Read the latest cached fields at dispatch, so a settings save during the
      // debounce cannot be overwritten by the profile captured when it started.
      mutate({
        handle: profile.handle,
        displayName: profile.displayName,
        avatarColor: profile.avatarColor,
        ...(profile.public !== undefined ? { public: profile.public } : {}),
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [dark, light, me, mutate, profileSyncEnabled, queryClient, writing]);
}
