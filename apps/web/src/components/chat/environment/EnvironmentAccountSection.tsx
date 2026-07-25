// FILE: EnvironmentAccountSection.tsx
// Purpose: "Account" section of the Environment panel — shows the provider account slot the
//          active thread is bound to (plan section 36.5). Existing sessions stay bound to
//          their original account, so this reflects the thread's binding, not the active slot.

import type { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { ProviderIcon } from "~/components/ProviderIcon";
import {
  accountSlotLabel,
  providerAccountsThreadBindingQueryOptions,
} from "~/lib/providerAccountsReactQuery";

import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentLabeledSection,
  EnvironmentRow,
} from "./EnvironmentRow";

export function EnvironmentAccountSection({
  threadId,
  enabled,
  onClose,
}: {
  threadId: ThreadId;
  enabled: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const bindingQuery = useQuery(providerAccountsThreadBindingQueryOptions({ threadId, enabled }));
  const binding = bindingQuery.data?.binding ?? null;

  if (!binding) {
    return null;
  }

  return (
    <EnvironmentLabeledSection label="Account">
      <EnvironmentRow
        icon={
          <ProviderIcon
            provider={binding.provider}
            tone="header"
            className={ENVIRONMENT_ROW_ICON_CLASS_NAME}
          />
        }
        label={accountSlotLabel(binding.provider, binding.ordinal)}
        onClick={() => {
          void navigate({ to: "/settings", search: { section: "accounts" } });
          onClose();
        }}
      />
    </EnvironmentLabeledSection>
  );
}
