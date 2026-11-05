// FILE: botEditor.logic.ts
// Purpose: Pure rules of the bot editor: the form a bot, a template or a blank bot starts from,
//          validation, the `bots.create` input, the minimal `bots.update` input, the crew, the
//          rebase after a conflict, and error classification.
// Layer: Web domain logic (no React, no I/O)
// Exports: BotEditorForm, BOT_EDITOR_CREW_TEMPLATE, botEditorFormFromBot, blankBotEditorForm,
//          applyBotTemplate, findBotTemplate, availableBotTemplates, missingCrewTemplates,
//          botScopeFromForm, botEditorIssue, botCreateInput, crewCreateInputs, botUpdateInput,
//          rebaseBotEditorForm, isBotConflictError, errorMessageOf

import type {
  Bot,
  BotAutonomy,
  BotMascot,
  BotPinnedSkill,
  BotScope,
  BotsCreateInput,
  BotsUpdateInput,
  ModelSelection,
  ProjectId,
} from "@synara/contracts";
import { BOT_SCOPE_PATHS_MAX } from "@synara/contracts";
import { BOT_CREW, BOT_TEMPLATES, mascotForIndex, type BotTemplate } from "@synara/shared/bots";

import { modelSelectionsEqual } from "~/components/chat/group/groupSettingsDialog.logic";

/** `openCreate({ template: "crew" })` opens the editor on the three-bot crew. */
export const BOT_EDITOR_CREW_TEMPLATE = "crew";

export type BotScopeMode = "all" | "chosen";

export interface BotEditorForm {
  readonly name: string;
  readonly role: string;
  readonly mascot: BotMascot;
  readonly instructions: string;
  readonly scopeMode: BotScopeMode;
  /** Kept while "All projects" is on so switching back restores the choice. */
  readonly projectIds: readonly ProjectId[];
  /** Raw path rows as typed; blank rows are dropped on save. */
  readonly paths: readonly string[];
  readonly modelSelection: ModelSelection;
  /** `null`: tasks start on the chat's engine. */
  readonly taskModelSelection: ModelSelection | null;
  readonly autonomy: BotAutonomy;
  readonly pinnedSkills: readonly BotPinnedSkill[];
  readonly pinned: boolean;
}

export function botEditorFormFromBot(bot: Bot): BotEditorForm {
  return {
    name: bot.name,
    role: bot.role,
    mascot: bot.mascot,
    instructions: bot.instructions,
    scopeMode: bot.scope.projects === "all" ? "all" : "chosen",
    projectIds: bot.scope.projects === "all" ? [] : [...bot.scope.projects],
    paths: [...bot.scope.paths],
    modelSelection: bot.modelSelection,
    taskModelSelection: bot.taskModelSelection ?? null,
    autonomy: bot.autonomy,
    pinnedSkills: bot.pinnedSkills.map((skill) => ({ name: skill.name, path: skill.path })),
    pinned: bot.pinned,
  };
}

/** A new bot: no name, every project, the next mascot of the palette, the default engine. */
export function blankBotEditorForm(input: {
  readonly modelSelection: ModelSelection;
  readonly mascotIndex: number;
}): BotEditorForm {
  return {
    name: "",
    role: "",
    mascot: mascotForIndex(input.mascotIndex),
    instructions: "",
    scopeMode: "all",
    projectIds: [],
    paths: [],
    modelSelection: input.modelSelection,
    taskModelSelection: null,
    autonomy: "auto",
    pinnedSkills: [],
    pinned: false,
  };
}

/** A template fills the bot's identity; scope, engine and behavior stay as chosen. */
export function applyBotTemplate(form: BotEditorForm, template: BotTemplate): BotEditorForm {
  return {
    ...form,
    name: template.name,
    role: template.role,
    mascot: template.mascot,
    instructions: template.instructions,
  };
}

const sameName = (left: string, right: string) =>
  left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

export function findBotTemplate(name: string | null | undefined): BotTemplate | null {
  if (!name) return null;
  return BOT_TEMPLATES.find((template) => sameName(template.name, name)) ?? null;
}

/** Templates whose name no bot uses yet. */
export function availableBotTemplates(bots: readonly Pick<Bot, "name">[]): readonly BotTemplate[] {
  return BOT_TEMPLATES.filter((template) => !bots.some((bot) => sameName(bot.name, template.name)));
}

/** The crew members that do not exist yet, in crew order. */
export function missingCrewTemplates(bots: readonly Pick<Bot, "name">[]): readonly BotTemplate[] {
  const available = availableBotTemplates(bots);
  return BOT_CREW.flatMap((name) => available.filter((template) => template.name === name));
}

/** Trimmed, non-empty, unique path globs, at most the contract's limit. */
function normalizedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const trimmed = path.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].slice(0, BOT_SCOPE_PATHS_MAX);
}

export function botScopeFromForm(form: BotEditorForm): BotScope {
  return {
    projects: form.scopeMode === "all" ? "all" : [...new Set(form.projectIds)],
    paths: normalizedPaths(form.paths),
  };
}

