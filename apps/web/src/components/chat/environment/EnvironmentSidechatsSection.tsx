import type { ThreadId } from "@synara/contracts";

import { IconButton } from "~/components/ui/icon-button";
import { PlusIcon, SidechatIcon, TrashCanIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import {
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRow,
  EnvironmentSectionDivider,
  EnvironmentSectionLabel,
} from "./EnvironmentRow";

export interface EnvironmentSidechatPanelItem {
  readonly id: ThreadId;
  readonly title: string;
  readonly expiredAt: string | null;
}

export function EnvironmentSidechatsSection({
  sidechats,
  onCreate,
  onOpen,
  onDelete,
}: {
  readonly sidechats: readonly EnvironmentSidechatPanelItem[];
  readonly onCreate: () => void;
  readonly onOpen: (threadId: ThreadId) => void;
  readonly onDelete: (sidechat: EnvironmentSidechatPanelItem) => void;
}) {
  // No side chats yet: hide the whole section instead of showing an empty header row.
  if (sidechats.length === 0) {
    return null;
  }
  return (
    <>
      <EnvironmentSectionDivider />
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center justify-between gap-2 pr-2">
          <EnvironmentSectionLabel>Side chats</EnvironmentSectionLabel>
          <IconButton label="Start side chat" tooltip="Start side chat" onClick={onCreate}>
            <PlusIcon className="size-3.5" />
          </IconButton>
        </div>
        {sidechats.map((sidechat) => {
          const expired = sidechat.expiredAt !== null;
          // The delete button overlays the row instead of nesting inside it (a button cannot
          // contain a button); the hover-only spacer reserves its slot next to "Expired".
          return (
            <div key={sidechat.id} className="group/sidechat relative">
              <EnvironmentRow
                icon={<SidechatIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
                label={<span className="truncate">{sidechat.title}</span>}
                trailing={
                  <>
                    {expired ? (
                      <span className="text-[var(--color-text-foreground-secondary)]">Expired</span>
                    ) : null}
                    <span
                      aria-hidden
                      className="hidden w-7 group-focus-within/sidechat:block group-hover/sidechat:block sm:w-6"
                    />
                  </>
                }
                className={cn(expired && "opacity-60")}
                aria-label={`Open side chat ${sidechat.title}${expired ? " (expired)" : ""}`}
                onClick={() => onOpen(sidechat.id)}
              />
              <IconButton
                label={`Delete side chat ${sidechat.title}`}
                tooltip="Delete side chat"
                className="absolute top-1/2 right-2 -translate-y-1/2 opacity-0 transition-opacity group-hover/sidechat:opacity-100 focus-visible:opacity-100"
                onClick={() => onDelete(sidechat)}
              >
                <TrashCanIcon className="size-3.5" />
              </IconButton>
            </div>
          );
        })}
      </div>
    </>
  );
}
