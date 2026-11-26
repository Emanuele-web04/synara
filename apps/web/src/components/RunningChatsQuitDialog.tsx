// FILE: RunningChatsQuitDialog.tsx
// Purpose: Confirms a desktop quit while chats are running, and lets the person
//          stop being asked.
// Layer: Root web overlay
// Depends on: Base UI alert-dialog primitives, the ⌘P palette surface, the shared running spinner,
// and the persisted quit app settings.

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { useId, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { APP_DISPLAY_NAME } from "~/branding";
import { ThreadRunningSpinner } from "~/components/ThreadRunningSpinner";
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogClose,
  AlertDialogPortal,
  AlertDialogViewport,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { commandDialogPopupClassName } from "~/components/ui/command";
import {
  runningChatsQuitCopy,
  type RunningChatQuitSummary,
  type RunningChatsQuitCopy,
} from "~/lib/runningChatsQuitConfirmation";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/i18n";

export interface RunningChatsQuitDecision {
  /** Remember the listed chats and continue them automatically on the next launch. */
  readonly resume: boolean;
}

export interface RunningChatsQuitDialogProps {
  readonly chats: ReadonlyArray<RunningChatQuitSummary> | null;
  /** Quit was confirmed and is being finalized; the dialog stays visible but inert. */
  readonly quitting?: boolean;
  readonly onStay: () => void;
  readonly onQuit: (decision: RunningChatsQuitDecision) => void;
}

const uiFont = "font-[family-name:var(--font-ui-family)]";

// Same surface as the ⌘P palette: the body sits on the palette's list background and the footer
// shows the popup's lighter overlay through, separated by a hairline — mirroring CommandPanel +
// CommandFooter without the palette's scroll chrome.
const BODY_CLASS =
  "relative rounded-t-[calc(var(--radius-2xl)-1px)] border-b border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] px-4 pt-3 pb-3.5";
const FOOTER_CLASS = "relative flex items-center gap-2 px-3 py-2";
const KEY_HINT_CLASS = "text-ui-sm font-normal tabular-nums opacity-55";
const CHECKBOX_CLASS =
  "flex cursor-pointer select-none items-center gap-2 text-ui font-normal leading-[18px] text-muted-foreground";

export function RunningChatsQuitDialog({
  chats,
  quitting = false,
  onStay,
  onQuit,
}: RunningChatsQuitDialogProps) {
  const { t } = useTranslation();
  const copy = chats != null ? runningChatsQuitCopy(chats, APP_DISPLAY_NAME, t) : null;

  return (
    <AlertDialog
      open={copy != null}
      onOpenChange={(open) => {
        if (!open) onStay();
      }}
    >
      <AlertDialogPortal>
        <AlertDialogBackdrop />
        <AlertDialogViewport>
          <AlertDialogPrimitive.Popup
            className={cn(
              commandDialogPopupClassName,
              uiFont,
              // Keep the palette's hairline border but drop its inner top highlight/shadow.
              "w-[520px] max-w-[calc(100vw-2rem)] max-h-full text-ui before:shadow-none dark:before:shadow-none",
            )}
          >
            {copy && chats ? (
              <RunningChatsQuitDialogContent
                chats={chats}
                copy={copy}
                quitting={quitting}
                onQuit={onQuit}
              />
            ) : null}
          </AlertDialogPrimitive.Popup>
        </AlertDialogViewport>
      </AlertDialogPortal>
    </AlertDialog>
  );
}

function QuitCheckbox(props: {
  readonly id: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly className: string;
  readonly label: string;
}) {
  return (
    <label htmlFor={props.id} className={cn(uiFont, CHECKBOX_CLASS, props.className)}>
      <Checkbox
        id={props.id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(checked) => props.onCheckedChange(checked === true)}
      />
      <span className="truncate">{props.label}</span>
    </label>
  );
}

// Mounted only while the dialog is open so the settings subscription costs nothing otherwise.
function RunningChatsQuitDialogContent({
  chats,
  copy,
  quitting,
  onQuit,
}: {
  readonly chats: ReadonlyArray<RunningChatQuitSummary>;
  readonly copy: RunningChatsQuitCopy;
  readonly quitting: boolean;
  readonly onQuit: (decision: RunningChatsQuitDecision) => void;
}) {
  const { t } = useTranslation();

  const { settings, updateSettings } = useAppSettings();
  const resume = settings.resumeChatsAfterQuit;
  const resumeCheckboxId = useId();
  const quietQuitCheckboxId = useId();
  // A choice about this quit, not a preference written the moment it is ticked:
  // ticking it and pressing Stay must not switch the question off for good.
  const [quietQuit, setQuietQuit] = useState(!settings.askBeforeQuitting);

  return (
    <>
      <div className={BODY_CLASS}>
        <AlertDialogPrimitive.Title className={cn(uiFont, "m-0 text-ui-lg font-medium leading-5")}>
          {copy.title}
        </AlertDialogPrimitive.Title>
        <AlertDialogPrimitive.Description
          className={cn(
            uiFont,
            "m-0 mt-1 text-ui-lg font-normal leading-[18px] text-muted-foreground",
          )}
        >
          {copy.description}
        </AlertDialogPrimitive.Description>
        {chats.length > 0 ? (
          <ul className="m-0 mt-3 flex max-h-[40vh] list-none flex-col gap-2 overflow-y-auto p-0">
            {chats.map((chat) => (
              <li key={chat.id} className="flex min-w-0 items-center gap-2.5">
                <ThreadRunningSpinner />
                <span className={cn(uiFont, "truncate text-ui-lg font-normal leading-[18px]")}>
                  {chat.title}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <QuitCheckbox
          id={quietQuitCheckboxId}
          checked={quietQuit}
          disabled={quitting}
          onCheckedChange={setQuietQuit}
          className="mt-3"
          label={t("workspace:quit_quietLabel")}
        />
      </div>
      <div className={FOOTER_CLASS}>
        {chats.length > 0 ? (
          <QuitCheckbox
            id={resumeCheckboxId}
            checked={resume}
            disabled={quitting}
            onCheckedChange={(checked) => {
              updateSettings({ resumeChatsAfterQuit: checked });
            }}
            className="min-w-0 px-1"
            label={copy.resumeLabel}
          />
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <AlertDialogClose
            disabled={quitting}
            render={<Button variant="ghost" size="sm" className={cn(uiFont, "gap-1.5")} />}
          >
            {copy.stayLabel}
            <span className={KEY_HINT_CLASS}>{t("common:esc")}</span>
          </AlertDialogClose>
          <Button
            autoFocus
            variant="default"
            size="sm"
            className={cn(uiFont, "gap-1.5")}
            disabled={quitting}
            onClick={() => {
              if (quietQuit !== !settings.askBeforeQuitting) {
                updateSettings({ askBeforeQuitting: !quietQuit });
              }
              onQuit({ resume: chats.length > 0 && resume });
            }}
          >
            {copy.quitLabel}
            <span aria-hidden className={KEY_HINT_CLASS}>
              ↵
            </span>
          </Button>
        </div>
      </div>
    </>
  );
}
