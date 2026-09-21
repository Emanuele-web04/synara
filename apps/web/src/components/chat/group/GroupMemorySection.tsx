import {
  MEMORY_AUTO_DOCUMENT_PATH,
  MEMORY_DOCUMENT_PREFIX,
  MEMORY_THREAD_DOCUMENT_PREFIX,
} from "@synara/shared/projectAgent";
import { useEffect, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import type { useProjectInstructionsAutosave } from "~/components/chat/environment/EnvironmentProjectInstructionsSection";
import type { useProjectInstructionsSource } from "~/components/chat/project/useProjectInstructionsSource";
import type { useProjectAgent } from "~/components/chat/project/useProjectAgent";
import { EnvironmentCollapsibleSection } from "~/components/chat/environment/EnvironmentRow";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsListRow,
  SettingsRow,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { IconButton } from "~/components/ui/icon-button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { ArrowUpIcon } from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";

import { CharacterCountTextarea } from "./CharacterCountTextarea";
import {
  GROUP_INSTRUCTIONS_MAX_CHARS,
  memoryNoteDocumentPath,
  type GroupSettingsDraft,
} from "./groupSettingsDialog.logic";

function MemoryDocumentDialog(props: {
  readonly logicalPath: string | null;
  readonly agent: ReturnType<typeof useProjectAgent>;
  readonly onClose: () => void;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = props.logicalPath !== null;
  const readDocument = props.agent.readDocument;

  useEffect(() => {
    const logicalPath = props.logicalPath;
    if (!open || !logicalPath) return;
    let cancelled = false;
    setContent(null);
    setError(null);
    void (async () => {
      try {
        const read = await readDocument(logicalPath);
        if (cancelled) return;
        if (!read) {
          setError("Project coordinator is unavailable.");
          return;
        }
        setContent(read.document.content);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Failed to load this file.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, props.logicalPath, readDocument]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">{props.logicalPath}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {error ? (
            <p className="text-[12px] text-destructive" role="alert">
              {error}
            </p>
          ) : content === null ? (
            <p className="text-[12px] text-muted-foreground">Loading…</p>
          ) : content.trim().length === 0 ? (
            <p className="text-[12px] text-muted-foreground">This file is empty.</p>
          ) : (
            <ChatMarkdown text={content} cwd={undefined} />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

export function GroupMemorySection(props: {
  readonly configured: boolean;
  readonly draft: GroupSettingsDraft;
  readonly agent: ReturnType<typeof useProjectAgent>;
  readonly instructionsSource: ReturnType<typeof useProjectInstructionsSource>;
  readonly instructionsAutosave: ReturnType<typeof useProjectInstructionsAutosave>;
  readonly onChange: (patch: Partial<GroupSettingsDraft>) => void;
}) {
  const { draft, onChange } = props;
  const instructionsSource = props.instructionsSource;
  const autosave = props.instructionsAutosave;
  const [viewingPath, setViewingPath] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);

  const memoryDocuments = props.agent.documents.filter(
    (document) =>
      document.logicalPath.startsWith(MEMORY_DOCUMENT_PREFIX) &&
      document.logicalPath !== MEMORY_AUTO_DOCUMENT_PATH &&
      !document.logicalPath.startsWith(MEMORY_THREAD_DOCUMENT_PREFIX),
  );
  const threadDocuments = props.agent.documents.filter((document) =>
    document.logicalPath.startsWith(MEMORY_THREAD_DOCUMENT_PREFIX),
  );

  const submitNote = () => {
    const note = noteDraft.trim();
    if (note.length === 0 || noteBusy) return;
    setNoteBusy(true);
    setNoteError(null);
    void props.agent
      .writeDocument({
        logicalPath: memoryNoteDocumentPath(note),
        content: `${note}\n`,
      })
      .then(() => {
        setNoteDraft("");
      })
      .catch((cause: unknown) => {
        setNoteError(cause instanceof Error ? cause.message : "Could not save the note.");
      })
      .finally(() => setNoteBusy(false));
  };

  return (
    <div className="space-y-6">
      <SettingsSectionShell title="Group instructions">
        <div className="space-y-1">
          <CharacterCountTextarea
            value={autosave.value}
            onChange={autosave.onChange}
            onFocus={autosave.onFocus}
            onBlur={autosave.onBlur}
            maxChars={GROUP_INSTRUCTIONS_MAX_CHARS}
            helper="Like a CLAUDE.md: instructions and rules you write that every new thread reads and follows."
            placeholder="Instructions every thread in this group follows."
            aria-label="Group instructions"
          />
          {instructionsSource.serverBacked ? (
            <p className="text-[11px] text-muted-foreground">Applies immediately.</p>
          ) : null}
          {instructionsSource.conflict ? (
            <p className="text-[11px] text-destructive" role="alert">
              {instructionsSource.conflict}
            </p>
          ) : null}
        </div>
      </SettingsSectionShell>

      <SettingsSectionShell title="Auto memory">
        <SettingsCard>
          <SettingsRow
            title="Read every thread"
            description="Notes the coordinator writes itself as it works in this group."
            control={
              <Switch
                checked={draft.autoMemoryEnabled}
                onCheckedChange={(checked) => onChange({ autoMemoryEnabled: Boolean(checked) })}
                aria-label="Read every thread"
              />
            }
          />
          <SettingsListRow
            title="MEMORY.md"
            description="The coordinator's running memory for this group."
            actions={
              <Button
                size="xs"
                variant="outline"
                onClick={() => setViewingPath(MEMORY_AUTO_DOCUMENT_PATH)}
              >
                View
              </Button>
            }
          />
        </SettingsCard>
      </SettingsSectionShell>

      <SettingsSectionShell title="Memory files">
        {memoryDocuments.length === 0 ? (
          <SettingsEmptyState layout="status">No memory files yet.</SettingsEmptyState>
        ) : (
          <SettingsCard>
            {memoryDocuments.map((document) => (
              <SettingsListRow
                key={document.logicalPath}
                title={document.logicalPath.slice(MEMORY_DOCUMENT_PREFIX.length)}
                description={formatRelativeTime(document.updatedAt)}
                actions={
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => setViewingPath(document.logicalPath)}
                  >
                    View
                  </Button>
                }
              />
            ))}
          </SettingsCard>
        )}
        {threadDocuments.length > 0 ? (
          <div className="mt-3">
            <EnvironmentCollapsibleSection
              label={`Thread memory (${threadDocuments.length})`}
              defaultOpen={false}
            >
              <SettingsCard>
                {threadDocuments.map((document) => (
                  <SettingsListRow
                    key={document.logicalPath}
                    title={document.logicalPath.slice(MEMORY_THREAD_DOCUMENT_PREFIX.length)}
                    description={formatRelativeTime(document.updatedAt)}
                    actions={
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setViewingPath(document.logicalPath)}
                      >
                        View
                      </Button>
                    }
                  />
                ))}
              </SettingsCard>
            </EnvironmentCollapsibleSection>
          </div>
        ) : null}
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <Input
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submitNote();
                }
              }}
              placeholder="Note that releases go out on Tuesdays"
              aria-label="Add a memory note"
              disabled={!props.configured}
            />
            <IconButton
              type="button"
              label="Save memory note"
              tooltip="Save note"
              disabled={!props.configured || noteDraft.trim().length === 0 || noteBusy}
              onClick={submitNote}
            >
              <ArrowUpIcon className="size-4" />
            </IconButton>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">Notes apply immediately.</p>
          {noteError ? (
            <p className="mt-1 text-[11px] text-destructive" role="alert">
              {noteError}
            </p>
          ) : null}
        </div>
      </SettingsSectionShell>

      <MemoryDocumentDialog
        logicalPath={viewingPath}
        agent={props.agent}
        onClose={() => setViewingPath(null)}
      />
    </div>
  );
}
