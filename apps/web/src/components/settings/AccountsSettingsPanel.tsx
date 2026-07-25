// FILE: AccountsSettingsPanel.tsx
// Purpose: Settings → Accounts panel (plan sections 36.2–36.4). Lists each supported
//          provider's numbered account slots with identity, agent/app binding state,
//          support-level labels, and per-account actions.
// Layer: Settings UI components

import type {
  AccountOrdinal,
  ProviderAccountCapabilities,
  ProviderAccountView,
  SupportedAccountProvider,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  AccountConnectDialog,
  type AccountConnectRequest,
} from "~/components/AccountConnectDialog";
import { ProviderIcon } from "~/components/ProviderIcon";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import {
  ACCOUNT_BINDING_STATE_LABELS,
  ACCOUNT_SUPPORT_LEVEL_LABELS,
  accountIdentityLabel,
  accountProviderLabel,
  accountSlotLabel,
  providerAccountsIntegrationStatusQueryOptions,
  providerAccountsSnapshotQueryOptions,
  SUPPORTED_ACCOUNT_PROVIDERS,
  useProviderAccountsDisconnectBinding,
  useProviderAccountsHide,
  useProviderAccountsLaunch,
  useProviderAccountsSetActive,
  useProviderAccountsUpdateCliIntegration,
} from "~/lib/providerAccountsReactQuery";
import { SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";

function AccountRow({
  provider,
  account,
  isActive,
  onReconnect,
}: {
  provider: SupportedAccountProvider;
  account: ProviderAccountView;
  isActive: boolean;
  onReconnect: (ordinal: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const setActive = useProviderAccountsSetActive();
  const disconnectBinding = useProviderAccountsDisconnectBinding();
  const hide = useProviderAccountsHide();
  const launch = useProviderAccountsLaunch();

  const isNative = account.ordinal === 0;
  const identity = accountIdentityLabel(account.identity);
  const agentState =
    !isNative && account.agent ? ACCOUNT_BINDING_STATE_LABELS[account.agent.state] : null;
  const appState = account.app
    ? `${ACCOUNT_BINDING_STATE_LABELS[account.app.state]} · ${ACCOUNT_SUPPORT_LEVEL_LABELS[account.app.supportLevel]}`
    : null;

  return (
    <SettingsListRow
      align="start"
      title={
        <button
          type="button"
          className="flex items-center gap-1.5"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span>{accountSlotLabel(provider, account.ordinal)}</span>
          {isActive ? <Badge variant="secondary">Active</Badge> : null}
          <DisclosureChevron open={expanded} />
        </button>
      }
      description={
        <div className="space-y-0.5">
          {identity ? <div>{identity}</div> : null}
          {agentState ? <div>Agent: {agentState}</div> : null}
          {appState ? <div>App: {appState}</div> : null}
          {isNative ? <div>Your own {accountProviderLabel(provider)} login, unmanaged.</div> : null}
          <DisclosureRegion open={expanded}>
            <div className="flex flex-wrap gap-2 pt-2">
              {!isActive ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={setActive.isPending}
                  onClick={() => setActive.mutate({ provider, ordinal: account.ordinal })}
                >
                  Make active
                </Button>
              ) : null}
              {!isNative && account.agent ? (
                <Button size="xs" variant="outline" onClick={() => onReconnect(account.ordinal)}>
                  Reconnect agent
                </Button>
              ) : null}
              {account.app ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={launch.isPending}
                  onClick={() =>
                    launch.mutate({ provider, surface: "app", ordinal: account.ordinal })
                  }
                >
                  Open app
                </Button>
              ) : null}
              {!isNative && account.agent ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disconnectBinding.isPending}
                  onClick={() =>
                    disconnectBinding.mutate({
                      provider,
                      ordinal: account.ordinal,
                      surface: "agent",
                    })
                  }
                >
                  Disconnect agent
                </Button>
              ) : null}
              {!isNative && account.app ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disconnectBinding.isPending}
                  onClick={() =>
                    disconnectBinding.mutate({
                      provider,
                      ordinal: account.ordinal,
                      surface: "app",
                    })
                  }
                >
                  Disconnect app
                </Button>
              ) : null}
              {!isNative ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={hide.isPending}
                  onClick={() => hide.mutate({ provider, ordinal: account.ordinal })}
                >
                  Hide
                </Button>
              ) : null}
            </div>
          </DisclosureRegion>
        </div>
      }
    />
  );
}

