// FILE: ProviderAccountMenu.tsx
// Purpose: Sidebar quick-switch popup for provider accounts (plan section 36.1). Shows the
//          active numbered slot per provider, a submenu to switch slots, and links to
//          Settings → Accounts.
// Layer: App component

import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { ProviderIcon } from "~/components/ProviderIcon";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import {
  accountProviderLabel,
  accountSlotLabel,
  providerAccountsSnapshotQueryOptions,
  SUPPORTED_ACCOUNT_PROVIDERS,
  useProviderAccountsSetActive,
} from "~/lib/providerAccountsReactQuery";

export function ProviderAccountMenu({
  children,
  triggerClassName,
}: {
  children: ReactNode;
  triggerClassName?: string;
}) {
  const navigate = useNavigate();
  const snapshotQuery = useQuery(providerAccountsSnapshotQueryOptions());
  const setActive = useProviderAccountsSetActive();
  const providers = snapshotQuery.data?.providers ?? [];

  const openAccountsSettings = () =>
    void navigate({ to: "/settings", search: { section: "accounts" } });

  return (
    <Menu modal={false}>
      <MenuTrigger
        render={<button type="button" aria-label="Accounts" className={triggerClassName} />}
      >
        {children}
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="top" className="w-60 min-w-60">
        <MenuGroup>
          <MenuGroupLabel>Accounts</MenuGroupLabel>
        </MenuGroup>
        {SUPPORTED_ACCOUNT_PROVIDERS.map((provider) => {
          const entry = providers.find((candidate) => candidate.provider === provider) ?? null;
          const visibleAccounts = entry?.accounts ?? [];
          return (
            <MenuSub key={provider}>
              <MenuSubTrigger>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <ProviderIcon provider={provider} tone="header" className="size-3.5 shrink-0" />
                  <span className="truncate">{accountProviderLabel(provider)}</span>
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {entry ? accountSlotLabel(provider, entry.activeOrdinal) : "—"}
                </span>
              </MenuSubTrigger>
              <MenuSubPopup className="w-48 min-w-48">
                {visibleAccounts.length > 0 ? (
                  <MenuRadioGroup
                    value={entry?.activeOrdinal}
                    onValueChange={(value) => {
                      if (typeof value !== "number" || value === entry?.activeOrdinal) return;
                      setActive.mutate({ provider, ordinal: value });
                    }}
                  >
                    {visibleAccounts.map((account) => (
                      <MenuRadioItem key={account.ordinal} value={account.ordinal}>
                        {accountSlotLabel(provider, account.ordinal)}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                ) : (
                  <MenuItem disabled>No accounts connected</MenuItem>
                )}
                <MenuSeparator />
                <MenuItem onClick={openAccountsSettings}>Add account</MenuItem>
              </MenuSubPopup>
            </MenuSub>
          );
        })}
        <MenuSeparator />
        <MenuItem onClick={openAccountsSettings}>Manage accounts</MenuItem>
        <MenuItem onClick={() => void navigate({ to: "/settings", search: { section: "usage" } })}>
          Usage
        </MenuItem>
        <MenuItem onClick={() => void navigate({ to: "/settings" })}>Settings</MenuItem>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