export type BotEditorIssue = "name-required" | "projects-required";

/** What blocks saving, or null. Lengths are capped by the fields themselves. */
export function botEditorIssue(form: BotEditorForm): BotEditorIssue | null {
  if (!form.name.trim()) return "name-required";
  if (form.scopeMode === "chosen" && form.projectIds.length === 0) return "projects-required";
  return null;
}

export function botCreateInput(form: BotEditorForm, requestId: string): BotsCreateInput {
  const instructions = form.instructions.trim();
  return {
    requestId,
    name: form.name.trim(),
    role: form.role.trim(),
    mascot: form.mascot,
    ...(instructions ? { instructions } : {}),
    scope: botScopeFromForm(form),
    modelSelection: form.modelSelection,
    ...(form.taskModelSelection ? { taskModelSelection: form.taskModelSelection } : {}),
    autonomy: form.autonomy,
    pinnedSkills: form.pinnedSkills.map((skill) => ({ name: skill.name, path: skill.path })),
    pinned: form.pinned,
  };
}

/**
 * One create input per missing crew member, each from its template on `modelSelection`, every
 * project. Each request id derives from `requestId` so a retry of the same submit dedupes.
 */
export function crewCreateInputs(input: {
  readonly bots: readonly Pick<Bot, "name">[];
  readonly modelSelection: ModelSelection;
  readonly requestId: string;
}): BotsCreateInput[] {
  return missingCrewTemplates(input.bots).map((template, index) =>
    botCreateInput(
      applyBotTemplate(
        blankBotEditorForm({ modelSelection: input.modelSelection, mascotIndex: index }),
        template,
      ),
      `${input.requestId}:${template.name.toLowerCase()}`,
    ),
  );
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

const sameOptionalSelection = (left: ModelSelection | null, right: ModelSelection | null) =>
  left === null || right === null ? left === right : modelSelectionsEqual(left, right);

/**
 * The fields of `form` that differ from `bot`, with `expectedRevision`, or null when nothing
 * changed. SynBot (kind "main") keeps its name, role, scope and shape: only its color changes.
 */
export function botUpdateInput(bot: Bot, form: BotEditorForm): BotsUpdateInput | null {
  const main = bot.kind === "main";
  const base = botEditorFormFromBot(bot);
  const name = form.name.trim();
  const role = form.role.trim();
  const mascot: BotMascot = main
    ? { shape: bot.mascot.shape, color: form.mascot.color }
    : form.mascot;
  const scope = botScopeFromForm(form);
  const change = {
    ...(!main && name !== bot.name ? { name } : {}),
    ...(!main && role !== bot.role ? { role } : {}),
    ...(!sameJson(mascot, bot.mascot) ? { mascot } : {}),
    ...(form.instructions.trim() !== bot.instructions.trim()
      ? { instructions: form.instructions.trim() }
      : {}),
    ...(!main && !sameJson(scope, botScopeFromForm(base)) ? { scope } : {}),
    ...(!modelSelectionsEqual(form.modelSelection, bot.modelSelection)
      ? { modelSelection: form.modelSelection }
      : {}),
    ...(!sameOptionalSelection(form.taskModelSelection, base.taskModelSelection)
      ? { taskModelSelection: form.taskModelSelection }
      : {}),
    ...(form.autonomy !== bot.autonomy ? { autonomy: form.autonomy } : {}),
    ...(!sameJson(form.pinnedSkills, base.pinnedSkills)
      ? { pinnedSkills: form.pinnedSkills.map((skill) => ({ ...skill })) }
      : {}),
    ...(!main && form.pinned !== bot.pinned ? { pinned: form.pinned } : {}),
  } satisfies Omit<BotsUpdateInput, "id" | "expectedRevision">;
  if (Object.keys(change).length === 0) return null;
  return { id: bot.id, expectedRevision: bot.revision, ...change };
}

/**
 * "Reload and retry": a three-way merge onto the bot as it is now. A field the user did not
 * touch (still equal to the form the editor opened with) takes the latest value; an edited
 * field keeps the user's value.
 */
export function rebaseBotEditorForm(
  form: BotEditorForm,
  openedWith: BotEditorForm,
  latest: BotEditorForm,
): BotEditorForm {
  const pick = <Key extends keyof BotEditorForm>(key: Key): BotEditorForm[Key] =>
    sameJson(form[key], openedWith[key]) ? latest[key] : form[key];
  return {
    name: pick("name"),
    role: pick("role"),
    mascot: pick("mascot"),
    instructions: pick("instructions"),
    scopeMode: pick("scopeMode"),
    projectIds: pick("projectIds"),
    paths: pick("paths"),
    modelSelection: pick("modelSelection"),
    taskModelSelection: pick("taskModelSelection"),
    autonomy: pick("autonomy"),
    pinnedSkills: pick("pinnedSkills"),
    pinned: pick("pinned"),
  };
}

/** The server refuses a stale `expectedRevision` with "The bot changed. Reload and retry." */
export function isBotConflictError(message: string): boolean {
  return /bot changed|reload and retry|revision|conflict/i.test(message);
}

export function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
