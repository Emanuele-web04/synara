// FILE: newBot.logic.ts
// Purpose: Pure rules of the New bot steps: which steps show (Computer only when there is more
//          than one computer), what keeps a step's Continue or Create disabled, the projects
//          row's value, and how picking a project changes where the bot starts.
// Layer: Web domain logic (no React, no I/O)
// Exports: NewBotStep, newBotSteps, newBotStepIssue, projectsSummary, toggleBotProject,
//          chooseAllProjects, newBotEngineProvider

import type { ProjectId, ProviderKind } from "@synara/contracts";

import { compareProvidersByOrder, isProviderKind } from "~/providerOrdering";

import { botEditorIssue, type BotEditorForm, type BotEditorIssue } from "./botEditor.logic";

/**
 * The provider a new bot starts on. The preferred one (the new-chat default) stays while this
 * Synara can run it, or while its status is not known yet. Otherwise it is the first provider in
 * the user's order that is available, not hidden, and has a default model, so Create never
 * defaults to an engine the server refuses. With none, the preferred one stays.
 */
export function newBotEngineProvider(input: {
  readonly preferred: ProviderKind;
  readonly statuses: ReadonlyArray<{
    readonly provider: string;
    readonly driver?: string | undefined;
    readonly available: boolean;
  }>;
  readonly hiddenProviders: ReadonlyArray<string>;
  readonly providerOrder: ReadonlyArray<ProviderKind>;
  readonly hasDefaultModel: (provider: ProviderKind) => boolean;
}): ProviderKind {
  const hidden = new Set(input.hiddenProviders);
  const kindOf = (status: (typeof input.statuses)[number]) => status.driver ?? status.provider;
  const preferred = input.statuses.filter((status) => kindOf(status) === input.preferred);
  if (
    preferred.length === 0 ||
    (!hidden.has(input.preferred) && preferred.some((status) => status.available))
  ) {
    return input.preferred;
  }
  const available = new Set<ProviderKind>();
  for (const status of input.statuses) {
    const kind = kindOf(status);
    if (!isProviderKind(kind) || hidden.has(kind) || !status.available) continue;
    if (input.hasDefaultModel(kind)) available.add(kind);
  }
  return (
    [...available].toSorted((left, right) =>
      compareProvidersByOrder(input.providerOrder, left, right),
    )[0] ?? input.preferred
  );
}

export type NewBotStep = "computer" | "bot" | "start";

/** Computer, Bot, Where it starts; without Computer when there is only this one. */
export function newBotSteps(chooseComputer: boolean): readonly NewBotStep[] {
  return chooseComputer ? ["computer", "bot", "start"] : ["bot", "start"];
}

/** The Bot step needs a name; the last step needs everything a create needs. */
export function newBotStepIssue(step: NewBotStep, form: BotEditorForm): BotEditorIssue | null {
  if (step === "computer") return null;
  const issue = botEditorIssue(form);
  return step === "bot" && issue !== "name-required" ? null : issue;
}

/** The projects row: every project, or the chosen ones in the list's order. */
export function projectsSummary<Project extends { readonly id: string }>(
  form: Pick<BotEditorForm, "scopeMode" | "projectIds">,
  projects: readonly Project[],
): { readonly all: true } | { readonly all: false; readonly chosen: readonly Project[] } {
  if (form.scopeMode === "all") return { all: true };
  const ids = new Set<string>(form.projectIds);
  return { all: false, chosen: projects.filter((project) => ids.has(project.id)) };
}

/** Picking a project while the bot starts in every project starts it in that one only. */
export function toggleBotProject(
  form: Pick<BotEditorForm, "scopeMode" | "projectIds">,
  projectId: ProjectId,
): Pick<BotEditorForm, "scopeMode" | "projectIds"> {
  if (form.scopeMode === "all") return { scopeMode: "chosen", projectIds: [projectId] };
  return {
    scopeMode: "chosen",
    projectIds: form.projectIds.includes(projectId)
      ? form.projectIds.filter((id) => id !== projectId)
      : [...form.projectIds, projectId],
  };
}

/** "All projects" clears the chosen ones: picking a project afterwards starts in that one. */
export function chooseAllProjects(): Pick<BotEditorForm, "scopeMode" | "projectIds"> {
  return { scopeMode: "all", projectIds: [] };
}
