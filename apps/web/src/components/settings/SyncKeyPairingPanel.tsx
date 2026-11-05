// FILE: SyncKeyPairingPanel.tsx
// Purpose: The two-device Sync-Key transfer flow inside Connections settings.
// Layer: Settings UI components

import { useId, useReducer, useRef } from "react";

import { ShortCodeField } from "~/components/hosts/ShortCodeField";
import { Button } from "~/components/ui/button";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useTranslation } from "~/i18n";
import { accountErrorMessage } from "~/lib/accountLogic";
import { ensureHostsApi } from "~/lib/hosts/api";
import {
  SYNC_KEY_PAIRING_CODE_GROUP_SIZE,
  SYNC_KEY_PAIRING_CODE_LENGTH,
  SYNC_KEY_PAIRING_INITIAL_STATE,
  decodeSyncKeyPairingRequest,
  encodeSyncKeyPairingRequest,
  syncKeyPairingReducer,
} from "~/lib/hosts/syncKeyPairing";
import { SettingsListRow } from "./SettingsPanelPrimitives";

// Pairing codes use the same protocol alphabet and grouping in every language.
const VERIFICATION_CODE_EXAMPLE = "ABC-234";

function PairingRequestField({
  value,
  readOnly,
  disabled,
  invalid,
  describedBy,
  onValueChange,
}: {
  value: string;
  readOnly: boolean;
  disabled: boolean;
  invalid?: boolean;
  describedBy?: string;
  onValueChange?: (value: string) => void;
}) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-ui-sm font-medium text-foreground">
        {t("settings:remote_connector_syncRequest")}
      </label>
      <Textarea
        id={id}
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className="[&_textarea]:min-h-24 [&_textarea]:break-all [&_textarea]:font-mono [&_textarea]:text-ui-xs"
        onChange={onValueChange ? (event) => onValueChange(event.target.value) : undefined}
      />
    </div>
  );
}

function VerificationCode({ children }: { children: string }) {
  return (
    <code
      className="block font-mono text-lg tracking-[0.25em] text-foreground"
      aria-label={children}
    >
      {children}
    </code>
  );
}

