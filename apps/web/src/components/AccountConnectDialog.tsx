import type {
  ProviderAccountCapabilities,
  ProviderAccountsConnectStatus,
  SupportedAccountProvider,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";
import {
  accountProviderLabel,
  providerAccountsConnectStatusQueryOptions,
  useProviderAccountsBeginConnect,
  useProviderAccountsCancelConnect,
} from "~/lib/providerAccountsReactQuery";

export interface AccountConnectRequest {
  readonly provider: SupportedAccountProvider;
  readonly capabilities: ProviderAccountCapabilities;
  /** Present when reconnecting an existing slot instead of adding a new one. */
  readonly reconnectOrdinal?: number;
}

export function AccountConnectDialog({
  request,
  onOpenChange,
}: {
  request: AccountConnectRequest | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        {request !== null ? (
          <AccountConnectDialogBody request={request} onOpenChange={onOpenChange} />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function AccountConnectDialogBody({
  request,
  onOpenChange,
}: {
  request: AccountConnectRequest;
  onOpenChange: (open: boolean) => void;
}) {
  const { provider, capabilities, reconnectOrdinal } = request;
  const oauthSupported = capabilities.agent.oauth !== "unsupported";
  const apiKeySupported = capabilities.agent.apiKey !== "unsupported";

  const [method, setMethod] = useState<"oauth" | "apiKey">(oauthSupported ? "oauth" : "apiKey");
  const [apiKey, setApiKey] = useState("");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const beginConnect = useProviderAccountsBeginConnect();
  const cancelConnect = useProviderAccountsCancelConnect();
  const statusQuery = useQuery(providerAccountsConnectStatusQueryOptions({ operationId }));
  const status: ProviderAccountsConnectStatus | undefined = statusQuery.data;

  const providerLabel = accountProviderLabel(provider);
  const title =
    reconnectOrdinal !== undefined
      ? `Reconnect ${providerLabel} ${reconnectOrdinal}`
      : `Connect ${providerLabel} account`;

  const busy = beginConnect.isPending || status?.state === "pending";

  const begin = (kind: "agent-oauth" | "agent-api-key") => {
    setLocalError(null);
    beginConnect.mutate(
      kind === "agent-oauth"
        ? {
            kind,
            provider,
            ...(reconnectOrdinal !== undefined ? { ordinal: reconnectOrdinal } : {}),
          }
        : {
            kind,
            provider,
            apiKey: apiKey.trim(),
            ...(reconnectOrdinal !== undefined ? { ordinal: reconnectOrdinal } : {}),
          },
      {
        onSuccess: (result) => {
          setApiKey("");
          setOperationId(result.operationId);
        },
        onError: (error) => {
          setLocalError(error instanceof Error ? error.message : "Connection failed.");
        },
      },
    );
  };

  const close = () => {
    if (
      operationId !== null &&
      (status?.state === "pending" || status?.state === "waiting-for-user")
    ) {
      cancelConnect.mutate({ operationId });
    }
    onOpenChange(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {method === "oauth"
            ? `Sign in with your browser to add a managed ${providerLabel} account.`
            : `Store an API key for a managed ${providerLabel} account. The key is kept on this machine only.`}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="space-y-3">
          {oauthSupported && apiKeySupported && operationId === null ? (
            <div className="flex gap-2">
              <Button
                size="xs"
                variant={method === "oauth" ? "secondary" : "outline"}
                onClick={() => setMethod("oauth")}
              >
                Browser sign-in
              </Button>
              <Button
                size="xs"
                variant={method === "apiKey" ? "secondary" : "outline"}
                onClick={() => setMethod("apiKey")}
              >
                API key
              </Button>
            </div>
          ) : null}

          {method === "apiKey" && operationId === null ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (apiKey.trim().length > 0 && !busy) begin("agent-api-key");
              }}
            >
              <Input
                type="password"
                size="lg"
                value={apiKey}
                placeholder={`${providerLabel} API key`}
                autoComplete="off"
                disabled={busy}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </form>
          ) : null}

          {operationId !== null && status !== undefined ? (
            <div className="space-y-2 text-sm">
              {status.state === "pending" || status.state === "waiting-for-user" ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Spinner className="size-4" />
                  <span>
                    {status.state === "waiting-for-user"
                      ? "Waiting for you to finish signing in…"
                      : "Starting sign-in…"}
                  </span>
                </div>
              ) : null}
              {status.verificationUrl !== undefined ? (
                <p>
                  Open{" "}
                  <a
                    href={status.verificationUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    this sign-in link
                  </a>{" "}
                  in your browser to continue.
                </p>
              ) : null}
              {status.userCode !== undefined ? (
                <p>
                  Enter code <code className="font-mono font-semibold">{status.userCode}</code> when
                  prompted.
                </p>
              ) : null}
              {status.state === "succeeded" ? (
                <p>
                  Connected as {providerLabel} {status.ordinal ?? ""}.
                </p>
              ) : null}
              {status.state === "failed" ? (
                <p className="text-destructive">{status.error ?? "Connection failed."}</p>
              ) : null}
              {status.state === "cancelled" ? (
                <p className="text-muted-foreground">Connection cancelled.</p>
              ) : null}
            </div>
          ) : null}

          {localError !== null ? <p className="text-destructive text-sm">{localError}</p> : null}
        </div>
      </DialogPanel>
      <DialogFooter>
        {status?.state === "succeeded" ? (
          <Button size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        ) : (
          <>
            <Button size="sm" variant="outline" onClick={close}>
              {status?.state === "pending" || status?.state === "waiting-for-user"
                ? "Cancel sign-in"
                : "Close"}
            </Button>
            {operationId === null ? (
              <Button
                size="sm"
                disabled={busy || (method === "apiKey" && apiKey.trim().length === 0)}
                onClick={() => begin(method === "oauth" ? "agent-oauth" : "agent-api-key")}
              >
                {busy ? "Connecting…" : "Connect"}
              </Button>
            ) : status?.state === "failed" || status?.state === "cancelled" ? (
              <Button
                size="sm"
                onClick={() => {
                  setOperationId(null);
                  setLocalError(null);
                }}
              >
                Try again
              </Button>
            ) : null}
          </>
        )}
      </DialogFooter>
    </>
  );
}
