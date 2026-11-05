// FILE: BotTemplatePicker.tsx
// Purpose: The first row of a new bot's sheet: start from a role (Frontend, Backend, QA, Docs,
//          iOS), make the missing coding crew at once, or start blank. Templates a bot already
//          uses are left out.
// Layer: SynBot editor UI
// Exports: BotTemplatePicker, BotTemplateChoice

import type { BotMascot as BotMascotLook } from "@synara/contracts";
import type { BotTemplate } from "@synara/shared/bots";
import type { ReactNode } from "react";

import { useTranslation } from "~/i18n";
import { AddPlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

import { BotMascot } from "../BotMascot";

/** A template name, "crew", or "blank". */
export type BotTemplateChoice = string;

function TemplateTile(props: {
  readonly selected: boolean;
  readonly face: ReactNode;
  readonly title: string;
  readonly detail: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={props.selected}
      className={cn(
        "flex min-w-0 items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition-colors motion-reduce:transition-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        props.selected
          ? "border-foreground/40 bg-[var(--color-background-elevated-secondary)]"
          : "border-[color:var(--color-border-light)] hover:bg-[var(--color-background-elevated-secondary)]",
      )}
      onClick={props.onClick}
    >
      <span className="flex shrink-0 items-center">{props.face}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-ui font-medium text-foreground">{props.title}</span>
        <span className="truncate text-ui-sm text-muted-foreground">{props.detail}</span>
      </span>
    </button>
  );
}

export function BotTemplatePicker(props: {
  readonly templates: readonly BotTemplate[];
  /** The crew members that do not exist yet; the Crew tile hides when fewer than two. */
  readonly crew: readonly BotTemplate[];
  readonly selected: BotTemplateChoice | null;
  readonly blankMascot: BotMascotLook;
  readonly onPickTemplate: (template: BotTemplate) => void;
  readonly onPickCrew: () => void;
  readonly onPickBlank: () => void;
}) {
  const { t, formatLocale } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("synbotEditor:startFrom")}
      className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-3"
    >
      {props.templates.map((template) => (
        <TemplateTile
          key={template.name}
          selected={props.selected === template.name}
          face={<BotMascot mascot={template.mascot} size="row" still />}
          title={template.name}
          detail={template.role}
          onClick={() => props.onPickTemplate(template)}
        />
      ))}
      {props.crew.length > 1 ? (
        <TemplateTile
          selected={props.selected === "crew"}
          face={
            <span className="flex -space-x-2">
              {props.crew.map((template) => (
                <BotMascot key={template.name} mascot={template.mascot} size="card" still />
              ))}
            </span>
          }
          title={t("synbotEditor:crew")}
          detail={new Intl.ListFormat(formatLocale).format(
            props.crew.map((template) => template.name),
          )}
          onClick={props.onPickCrew}
        />
      ) : null}
      <TemplateTile
        selected={props.selected === "blank"}
        face={
          <span className="relative flex size-7 items-center justify-center">
            <BotMascot mascot={props.blankMascot} size="row" still className="opacity-40" />
            <AddPlusIcon aria-hidden className="absolute size-3.5 text-foreground" />
          </span>
        }
        title={t("synbotEditor:blank")}
        detail={t("synbotEditor:blankDetail")}
        onClick={props.onPickBlank}
      />
    </div>
  );
}