function ProviderAccountsSection({
  provider,
  activeOrdinal,
  accounts,
  capabilities,
  onConnect,
}: {
  provider: SupportedAccountProvider;
  activeOrdinal: AccountOrdinal | null;
  accounts: ReadonlyArray<ProviderAccountView>;
  capabilities: ProviderAccountCapabilities | null;
  onConnect: (request: AccountConnectRequest) => void;
}) {
  const oauthSupported = capabilities !== null && capabilities.agent.oauth !== "unsupported";
  const apiKeySupported = capabilities !== null && capabilities.agent.apiKey !== "unsupported";
  const connectable = oauthSupported || apiKeySupported;

  return (
    <SettingsSection title={accountProviderLabel(provider)}>
      {accounts.map((account) => (
        <AccountRow
          key={account.ordinal}
          provider={provider}
          account={account}
          isActive={account.ordinal === (activeOrdinal ?? 0)}
          onReconnect={(ordinal) =>
            capabilities !== null
              ? onConnect({ provider, capabilities, reconnectOrdinal: ordinal })
              : undefined
          }
        />
      ))}
      {connectable && capabilities !== null ? (
        <SettingsListRow
          title={
            <span className="flex items-center gap-2">
              <ProviderIcon provider={provider} tone="header" className="size-3.5 shrink-0" />
              <span>Add {accountProviderLabel(provider)} account</span>
            </span>
          }
          description={
            oauthSupported
              ? "Connect another account with browser sign-in or an API key."
              : "Connect another account with an API key."
          }
          actions={
            <Button
              size="xs"
              variant="outline"
              onClick={() => onConnect({ provider, capabilities })}
            >
              Connect
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

function CliIntegrationSection() {
  const statusQuery = useQuery(providerAccountsIntegrationStatusQueryOptions());
  const update = useProviderAccountsUpdateCliIntegration();
  const status = statusQuery.data ?? null;
  const unavailable = status?.platformSupported === false;

  const description = unavailable
    ? "Launcher unavailable on Windows."
    : status?.launcherInstalled
      ? status.shimDirOnPath === false && status.shimDir !== undefined
        ? `Shims installed. Add ${status.shimDir} to the front of your PATH so terminal launches use the active managed account.`
        : "Provider shims are installed and terminal launches use the active managed account."
      : "Install provider shims so terminal launches use the active managed account.";

  return (
    <SettingsSection title="CLI integration">
      <SettingsListRow
        title="Terminal launcher"
        description={description}
        actions={
          unavailable || status === null ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={update.isPending}
              onClick={() => update.mutate({ enabled: !status.launcherInstalled })}
            >
              {status.launcherInstalled ? "Uninstall" : "Install"}
            </Button>
          )
        }
      />
    </SettingsSection>
  );
}

export function AccountsSettingsPanel({ active }: { active: boolean }) {
  const snapshotQuery = useQuery(providerAccountsSnapshotQueryOptions({ enabled: active }));
  const [connectRequest, setConnectRequest] = useState<AccountConnectRequest | null>(null);

  if (!active) {
    return null;
  }

  const providers = snapshotQuery.data?.providers ?? [];

  return (
    <div className="space-y-6">
      {SUPPORTED_ACCOUNT_PROVIDERS.map((provider) => {
        const entry = providers.find((candidate) => candidate.provider === provider) ?? null;
        return (
          <ProviderAccountsSection
            key={provider}
            provider={provider}
            activeOrdinal={entry?.activeOrdinal ?? null}
            accounts={entry?.accounts ?? []}
            capabilities={entry?.capabilities ?? null}
            onConnect={setConnectRequest}
          />
        );
      })}
      <CliIntegrationSection />
      {snapshotQuery.isError ? (
        <p className="text-sm text-muted-foreground">
          Accounts are unavailable right now. Retry from the sidebar or restart the server.
        </p>
      ) : null}
      <AccountConnectDialog
        request={connectRequest}
        onOpenChange={(open) => {
          if (!open) setConnectRequest(null);
        }}
      />
    </div>
  );
}
