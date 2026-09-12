// Purpose: Floating composer that retains a transcript quote while the user writes a new prompt.

import type { ThreadEnvironmentMode } from "@synara/contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ArrowUpRightIcon, ComposerSendArrowIcon, LoaderCircleIcon, XIcon } from "~/lib/icons";
import { resolveThreadEnvironmentPresentation } from "~/lib/threadEnvironment";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { Button } from "../ui/button";
import { AssistantSelectionsSummaryChip } from "./AssistantSelectionsSummaryChip";
import { ComposerEnvironmentPicker } from "./ComposerEnvironmentPicker";
import {
  COMPOSER_EDITOR_PADDING_CLASS_NAME,
  COMPOSER_FOOTER_ROW_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
} from "./composerPickerStyles";
import { cn } from "~/lib/utils";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import { TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX } from "./chatSelectionActions";
import type { PendingTranscriptSelectionAction } from "./useTranscriptAssistantSelectionAction";

interface SelectionNewChatComposerProps {
  action: PendingTranscriptSelectionAction;
  defaultEnvMode: ThreadEnvironmentMode;
  canUseWorktree: boolean;
  onSend: (prompt: string, envMode: ThreadEnvironmentMode) => Promise<void>;
  onOpenInChat: (prompt: string, envMode: ThreadEnvironmentMode) => Promise<void>;
  onClose: () => void;
}

export function SelectionNewChatComposer({
  action,
  defaultEnvMode,
  canUseWorktree,
  onSend,
  onOpenInChat,
  onClose,
}: SelectionNewChatComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [cursor, setCursor] = useState(0);
  const [envMode, setEnvMode] = useState(canUseWorktree ? defaultEnvMode : "local");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<ComposerPromptEditorHandle>(null);
  const environmentMenuOpenRef = useRef(false);
  const selections = [
    {
      type: "assistant-selection" as const,
      id: action.selection.assistantMessageId,
      ...action.selection,
    },
  ];

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const position = () => {
      const { width, height } = surface.getBoundingClientRect();
      const top =
        action.placement === "top"
          ? action.top + TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX - height
          : action.top;
      surface.style.left = `${Math.max(8, Math.min(action.left, window.innerWidth - width - 8))}px`;
      surface.style.top = `${Math.max(8, Math.min(top, window.innerHeight - height - 8))}px`;
    };
    position();
    inputRef.current?.focus();
    const observer = new ResizeObserver(position);
    observer.observe(surface);
    window.addEventListener("resize", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
    };
  }, [action]);

  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        !submittingRef.current &&
        event.target instanceof Node &&
        !surfaceRef.current?.contains(event.target) &&
        !(
          event.target instanceof Element &&
          event.target.closest("[data-composer-environment-menu]")
        )
      ) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submittingRef.current && !environmentMenuOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const submit = async (intent: "send" | "compose") => {
    const nextPrompt = inputRef.current?.readSnapshot().value ?? prompt;
    if (submittingRef.current || (intent === "send" && !nextPrompt.trim())) return;
    submittingRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await (intent === "send" ? onSend : onOpenInChat)(nextPrompt, envMode);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the chat. Try again.");
    } finally {
      submittingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div
      ref={surfaceRef}
      data-transcript-selection-action="true"
      role="dialog"
      aria-label="New chat from selection"
      className="fixed z-50 w-[320px] max-w-[calc(100vw-16px)] text-foreground"
      // No overflow on this wrapper: a scroll box is square and would clip the rounded
      // surface's shadow into hard corners. The editor caps and scrolls its own height.
      style={{ left: action.left, top: action.top }}
    >
      <div className={COMPOSER_INPUT_SHELL_CLASS_NAME}>
        <div className={COMPOSER_INPUT_SURFACE_CLASS_NAME}>
          <DisclosureRegion open>
            <form
              aria-busy={busy}
              onSubmit={(event) => {
                event.preventDefault();
                void submit("send");
              }}
            >
              <div className={cn(COMPOSER_EDITOR_PADDING_CLASS_NAME, "px-2.5 pt-2 pb-1")}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <AssistantSelectionsSummaryChip selections={selections} />
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => {
                        void submit("compose");
                      }}
                    >
                      Open in chat
                      <ArrowUpRightIcon className="size-3" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Close new chat composer"
                      disabled={busy}
                      onClick={onClose}
                    >
                      <XIcon className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <ComposerPromptEditor
                  ref={inputRef}
                  value={prompt}
                  cursor={cursor}
                  terminalContexts={[]}
                  disabled={busy}
                  ariaLabel="Message for new chat"
                  className="min-h-[1lh]"
                  placeholder="Ask about this selection…"
                  onRemoveTerminalContext={() => {}}
                  onPaste={() => {}}
                  onChange={(value, nextCursor) => {
                    setPrompt(value);
                    setCursor(nextCursor);
                  }}
                  onCommandKeyDown={(key, event) => {
                    if (key !== "Enter" || event.shiftKey || event.isComposing) return false;
                    void submit("send");
                    return true;
                  }}
                />
              </div>
              {error ? (
                <p role="alert" className="px-3 pb-2 text-xs text-destructive">
                  {error}
                </p>
              ) : null}
              <div className={cn(COMPOSER_FOOTER_ROW_CLASS_NAME, "gap-2")}>
                <ComposerEnvironmentPicker
                  environmentPresentation={resolveThreadEnvironmentPresentation({ envMode })}
                  onEnvModeChange={setEnvMode}
                  canSwitchToWorktree={canUseWorktree && envMode === "local"}
                  disabled={busy}
                  onOpenChange={(open) => {
                    environmentMenuOpenRef.current = open;
                  }}
                />
                <Button
                  type="submit"
                  variant="prominent"
                  size="icon-xs"
                  className="size-7 rounded-full sm:size-7"
                  aria-label="Send to new chat"
                  disabled={busy || !prompt.trim()}
                >
                  {busy ? (
                    <LoaderCircleIcon className="size-3 animate-spin" />
                  ) : (
                    <ComposerSendArrowIcon
                      aria-hidden="true"
                      className="size-5 shrink-0 translate-y-px"
                    />
                  )}
                </Button>
              </div>
            </form>
          </DisclosureRegion>
        </div>
      </div>
    </div>
  );
}