export function SyncKeyPairingPanel() {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(syncKeyPairingReducer, SYNC_KEY_PAIRING_INITIAL_STATE);
  // Cancelling/restarting invalidates any in-flight RPC so a late response
  // cannot reopen a flow the user already left.
  const operationRef = useRef(0);
  const statusId = useId();
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: t("settings:remote_connector_syncCopyFailed"),
        description: error.message,
      }),
  });

  const reset = () => {
    operationRef.current += 1;
    dispatch({ type: "reset" });
  };

  const beginNewDevice = async () => {
    const operation = ++operationRef.current;
    dispatch({ type: "new-started" });
    try {
      const request = await ensureHostsApi().beginSyncKeyPairing();
      if (operationRef.current !== operation) return;
      dispatch({
        type: "new-request-ready",
        transferableRequest: encodeSyncKeyPairingRequest(request),
      });
    } catch (cause) {
      if (operationRef.current !== operation) return;
      dispatch({
        type: "new-start-failed",
        message: accountErrorMessage(cause, t("settings:remote_connector_syncStartFailed")),
      });
    }
  };

  const receiveSyncKey = async () => {
    if (state.phase !== "new-request" || state.pending) return;
    const operation = ++operationRef.current;
    dispatch({ type: "receive-started" });
    try {
      const result = await ensureHostsApi().receiveSyncKey();
      if (operationRef.current !== operation) return;
      dispatch({ type: "receive-succeeded", verificationCode: result.verificationCode });
    } catch (cause) {
      if (operationRef.current !== operation) return;
      dispatch({
        type: "receive-failed",
        message: accountErrorMessage(cause, t("settings:remote_connector_syncOfferNotReady")),
      });
    }
  };

  const offerSyncKey = async () => {
    if (state.phase !== "existing-request" || state.pending) return;
    let request;
    try {
      request = decodeSyncKeyPairingRequest(state.transferableRequest);
    } catch (cause) {
      dispatch({
        type: "offer-failed",
        message:
          cause instanceof Error
            ? cause.message
            : t("settings:remote_connector_syncInvalidRequest"),
      });
      return;
    }

    const operation = ++operationRef.current;
    dispatch({ type: "offer-started" });
    try {
      const result = await ensureHostsApi().offerSyncKey(request);
      if (operationRef.current !== operation) return;
      dispatch({ type: "offer-succeeded", verificationCode: result.verificationCode });
    } catch (cause) {
      if (operationRef.current !== operation) return;
      dispatch({
        type: "offer-failed",
        message: accountErrorMessage(cause, t("settings:remote_connector_syncApproveFailed")),
      });
    }
  };

  const confirmSyncKey = async () => {
    if (
      state.phase !== "new-confirm" ||
      state.pending ||
      state.enteredVerificationCode.length !== SYNC_KEY_PAIRING_CODE_LENGTH
    ) {
      return;
    }
    const operation = ++operationRef.current;
    const verificationCode = state.enteredVerificationCode;
    dispatch({ type: "confirm-started" });
    try {
      await ensureHostsApi().confirmSyncKey({ verificationCode });
      if (operationRef.current !== operation) return;
      dispatch({ type: "confirm-succeeded" });
    } catch (cause) {
      if (operationRef.current !== operation) return;
      dispatch({
        type: "confirm-failed",
        error: cause,
        message: accountErrorMessage(cause, t("settings:remote_connector_syncConfirmFailed")),
      });
    }
  };

  const open = state.phase !== "start";
  const startBusy = state.phase === "new-starting";

  return (
    <>
      <SettingsListRow
        align="start"
        title={t("settings:remote_connector_syncPairDevices")}
        description={
          <span className="flex flex-col gap-1 text-muted-foreground">
            <span>{t("settings:remote_connector_syncDescription")}</span>
            {state.phase === "start" && state.warning ? (
              <span role="alert" className="text-foreground">
                {state.warning}
              </span>
            ) : null}
            {state.phase === "start" && state.error ? (
              <span role="alert" className="text-destructive">
                {state.error}
              </span>
            ) : null}
          </span>
        }
        actions={
          state.phase === "start" ? (
            <>
              <Button size="xs" variant="outline" onClick={() => void beginNewDevice()}>
                {t("settings:remote_connector_syncSetUp")}
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  operationRef.current += 1;
                  dispatch({ type: "existing-started" });
                }}
              >
                {t("settings:remote_connector_syncApproveDevice")}
              </Button>
            </>
          ) : (
            <Button size="xs" variant="ghost" onClick={reset}>
              {t("common:form_cancel")}
            </Button>
          )
        }
      />

      <DisclosureRegion
        open={open}
        contentClassName="space-y-4 border-t border-border/70 px-3 py-3"
      >
        {startBusy ? (
          <p role="status" className="text-ui text-muted-foreground">
            {t("settings:remote_connector_syncCreating")}
          </p>
        ) : null}

        {state.phase === "new-request" ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-ui font-medium text-foreground">
                {t("settings:remote_connector_syncSendRequest")}
              </h3>
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:remote_connector_syncSendDescription")}
              </p>
            </div>
            <PairingRequestField
              value={state.transferableRequest}
              readOnly
              disabled={state.pending}
            />
            {state.message ? (
              <p id={statusId} role="alert" className="text-ui-xs text-destructive">
                {state.message}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={state.pending}
                onClick={() => copyToClipboard(state.transferableRequest, undefined)}
              >
                {isCopied ? t("chat:theme_copied") : t("settings:remote_connector_syncCopy")}
              </Button>
              <Button size="xs" disabled={state.pending} onClick={() => void receiveSyncKey()}>
                {state.pending
                  ? t("settings:remote_connector_syncChecking")
                  : t("settings:remote_connector_syncApprovedRequest")}
              </Button>
            </div>
          </div>
        ) : null}

        {state.phase === "existing-request" ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-ui font-medium text-foreground">
                {t("settings:remote_connector_syncPasteRequest")}
              </h3>
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:remote_connector_syncApprovalWarning")}
              </p>
            </div>
            <PairingRequestField
              value={state.transferableRequest}
              readOnly={false}
              disabled={state.pending}
              invalid={state.message !== null}
              describedBy={statusId}
              onValueChange={(value) => dispatch({ type: "request-changed", value })}
            />
            {state.message ? (
              <p id={statusId} role="alert" className="text-ui-xs text-destructive">
                {state.message}
              </p>
            ) : null}
            <Button
              size="xs"
              disabled={state.pending || state.transferableRequest.trim().length === 0}
              onClick={() => void offerSyncKey()}
            >
              {state.pending
                ? t("settings:remote_connector_syncApproving")
                : t("settings:remote_connector_syncApprove")}
            </Button>
          </div>
        ) : null}

        {state.phase === "existing-code" ? (
          <div className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-ui font-medium text-foreground">
                {t("settings:remote_connector_syncEnterCode")}
              </h3>
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:remote_connector_syncEnterCodeDescription")}
              </p>
            </div>
            <VerificationCode>{state.ownVerificationCode}</VerificationCode>
            <Button size="xs" variant="outline" onClick={reset}>
              {t("git:detail_done")}
            </Button>
          </div>
        ) : null}

        {state.phase === "new-confirm" ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-ui font-medium text-foreground">
                {t("settings:remote_connector_syncCompareDevices")}
              </h3>
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:remote_connector_syncThisDeviceShows")}
              </p>
              <VerificationCode>{state.ownVerificationCode}</VerificationCode>
            </div>
            <ShortCodeField
              label={t("settings:remote_connector_syncOtherDeviceCode")}
              value={state.enteredVerificationCode}
              codeLength={SYNC_KEY_PAIRING_CODE_LENGTH}
              groupSize={SYNC_KEY_PAIRING_CODE_GROUP_SIZE}
              placeholder={VERIFICATION_CODE_EXAMPLE}
              disabled={state.pending}
              describedBy={statusId}
              onValueChange={(value) => dispatch({ type: "verification-changed", value })}
              onSubmit={() => void confirmSyncKey()}
            />
            {state.message ? (
              <p id={statusId} role="alert" className="text-ui-xs text-destructive">
                {state.message}
              </p>
            ) : null}
            <Button
              size="xs"
              disabled={
                state.pending ||
                state.enteredVerificationCode.length !== SYNC_KEY_PAIRING_CODE_LENGTH
              }
              onClick={() => void confirmSyncKey()}
            >
              {state.pending
                ? t("settings:remote_connector_syncConfirming")
                : t("settings:remote_connector_syncConfirmCodes")}
            </Button>
          </div>
        ) : null}

        {state.phase === "new-success" ? (
          <div className="space-y-3">
            <p role="status" className="text-ui-xs text-foreground">
              {t("settings:remote_connector_syncSuccess")}
            </p>
            <Button size="xs" variant="outline" onClick={reset}>
              {t("git:detail_done")}
            </Button>
          </div>
        ) : null}
      </DisclosureRegion>
    </>
  );
}
