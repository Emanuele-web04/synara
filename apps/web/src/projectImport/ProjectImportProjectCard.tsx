import type { ProjectImportProject } from "@synara/contracts";
import { useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import { Input } from "~/components/ui/input";
import { isElectron } from "~/env";
import { disclosureChevronClassName } from "~/lib/disclosureMotion";
import { ChevronRightIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { IMPORT_PROVIDER_LABELS, projectImportItemKey, selectableProjectImportKeys } from "./logic";

const UI_TEXT =
  "text-[length:var(--app-font-size-ui,12px)] sm:text-[length:var(--app-font-size-ui,12px)]";
const UI_TEXT_SM = "text-[length:var(--app-font-size-ui-sm,11px)]";

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

  const conversationLabel = `${project.threads.length} conversation${project.threads.length === 1 ? "" : "s"}`;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className={UI_TEXT}>
      <div className="flex items-center gap-2.5 px-3 py-2">
        <Checkbox
          aria-label={`Select ${project.title}`}
          checked={availableKeys.length > 0 && selectedCount === availableKeys.length}
          indeterminate={selectedCount > 0 && selectedCount < availableKeys.length}
          disabled={props.disabled || availableKeys.length === 0}
          onCheckedChange={(checked) => props.onSelectionChange(availableKeys, checked)}
        />
        <CollapsibleTrigger
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left"
          aria-label={`Conversations in ${project.title}`}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{project.title}</span>
            <span
              className={cn("block truncate text-muted-foreground", UI_TEXT_SM)}
              title={project.workspaceRoot}
            >
              {project.workspaceRoot}
            </span>
          </span>
          <span className={cn("shrink-0 text-right text-muted-foreground", UI_TEXT_SM)}>
            <span className="block">{conversationLabel}</span>
            {!project.directoryExists ? (
              <span className="block text-warning">Folder unavailable</span>
            ) : (
              <span className="block text-muted-foreground/70">
                {project.existingProjectId ? "Adds to existing" : "New project"}
              </span>
            )}
          </span>
          <span className="flex shrink-0 gap-1">
            {project.providers.map((provider) => (
              <span key={provider} title={IMPORT_PROVIDER_LABELS[provider]}>
                <ProviderIcon provider={provider} className="size-3.5" />
              </span>
            ))}
          </span>
          <ChevronRightIcon className={disclosureChevronClassName(expanded)} aria-hidden />
        </CollapsibleTrigger>
      </div>
      {!project.directoryExists ? (
        <div className="space-y-2 px-3 pb-2.5 ps-[2.375rem]">
          <p className={cn("text-muted-foreground", UI_TEXT_SM)}>
            The folder moved or is missing. Link its new location to continue these conversations,
            or import the history alone.
          </p>
          <div className="flex gap-2">
            <Input
              aria-label={`New folder for ${project.title}`}
              placeholder="Optional: existing folder path"
              value={props.workspaceRoot}
              onChange={(event) => props.onWorkspaceRootChange(event.target.value)}
              disabled={props.disabled}
              className={cn("h-8 rounded-lg", UI_TEXT)}
            />
            {isElectron ? (
              <Button
                variant="outline"
                size="sm"
                className={cn("h-8 rounded-lg font-normal", UI_TEXT)}
                disabled={props.disabled}
                onClick={() => void browse()}
              >
                Browse
              </Button>
            ) : null}
          </div>
          {pickerError ? (
            <p role="alert" className={cn("text-destructive", UI_TEXT_SM)}>
              {pickerError}
            </p>
          ) : null}
        </div>
      ) : null}
      <CollapsiblePanel>
        <div className="bg-foreground/[0.025] px-3 py-1 ps-[2.375rem]">
          {visibleThreads.length === 0 ? (
            <p className={cn("py-1.5 text-muted-foreground", UI_TEXT_SM)}>
              {project.threads.length
                ? "All conversations are archived. Enable archived conversations to select them."
                : "Links the existing folder without adding conversations."}
            </p>
          ) : null}
          {visibleThreads.map((thread) => {
            const key = projectImportItemKey(project.key, thread.key);
            const imported = thread.alreadyImported || props.completedKeys.has(key);
            return (
              <label key={thread.key} className="flex cursor-pointer items-center gap-2.5 py-1.5">
                <Checkbox
                  checked={imported || props.selected.has(key)}
                  disabled={props.disabled || imported}
                  onCheckedChange={(checked) => props.onSelectionChange([key], checked)}
                  aria-label={`Import ${thread.title || "Untitled conversation"}`}
                />
                <ProviderIcon provider={thread.provider} className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate" title={thread.title}>
                  {thread.title || "Untitled conversation"}
                </span>
                <span className={cn("shrink-0 text-muted-foreground", UI_TEXT_SM)}>
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
