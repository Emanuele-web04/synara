// FILE: newBot.logic.ts
// Purpose: Pure rules of the New bot steps: which steps show (Computer only when there is more
//          than one computer), what keeps a step's Continue or Create disabled, the projects
//          row's value, and how picking a project changes where the bot starts.
// Layer: Web domain logic (no React, no I/O)
// Exports: NewBotStep, newBotSteps, newBotStepIssue, projectsSummary, toggleBotProject,
//          chooseAllProjects

import type { ProjectId } from "@synara/contracts";

import { botEditorIssue, type BotEditorForm, type BotEditorIssue } from "./botEditor.logic";

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
