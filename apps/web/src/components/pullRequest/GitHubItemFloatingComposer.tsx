// FILE: GitHubItemFloatingComposer.tsx
// Purpose: The composer that floats at the bottom of a GitHub item's detail page, on the chat
//          composer's own shell and send control: a one-line question box with a "+" menu, the
//          project and environment chips above it, and mic and send at its end. Submitting hands the question to the host (the inbox puts it into the
//          item's side chat). Purely a text box: model, approvals, and context live in the side
//          chat it opens.
// Layer: Pull request presentation
// Exports: GitHubItemFloatingComposer

import type { ProjectId, ThreadId } from "@synara/contracts";
import { useMemo, useRef, useState, type ReactNode } from "react";

import { getProviderInstanceOptions, useAppSettings } from "~/appSettings";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import {
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
  COMPOSER_INPUT_SHELL_CLASS_NAME,
  COMPOSER_INPUT_SURFACE_CLASS_NAME,
  COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
} from "~/components/chat/composerPickerStyles";
import { ComposerVoiceButton } from "~/components/chat/ComposerVoiceButton";
import { useComposerVoiceController } from "~/components/chat/useComposerVoiceController";
import { Button } from "~/components/ui/button";
import { Menu, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { useRefreshProviderStatusesNow } from "~/hooks/useProviderStatusRefresh";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { CentralIcon } from "~/lib/central-icons";
import {
  ChevronDownIcon,
  ComposerSendArrowIcon,
  FolderIcon,
  LoaderCircleIcon,
  PlusIcon,
} from "~/lib/icons";
import { resolveVoiceTranscriptionTarget } from "~/lib/providerAvailability";
import { resolveThreadEnvironmentPresentation } from "~/lib/threadEnvironment";
import { cn } from "~/lib/utils";
import { newThreadId } from "~/lib/utils";
import { useStore } from "~/store";

// The context chips above the question: the composer toolbar's own picker trigger (project,
// environment), on the secondary ink because here they frame the question rather than lead it.
const CHIP_CLASS_NAME = cn(
  COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
  "max-w-full cursor-default text-muted-foreground hover:bg-transparent",
);
const LOCAL_ENVIRONMENT = resolveThreadEnvironmentPresentation({ envMode: "local" });

export function GitHubItemFloatingComposer({
  placeholder,
  projects,
  projectId,
  onProjectChange,
  plusMenu,
  pending,
  onSubmit,
  className,
}: {
  placeholder: string;
  /** Projects the question can be asked in; more than one makes the project chip a picker. */
  projects: ReadonlyArray<{ projectId: ProjectId; projectTitle: string }>;
  projectId: ProjectId;
  onProjectChange: (projectId: ProjectId) => void;
  /** Entries of the "+" menu. */
  plusMenu: ReactNode;
  pending: boolean;
  onSubmit: (text: string) => void;
  className?: string;
}) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const project = useStore((store) => store.projects.find((entry) => entry.id === projectId));
  const projectTitle =
    projects.find((entry) => entry.projectId === projectId)?.projectTitle ?? project?.name ?? "";
  const scratchThreadId = useMemo<ThreadId>(() => newThreadId(), []);
  const { settings } = useAppSettings();
  const providerInstances = useMemo(() => getProviderInstanceOptions(settings), [settings]);
  const providerStatuses = useProviderStatusesForLocalConfig();
  const refreshProviderStatuses = useRefreshProviderStatusesNow();
  // Voice notes are transcribed on the Codex ChatGPT session whatever the side chat's provider.
  const voiceProviderTarget = useMemo(
    () =>
      resolveVoiceTranscriptionTarget({
        statuses: providerStatuses,
        providerInstances,
        selectedProvider: "codex",
        selectedProviderInstanceId: "codex",
      }),
    [providerInstances, providerStatuses],
  );
  const voice = useComposerVoiceController({
    activeProject: project,
    activeThreadId: null,
    threadId: scratchThreadId,
    selectedProvider: "codex",
    selectedProviderInstanceId: "codex",
    voiceProviderInstanceId: voiceProviderTarget?.instanceId ?? "codex",
    activeProviderStatus: voiceProviderTarget?.status ?? null,
    pendingUserInputCount: 0,
    onTranscriptReady: (transcript) =>
      setText((current) => (current.trim() ? `${current.trimEnd()} ${transcript}` : transcript)),
    refreshVoiceStatus: refreshProviderStatuses,
  });

  const canSend = text.trim().length > 0 && !pending;
  const submit = () => {
    if (!canSend) return;
    onSubmit(text);
  };

  return (
    <div data-github-item-composer className={cn(COMPOSER_INPUT_SHELL_CLASS_NAME, className)}>
      <div className={cn(COMPOSER_INPUT_SURFACE_CLASS_NAME, "flex flex-col gap-1 px-2 pt-2 pb-2")}>
        <div className="flex min-w-0 items-center gap-1">
          {projects.length > 1 ? (
            <Menu>
              <MenuTrigger
                aria-label={`Project: ${projectTitle}`}
                className={cn(
                  COMPOSER_TOOLBAR_PICKER_TRIGGER_CLASS_NAME,
                  "max-w-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
              >
                <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                <span className="truncate">{projectTitle}</span>
                <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
              </MenuTrigger>
              <ComposerPickerMenuPopup align="start" side="top" className="w-56 min-w-56">
                <MenuRadioGroup
                  value={projectId}
                  onValueChange={(value) => onProjectChange(value as ProjectId)}
                >
                  {projects.map((entry) => (
                    <MenuRadioItem key={entry.projectId} value={entry.projectId}>
                      <span className="truncate">{entry.projectTitle}</span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </ComposerPickerMenuPopup>
            </Menu>
          ) : (
            <span className={CHIP_CLASS_NAME} title="Project">
              <FolderIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{projectTitle}</span>
            </span>
          )}
          <span className={CHIP_CLASS_NAME} title="Runs in this project's local checkout">
            <CentralIcon name="macbook-air" className="size-3.5 shrink-0" />
            {LOCAL_ENVIRONMENT.shortLabel}
          </span>
        </div>
        <div className="flex items-end gap-1.5">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="mb-px shrink-0 text-muted-foreground"
                  aria-label="More ways to use this item"
                />
              }
            >
              <PlusIcon className="size-4" />
            </MenuTrigger>
            <ComposerPickerMenuPopup align="start" side="top" className="w-56 min-w-56">
              {plusMenu}
            </ComposerPickerMenuPopup>
          </Menu>
          <textarea
            ref={inputRef}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submit();
              }
            }}
            className={cn(
              COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
              "field-sizing-content max-h-40 min-h-8 min-w-0 flex-1 resize-none bg-transparent py-1 outline-none placeholder:text-muted-foreground/70",
            )}
          />
          {voice.showVoiceNotesControl ? (
            <ComposerVoiceButton
              disabled={!project}
              isRecording={voice.isVoiceRecording}
              isTranscribing={voice.isVoiceTranscribing}
              durationLabel={voice.voiceRecordingDurationLabel}
              onClick={() =>
                void (voice.isVoiceRecording
                  ? voice.submitComposerVoiceRecording()
                  : voice.startComposerVoiceRecording())
              }
            />
          ) : null}
          {/* The send control every composer uses. */}
          <Button
            variant="prominent"
            size="icon-xs"
            className="mb-0.5 size-7 shrink-0 rounded-full sm:size-7"
            disabled={!canSend}
            aria-label={pending ? "Starting side chat" : "Ask in a side chat"}
            onClick={submit}
          >
            {pending ? (
              <LoaderCircleIcon className="size-3 animate-spin" />
            ) : (
              <ComposerSendArrowIcon
                aria-hidden="true"
                className="size-5 shrink-0 translate-y-px"
              />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
