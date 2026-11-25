// FILE: ProviderGuidedSignIn.tsx
// Purpose: One account's sign-in for surfaces outside Settings (onboarding, the chat
//          provider banner, the composer model picker). Mounting it starts the same
//          isolated login Settings runs, so nobody has to know the CLI's login command;
//          it closes itself once the account is confirmed signed in.
// Layer: Shared provider UI
// Exports: ProviderGuidedSignIn

import { useEffect, useRef } from "react";

import { useAppSettings } from "~/appSettings";

import { type ProviderSignInAccount, useProviderAccountSignIn } from "./providerAccountShared";

export function ProviderGuidedSignIn(props: {
  readonly account: ProviderSignInAccount;
  /** Runs when the sign-in window closes or could not open. */
  readonly onClosed: () => void;
}) {
  const { updateSettingsAndWait } = useAppSettings();
  const onClosedRef = useRef(props.onClosed);
  onClosedRef.current = props.onClosed;
  const { startSignIn, signInDialog } = useProviderAccountSignIn(updateSettingsAndWait, {
    closeWhenAuthenticated: true,
    onClosed: () => onClosedRef.current(),
  });

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startSignIn(props.account).then((opened) => {
      if (!opened) onClosedRef.current();
    });
    // Mounting is the request: the account is fixed for this instance's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return signInDialog;
}
