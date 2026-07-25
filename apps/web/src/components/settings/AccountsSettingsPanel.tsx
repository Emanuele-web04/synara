// FILE: AccountsSettingsPanel.tsx
// Purpose: Settings → Accounts panel (plan sections 36.2–36.4). Lists each supported
//          provider's numbered account slots with identity, agent/app binding state,
//          support-level labels, and per-account actions.
// Layer: Settings UI components

import type {
  AccountOrdinal,
  ProviderAccountView,
  SupportedAccountProvider,
} from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

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
  providerAccountsSnapshotQueryOptions,
  SUPPORTED_ACCOUNT_PROVIDERS,
  useProviderAccountsBeginConnect,
  useProviderAccountsDisconnectBinding,
  useProviderAccountsHide,
  useProviderAccountsLaunch,
  useProviderAccountsSetActive,
} from "~/lib/providerAccountsReactQuery";
import { SettingsListRow, SettingsSection } from "./SettingsPanelPrimitives";

function AccountRow({
  provider,
  account,
  isActive,
  appSupported,
}: {
  provider: SupportedAccountProvider;
  account: ProviderAccountView;
  isActive: boolean;
  appSupported: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const setActive = useProviderAccountsSetActive();
  const beginConnect = useProviderAccountsBeginConnect();
  const disconnectBinding = useProviderAccountsDisconnectBinding();
  const hide = useProviderAccountsHide();
  const launch = useProviderAccountsLaunch();

  const identity = accountIdentityLabel(account.identity);
  const agentState = account.agent ? ACCOUNT_BINDING_STATE_LABELS[account.agent.state] : null;
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
          {!account.agent && !account.app ? <div>Native</div> : null}
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
              {account.agent ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={beginConnect.isPending}
                  onClick={() =>
                    beginConnect.mutate({
                      provider,
                      surface: "agent",
                      authMethod: account.agent!.authMethod,
                      ordinal: account.ordinal,
                    })
                  }
                >
                  Reconnect agent
                </Button>
              ) : null}
              {appSupported && !account.app ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={beginConnect.isPending}
                  onClick={() =>
                    beginConnect.mutate({
                      provider,
                      surface: "app",
                      authMethod: "oauth",
                      ordinal: account.ordinal,
                    })
                  }
                >
                  Connect app
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
              {account.agent || account.app ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={disconnectBinding.isPending}
                  onClick={() =>
                    disconnectBinding.mutate({
                      provider,
                      ordinal: account.ordinal,
                      surface: account.agent ? "agent" : "app",
                    })
                  }
                >
                  Disconnect
                </Button>
              ) : null}
              <Button
                size="xs"
                variant="outline"
                disabled={hide.isPending}
                onClick={() => hide.mutate({ provider, ordinal: account.ordinal })}
              >
                Hide
              </Button>
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
  appSupported,
}: {
  provider: SupportedAccountProvider;
  activeOrdinal: AccountOrdinal | null;
  accounts: ReadonlyArray<ProviderAccountView>;
  appSupported: boolean;
}) {
  const beginConnect = useProviderAccountsBeginConnect();

  return (
    <SettingsSection title={accountProviderLabel(provider)}>
      {accounts.map((account) => (
        <AccountRow
          key={account.ordinal}
          provider={provider}
          account={account}
          isActive={account.ordinal === activeOrdinal}
          appSupported={appSupported}
        />
      ))}
      <SettingsListRow
        title={
          <span className="flex items-center gap-2">
            <ProviderIcon provider={provider} tone="header" className="size-3.5 shrink-0" />
            <span>Add {accountProviderLabel(provider)} account</span>
          </span>
        }
        description="Connect another account with browser sign-in."
        actions={
          <Button
            size="xs"
            variant="outline"
            disabled={beginConnect.isPending}
            onClick={() => beginConnect.mutate({ provider, surface: "agent", authMethod: "oauth" })}
          >
            Connect
          </Button>
        }
      />
    </SettingsSection>
  );
}

export function AccountsSettingsPanel({ active }: { active: boolean }) {
  const snapshotQuery = useQuery(providerAccountsSnapshotQueryOptions({ enabled: active }));

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
            appSupported={entry ? entry.capabilities.app.supportLevel !== "unsupported" : false}
          />
        );
      })}
      {snapshotQuery.isError ? (
        <p className="text-sm text-muted-foreground">
          Accounts are unavailable right now. Retry from the sidebar or restart the server.
        </p>
      ) : null}
    </div>
  );
}
