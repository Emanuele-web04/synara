// FILE: GitCreatePrDialog.tsx
// Purpose: Render the Create PR dialog: branch summary, optional PR title/description,
//          local-changes toggle with diff stats, and create/draft/browser actions.
// Layer: Header action control
// Depends on: GitActionsControl.logic resolvers and the shared git dialog chrome.

import { useEffect, useEffectEvent, useMemo, useState } from "react";
import { DiffStat } from "~/components/ui/diff-stat";
import { getSubmitShortcutKeyShortcuts, SubmitShortcutKbd } from "~/components/ui/kbd";
import {
  type CreatePrBrowserPreparation,
  type GitDialogContext,
  resolveCreatePrBrowserPreparation,
  resolveCreatePrDialogExecution,
  resolveCreatePrDialogView,
} from "./GitActionsControl.logic";
import {
  GIT_DIALOG_FIELD_CLASS,
  GitDialogActionList,
  GitDialogActionRow,
  GitDialogBody,
  GitDialogCheckboxRow,
  GitDialogHeading,
  GitDialogShell,
} from "./GitDialogChrome";
import { CreatePullRequestIcon, ExternalLinkIcon, GitPullRequestDraftIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/i18n";

export interface GitCreatePrDialogSubmission {
  action: "create_pr" | "commit_push_pr";
  draft: boolean;
  includeLocalChanges: boolean;
  title: string | null;
  body: string | null;
  /** Add the "Created with Synara" footer and commit trailer to this action only. */
  attribution: boolean;
}

export interface GitCreatePrDialogBrowserRequest {
  preparation: CreatePrBrowserPreparation;
  includeLocalChanges: boolean;
  /** Applies to the commit the browser flow may create; GitHub authors the PR itself. */
  attribution: boolean;
}

interface GitCreatePrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  context: GitDialogContext;
  /** Attribution checkbox state each time the dialog opens (the app setting). */
  defaultAttribution: boolean;
  onSubmit: (submission: GitCreatePrDialogSubmission) => void;
  onOpenInBrowser: (request: GitCreatePrDialogBrowserRequest) => void;
}

export function GitCreatePrDialog({
  open,
  onOpenChange,
  context,
  defaultAttribution,
  onSubmit,
  onOpenInBrowser,
}: GitCreatePrDialogProps) {
  const { t } = useTranslation();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [includeLocalChanges, setIncludeLocalChanges] = useState(true);
  const [attribution, setAttribution] = useState(defaultAttribution);
  // Seeded only when the dialog opens, so a setting change mid-dialog keeps the user's choice.
  const readDefaultAttribution = useEffectEvent(() => defaultAttribution);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setIncludeLocalChanges(true);
    setAttribution(readDefaultAttribution());
  }, [open]);

  const view = useMemo(() => resolveCreatePrDialogView(context), [context]);
  const execution = useMemo(
    () => resolveCreatePrDialogExecution(context, includeLocalChanges),
    [context, includeLocalChanges],
  );
  const browserPreparation = useMemo(
    () => resolveCreatePrBrowserPreparation(context, includeLocalChanges),
    [context, includeLocalChanges],
  );
  const canCreate = execution.kind === "run_action";
  const canOpenInBrowser = browserPreparation.kind !== "unavailable";
  const unavailableHint = execution.kind === "unavailable" ? execution.hint : null;

  const submit = (draft: boolean) => {
    if (execution.kind !== "run_action") return;
    onSubmit({
      action: execution.action,
      draft,
      includeLocalChanges,
      title: title.trim() || null,
      body: body.trim() || null,
      attribution,
    });
  };

  return (
    <GitDialogShell open={open} onOpenChange={onOpenChange} onSubmitShortcut={() => submit(false)}>
      <GitDialogHeading
        eyebrow={`${view.isNewBranch ? "New branch" : "Branch"} → ${view.baseBranchName}`}
        subject={
          view.willCreateFeatureBranch
            ? "Auto-named feature branch"
            : (view.branchName ?? "(detached HEAD)")
        }
        subjectMuted={view.willCreateFeatureBranch}
      />
      <GitDialogBody>
        <input
          autoFocus
          aria-label={t("git:pullRequestTitle")}
          className={GIT_DIALOG_FIELD_CLASS}
          maxLength={300}
          placeholder={t("git:titleLeaveEmptyToGenerate")}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          aria-label={t("git:pullRequestDescription")}
          className={cn(GIT_DIALOG_FIELD_CLASS, "resize-none")}
          maxLength={60_000}
          placeholder={t("git:descriptionLeaveEmptyToGenerate")}
          rows={2}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
        {view.showCommitToggle && (
          <GitDialogCheckboxRow
            checked={includeLocalChanges}
            onCheckedChange={setIncludeLocalChanges}
            label={t("git:commitAndPushLocalChanges")}
            trailing={
              <DiffStat
                className="shrink-0 font-mono text-ui leading-snug"
                insertions={view.insertions}
                deletions={view.deletions}
              />
            }
          />
        )}
        <GitDialogCheckboxRow
          checked={attribution}
          onCheckedChange={setAttribution}
          label={t("git:addSynaraAttribution")}
        />
        {unavailableHint && (
          <p className="py-1 text-warning text-ui leading-snug">{unavailableHint}</p>
        )}
      </GitDialogBody>
      <GitDialogActionList>
        <GitDialogActionRow
          disabled={!canCreate}
          icon={<GitPullRequestDraftIcon />}
          label={t("git:createDraftPR")}
          onClick={() => submit(true)}
        />
        <GitDialogActionRow
          highlighted
          disabled={!canCreate}
          icon={<CreatePullRequestIcon />}
          label={t("git:createPR")}
          trailing={<SubmitShortcutKbd />}
          aria-keyshortcuts={getSubmitShortcutKeyShortcuts()}
          onClick={() => submit(false)}
        />
        <GitDialogActionRow
          disabled={!canOpenInBrowser}
          icon={<ExternalLinkIcon />}
          label={t("git:openPRInBrowser")}
          onClick={() =>
            onOpenInBrowser({ preparation: browserPreparation, includeLocalChanges, attribution })
          }
        />
      </GitDialogActionList>
    </GitDialogShell>
  );
}
