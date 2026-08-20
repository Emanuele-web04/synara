// FILE: RunningChatsQuitDialog.tsx
// Purpose: Confirms desktop quit while chats are still running.
// Layer: Root web overlay
// Depends on: Base UI alert-dialog primitives, the ⌘P palette surface, and the shared running spinner.

import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";

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
import { commandDialogPopupClassName } from "~/components/ui/command";
import {
  runningChatsQuitCopy,
  type RunningChatQuitSummary,
} from "~/lib/runningChatsQuitConfirmation";
import { cn } from "~/lib/utils";

export interface RunningChatsQuitDialogProps {
  readonly chats: ReadonlyArray<RunningChatQuitSummary> | null;
  readonly onStay: () => void;
  readonly onQuit: () => void;
}

const uiFont = "font-[family-name:var(--font-ui-family)]";

// Same surface as the ⌘P palette: the body sits on the palette's list background and the footer
// shows the popup's lighter overlay through, separated by a hairline — mirroring CommandPanel +
// CommandFooter without the palette's scroll chrome.
const BODY_CLASS =
  "relative rounded-t-[calc(var(--radius-2xl)-1px)] border-b border-[color:var(--color-border-light)] bg-[var(--color-background-surface-under)] px-4 pt-3 pb-3.5";
const FOOTER_CLASS = "relative flex items-center justify-end gap-2 px-3 py-2";
const KEY_HINT_CLASS = "text-[11px] font-normal tabular-nums opacity-55";

export function RunningChatsQuitDialog({ chats, onStay, onQuit }: RunningChatsQuitDialogProps) {
  const copy = chats && chats.length > 0 ? runningChatsQuitCopy(chats, APP_DISPLAY_NAME) : null;

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
              "w-[520px] max-w-[calc(100vw-2rem)] max-h-full text-[12px] before:shadow-none dark:before:shadow-none",
            )}
          >
            {copy && chats ? (
              <>
                <div className={BODY_CLASS}>
                  <AlertDialogPrimitive.Title
                    className={cn(uiFont, "m-0 text-[14px] font-medium leading-5")}
                  >
                    {copy.title}
                  </AlertDialogPrimitive.Title>
                  <AlertDialogPrimitive.Description
                    className={cn(
                      uiFont,
                      "m-0 mt-1 text-[12.5px] font-normal leading-[18px] text-muted-foreground",
                    )}
                  >
                    {copy.description}
                  </AlertDialogPrimitive.Description>
                  <ul className="m-0 mt-3 flex max-h-[40vh] list-none flex-col gap-2 overflow-y-auto p-0">
                    {chats.map((chat) => (
                      <li key={chat.id} className="flex min-w-0 items-center gap-2.5">
                        <ThreadRunningSpinner />
                        <span
                          className={cn(
                            uiFont,
                            "truncate text-[12.5px] font-normal leading-[18px]",
                          )}
                        >
                          {chat.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className={FOOTER_CLASS}>
                  <AlertDialogClose
                    render={<Button variant="ghost" size="sm" className={cn(uiFont, "gap-1.5")} />}
                  >
                    {copy.stayLabel}
                    <span className={KEY_HINT_CLASS}>Esc</span>
                  </AlertDialogClose>
                  <Button
                    autoFocus
                    variant="default"
                    size="sm"
                    className={cn(uiFont, "gap-1.5")}
                    onClick={onQuit}
                  >
                    {copy.quitLabel}
                    <span aria-hidden className={KEY_HINT_CLASS}>
                      ↵
                    </span>
                  </Button>
                </div>
              </>
            ) : null}
          </AlertDialogPrimitive.Popup>
        </AlertDialogViewport>
      </AlertDialogPortal>
    </AlertDialog>
  );
}
