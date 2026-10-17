import { controlAccountScope } from "./controlQueryScope";
import type { AutomationFormState } from "../automationForm";
import { randomUUID } from "../utils";

/** Only portable draft fields cross computers; project, thread and provider belong to the owner. */
export type WorkspaceAutomationDraft = Omit<
  AutomationFormState,
  "projectId" | "targetThreadId" | "modelSelection"
>;

let pending: { id: string; scope: string; draft: WorkspaceAutomationDraft | undefined } | undefined;

export function portableAutomationDraft(form: AutomationFormState): WorkspaceAutomationDraft {
  const { projectId: _project, targetThreadId: _thread, modelSelection: _model, ...draft } = form;
  return draft;
}

/** The prompt stays in the owning renderer's memory, never in navigation URLs or storage. */
export function prepareWorkspaceAutomation(draft?: WorkspaceAutomationDraft): string {
  const id = randomUUID();
  pending = { id, draft, scope: controlAccountScope() };
  return `/automations?create=${encodeURIComponent(id)}`;
}

export function readWorkspaceAutomationDraft(id: string | undefined) {
  return pending && pending.id === id && pending.scope === controlAccountScope()
    ? pending.draft
    : undefined;
}

export function clearWorkspaceAutomationDraft(id: string | undefined): void {
  if (pending?.id === id) pending = undefined;
}
