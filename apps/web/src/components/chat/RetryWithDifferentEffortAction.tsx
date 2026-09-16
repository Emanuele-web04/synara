// FILE: RetryWithDifferentEffortAction.tsx
// Purpose: Settled-assistant action menu to retry the turn at a different effort,
//   plus a compact variant pager for prior answers.
// Layer: Chat transcript presentation
// Depends on: message action chrome, menu primitives, retry effort logic/store.

import { type MessageId, type ThreadId } from "@synara/contracts";

import { ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuTrigger } from "../ui/menu";
import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { MessageActionButton, MESSAGE_ACTION_ICON_CLASS_NAME } from "./MessageActionButton";
import { getRetryEffortVariantGroup, useRetryEffortVariantStore } from "./retryEffortVariantStore";
import {
  filterSupportedRetryEfforts,
  mergeRetryVariants,
  type RetryEffortOption,
  type RetryEffortVariant,
  type RetryWithDifferentEffortAvailability,
} from "./retryWithDifferentEffort.logic";

type RetryWithDifferentEffortActionProps = {
  readonly threadId: ThreadId;
  readonly availability: RetryWithDifferentEffortAvailability;
  readonly disabled?: boolean;
  readonly onRetryWithEffort: (effort: string) => void;
  readonly className?: string;
};

function useMergedRetryVariants(input: {
  readonly threadId: ThreadId;
  readonly userMessageId: MessageId | null;
  readonly live: RetryEffortVariant | null;
}): ReadonlyArray<RetryEffortVariant> {
  const group = useRetryEffortVariantStore((state) =>
    input.userMessageId
      ? getRetryEffortVariantGroup(state, input.threadId, input.userMessageId)
      : null,
  );
  return mergeRetryVariants({
    archived: group?.variants ?? [],
    live: input.live,
  });
}

export function useDisplayedRetryVariantText(input: {
  readonly threadId: ThreadId;
  readonly userMessageId: MessageId | null;
  readonly live: RetryEffortVariant | null;
  readonly liveText: string;
}): string {
  const variants = useMergedRetryVariants({
    threadId: input.threadId,
    userMessageId: input.userMessageId,
    live: input.live,
  });
  const group = useRetryEffortVariantStore((state) =>
    input.userMessageId
      ? getRetryEffortVariantGroup(state, input.threadId, input.userMessageId)
      : null,
  );
  if (variants.length === 0) return input.liveText;
  const preferredIndex = group?.activeIndex ?? variants.length - 1;
  const active = variants[Math.min(Math.max(preferredIndex, 0), variants.length - 1)];
  if (!active) return input.liveText;
  if (input.live && active.assistantMessageId === input.live.assistantMessageId) {
    return input.liveText;
  }
  return active.text;
}

export function RetryEffortVariantPager(props: {
  readonly threadId: ThreadId;
  readonly userMessageId: MessageId;
  readonly live: RetryEffortVariant | null;
  readonly className?: string;
}) {
  const variants = useMergedRetryVariants({
    threadId: props.threadId,
    userMessageId: props.userMessageId,
    live: props.live,
  });
  const group = useRetryEffortVariantStore((state) =>
    getRetryEffortVariantGroup(state, props.threadId, props.userMessageId),
  );
  const setActiveIndex = useRetryEffortVariantStore((state) => state.setActiveIndex);

  if (variants.length < 2) {
    return null;
  }

  const activeIndex = Math.min(group?.activeIndex ?? variants.length - 1, variants.length - 1);
  const active = variants[activeIndex];
  const effortBadge = active?.effortLabel ?? active?.effort;

  return (
    <div
      className={cn("flex items-center gap-1 tabular-nums text-muted-foreground", props.className)}
      data-testid="retry-effort-variant-pager"
    >
      <MessageActionButton
        label="Previous attempt"
        tooltip="Previous attempt"
        disabled={activeIndex <= 0}
        onClick={() =>
          setActiveIndex({
            threadId: props.threadId,
            userMessageId: props.userMessageId,
            activeIndex: activeIndex - 1,
          })
        }
      >
        <ChevronLeftIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
      </MessageActionButton>
      <span aria-live="polite">
        {activeIndex + 1} / {variants.length}
        {effortBadge ? ` · ${effortBadge}` : ""}
      </span>
      <MessageActionButton
        label="Next attempt"
        tooltip="Next attempt"
        disabled={activeIndex >= variants.length - 1}
        onClick={() =>
          setActiveIndex({
            threadId: props.threadId,
            userMessageId: props.userMessageId,
            activeIndex: activeIndex + 1,
          })
        }
      >
        <ChevronRightIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
      </MessageActionButton>
    </div>
  );
}

function EffortMenuItems(props: {
  readonly options: ReadonlyArray<RetryEffortOption>;
  readonly onSelect: (effort: string) => void;
}) {
  const options = filterSupportedRetryEfforts(props.options);
  return (
    <MenuGroup>
      <MenuGroupLabel>Retry with different effort</MenuGroupLabel>
      {options.map((option) => (
        <MenuItem
          key={option.value}
          disabled={option.isCurrent}
          onClick={() => {
            if (option.isCurrent) return;
            props.onSelect(option.value);
          }}
        >
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate">
              {option.label}
              {option.isCurrent ? " (current)" : ""}
            </span>
            {option.description ? (
              <span className="truncate text-[length:var(--app-font-size-ui-2xs,10px)] text-muted-foreground">
                {option.description}
              </span>
            ) : null}
          </span>
        </MenuItem>
      ))}
    </MenuGroup>
  );
}

export function RetryWithDifferentEffortAction(props: RetryWithDifferentEffortActionProps) {
  const { availability } = props;
  const supportedOptions = filterSupportedRetryEfforts(availability.effortOptions);
  const hasMenu = supportedOptions.length > 0;

  if (!availability.enabled) {
    if (!hasMenu) return null;
    return (
      <MessageActionButton
        label="Retry with different effort"
        tooltip={availability.detail}
        disabled
        className={cn(props.className, "disabled:text-muted-foreground/35")}
      >
        <RefreshCwIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
      </MessageActionButton>
    );
  }

  const trigger = (
    <MessageActionButton
      label="Retry with different effort"
      tooltip="Retry with different effort"
      disabled={props.disabled}
      className={props.className}
    >
      <RefreshCwIcon className={MESSAGE_ACTION_ICON_CLASS_NAME} />
    </MessageActionButton>
  );

  return (
    <Menu>
      <MenuTrigger render={trigger} />
      <ComposerPickerMenuPopup align="end" side="top">
        <EffortMenuItems options={supportedOptions} onSelect={props.onRetryWithEffort} />
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
