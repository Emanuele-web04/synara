import type { ProjectImportProject } from "@synara/contracts";
import { useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { isElectron } from "~/env";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import { ChevronRightIcon, FolderIcon } from "~/lib/icons";
import { ensureNativeApi } from "~/nativeApi";
import { IMPORT_PROVIDER_LABELS, projectImportItemKey, selectableProjectImportKeys } from "./logic";

export function ProjectImportProjectCard(props: {
  readonly project: ProjectImportProject;
  readonly selected: ReadonlySet<string>;
  readonly includeArchived: boolean;
  readonly disabled: boolean;
  readonly completedKeys: ReadonlySet<string>;
  readonly workspaceRoot: string;
  readonly onWorkspaceRootChange: (path: string) => void;
  readonly onSelectionChange: (keys: readonly string[], checked: boolean) => void;
  readonly onPickerBusyChange: (busy: boolean) => void;
}) {
  const { project } = props;
  const [expanded, setExpanded] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const availableKeys = selectableProjectImportKeys(project, props.includeArchived).filter(
    (key) => !props.completedKeys.has(key),
  );
  const selectedCount = availableKeys.filter((key) => props.selected.has(key)).length;
  const visibleThreads = project.threads.filter(
    (thread) => props.includeArchived || !thread.archived,
  );
  const browse = async () => {
    props.onPickerBusyChange(true);
    setPickerError(null);
    try {
      const path = await ensureNativeApi().dialogs.pickFolder();
      if (path) props.onWorkspaceRootChange(path);
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : "Could not open the folder picker.");
    } finally {
      props.onPickerBusyChange(false);
    }
  };

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setExpanded}
      className="rounded-xl border border-foreground/10 bg-foreground/2"
    >
      <div className="flex items-center gap-3 px-3 py-3">
        <Checkbox
          aria-label={`Select ${project.title}`}
          checked={availableKeys.length > 0 && selectedCount === availableKeys.length}
          indeterminate={selectedCount > 0 && selectedCount < availableKeys.length}
          disabled={props.disabled || availableKeys.length === 0}
          onCheckedChange={(checked) => props.onSelectionChange(availableKeys, checked)}
        />
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-label={`Conversations in ${project.title}`}
        >
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{project.title}</span>
            <span
              className="block truncate text-xs text-muted-foreground"
              title={project.workspaceRoot}
            >
              {project.workspaceRoot}
            </span>
          </span>
          <span className="flex shrink-0 gap-1.5">
            {project.providers.map((provider) => (
              <span key={provider} title={IMPORT_PROVIDER_LABELS[provider]}>
                <ProviderIcon provider={provider} className="size-3.5" />
              </span>
            ))}
          </span>
          <ChevronRightIcon className={disclosureChevronClassName(expanded)} aria-hidden />
        </CollapsibleTrigger>
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-10 pb-3 text-xs text-muted-foreground">
        <span>{project.existingProjectId ? "Add to existing project" : "New project"}</span>
        <span>
          {project.threads.length} conversation{project.threads.length === 1 ? "" : "s"}
        </span>
        {!project.directoryExists ? <span className="text-warning">Folder unavailable</span> : null}
      </div>
      {!project.directoryExists ? (
        <div className="space-y-2 border-t border-foreground/8 px-3 py-3">
          <p className="text-xs text-muted-foreground">
            Keep the history, or link the folder if it has moved. A working folder is needed to
            continue conversations.
          </p>
          <div className="flex gap-2">
            <Input
              aria-label={`New folder for ${project.title}`}
              placeholder="Optional: existing folder path"
              value={props.workspaceRoot}
              onChange={(event) => props.onWorkspaceRootChange(event.target.value)}
              disabled={props.disabled}
              className="h-8 text-xs"
            />
            {isElectron ? (
              <Button
                variant="outline"
                size="sm"
                disabled={props.disabled}
                onClick={() => void browse()}
              >
                Browse
              </Button>
            ) : null}
          </div>
          {pickerError ? (
            <p role="alert" className="text-xs text-destructive">
              {pickerError}
            </p>
          ) : null}
        </div>
      ) : null}
      <CollapsiblePanel>
        <div className="border-t border-foreground/8 px-3 py-2">
          {visibleThreads.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">
              {project.threads.length
                ? "All conversations are archived. Enable archived conversations to select them."
                : "Links the existing folder without adding conversations."}
            </p>
          ) : null}
          {visibleThreads.map((thread) => {
            const key = projectImportItemKey(project.key, thread.key);
            const imported = thread.alreadyImported || props.completedKeys.has(key);
            return (
              <label
                key={thread.key}
                className="flex cursor-pointer items-center gap-3 rounded-md px-1 py-2 hover:bg-foreground/3"
              >
                <Checkbox
                  checked={imported || props.selected.has(key)}
                  disabled={props.disabled || imported}
                  onCheckedChange={(checked) => props.onSelectionChange([key], checked)}
                  aria-label={`Import ${thread.title || "Untitled conversation"}`}
                />
                <ProviderIcon provider={thread.provider} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-xs" title={thread.title}>
                  {thread.title || "Untitled conversation"}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {imported
                    ? "Already present"
                    : thread.archived
                      ? "Archived"
                      : new Date(thread.updatedAt).toLocaleDateString()}
                </span>
              </label>
            );
          })}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
