// FILE: BotFields.tsx
// Purpose: A bot's working defaults as one control each, shared by New bot (its "Where does it
//          start?" step) and the bot sheet (Edit, the coding team): where it works (every
//          project, or the ones checked), its engine (the task engine also offers "Tasks use
//          the chat engine"), what it does with new work (each choice says what it means), and
//          the folders it keeps to (a labelled field with its hint). The menus are rows: the
//          setting's name, its value, a chevron; a hairline between rows.
// Layer: SynBot editor UI
// Exports: BotFieldRows, ProjectsField, EngineField, AutonomyField, FoldersField

import type { BotAutonomy, ModelSelection, ProjectId } from "@synara/contracts";
import type { ReactNode } from "react";

import { ProjectSidebarIcon } from "~/components/ProjectSidebarIcon";
import { ProviderIcon } from "~/components/ProviderIcon";
import { useTranslation } from "~/i18n";
import { ChevronDownIcon, CircleQuestionIcon, PlayIcon } from "~/lib/icons";

import { Field, TextField } from "../kit/controls";
import { Menu, type MenuEntry } from "../kit/Menu";
import { useEngineMenu } from "../thread/useEngineMenu";
import type { BotEditorForm } from "./botEditor.logic";
import { chooseAllProjects, projectsSummary, toggleBotProject } from "./newBot.logic";
import type { useBotProjects } from "./useBotProjects";
import "./bots.css";

/** The rows of a bot's defaults, a hairline between them. */
export function BotFieldRows({ children }: { readonly children: ReactNode }) {
  return <div className="bot-rows">{children}</div>;
}

/** One setting as a row that opens its menu. */
function MenuRow({
  label,
  value,
  items,
  onOpenChange,
}: {
  readonly label: string;
  readonly value: ReactNode;
  readonly items: readonly MenuEntry[];
  readonly onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Menu
      label={label}
      items={items}
      place="below-end"
      {...(onOpenChange ? { onOpenChange } : {})}
      trigger={
        <button type="button" className="bot-row">
          <span className="bot-row__label">{label}</span>
          <span className="bot-row__value">{value}</span>
          <ChevronDownIcon className="bot-row__chevron size-3.5" />
        </button>
      }
    />
  );
}

/** Where it works: every project, or the ones checked (the menu stays open while checking). */
export function ProjectsField({
  form,
  projects,
  onChange,
}: {
  readonly form: Pick<BotEditorForm, "scopeMode" | "projectIds">;
  readonly projects: ReturnType<typeof useBotProjects>;
  readonly onChange: (patch: Pick<BotEditorForm, "scopeMode" | "projectIds">) => void;
}) {
  const { t } = useTranslation();
  const summary = projectsSummary(form, projects);
  const chosen = new Set<string>(form.projectIds);
  const items: MenuEntry[] =
    projects.length === 0
      ? [
          {
            id: "none",
            label: t("synbotEditor:noProjects"),
            disabled: true,
            onSelect: () => undefined,
          },
        ]
      : [
          {
            id: "all",
            label: t("synbotEditor:allProjects"),
            checked: form.scopeMode === "all",
            onSelect: () => onChange(chooseAllProjects()),
          },
          { rule: true },
          ...projects.map((project) => ({
            id: project.id,
            label: project.name,
            glyph: (
              <ProjectSidebarIcon
                cwd={project.cwd}
                expanded={false}
                appearance={project.appearance}
              />
            ),
            checked: form.scopeMode === "chosen" && chosen.has(project.id),
            keepOpen: true,
            onSelect: () => onChange(toggleBotProject(form, project.id as ProjectId)),
          })),
        ];
  const shown = summary.all ? [] : summary.chosen.slice(0, 2);
  const more = summary.all ? 0 : summary.chosen.length - shown.length;
  return (
    <MenuRow
      label={t("synbotEditor:projects")}
      items={items}
      value={
        <>
          {summary.all ? t("synbotEditor:allProjects") : null}
          {!summary.all && summary.chosen.length === 0 ? (
            <span className="bot-row__placeholder">{t("synbotEditor:chooseProjects")}</span>
          ) : null}
          {shown.map((project) => (
            <span key={project.id} className="bot-row__item">
              <ProjectSidebarIcon
                cwd={project.cwd}
                expanded={false}
                appearance={project.appearance}
              />
              <span className="bot-row__item-name">{project.name}</span>
            </span>
          ))}
          {more > 0 ? <span className="bot-row__more">+{more}</span> : null}
        </>
      }
    />
  );
}

/** An engine and its model. With `sameAs` (the task engine), "Tasks use the chat engine" comes
 * first and is checked while the tasks follow the chat. */
export function EngineField({
  label,
  selection,
  onChange,
  sameAs,
}: {
  readonly label: string;
  readonly selection: ModelSelection;
  readonly onChange: (next: ModelSelection) => void;
  readonly sameAs?: {
    readonly checked: boolean;
    readonly label: string;
    readonly onSelect: () => void;
  };
}) {
  const engine = useEngineMenu({ selection, onChange, withProviderIcons: true });
  const items: MenuEntry[] = sameAs
    ? [
        { id: "same", label: sameAs.label, checked: sameAs.checked, onSelect: sameAs.onSelect },
        { rule: true },
        ...engine.items,
      ]
    : engine.items;
  return (
    <MenuRow
      label={label}
      items={items}
      onOpenChange={engine.setOpen}
      value={
        sameAs?.checked ? (
          <span className="bot-row__item-name">{sameAs.label}</span>
        ) : (
          <span className="bot-row__item">
            <ProviderIcon provider={selection.provider} className="size-4" />
            <span className="bot-row__item-name">{engine.modelName}</span>
          </span>
        )
      }
    />
  );
}

/** What it does when work is handed to it: start on its own, or ask first. */
export function AutonomyField({
  value,
  onChange,
}: {
  readonly value: BotAutonomy;
  readonly onChange: (value: BotAutonomy) => void;
}) {
  const { t } = useTranslation();
  const choices: readonly {
    readonly value: BotAutonomy;
    readonly label: string;
    readonly detail: string;
    readonly glyph: ReactNode;
  }[] = [
    {
      value: "auto",
      label: t("synbotEditor:autonomyAuto"),
      detail: t("synbotEditor:autonomyAutoDetail"),
      glyph: <PlayIcon className="size-3.5" />,
    },
    {
      value: "ask",
      label: t("synbotEditor:autonomyAskShort"),
      detail: t("synbotEditor:autonomyAskDetail"),
      glyph: <CircleQuestionIcon className="size-4" />,
    },
  ];
  const current = choices.find((choice) => choice.value === value);
  return (
    <MenuRow
      label={t("synbotEditor:newWork")}
      items={choices.map((choice) => ({
        id: choice.value,
        label: choice.label,
        detail: choice.detail,
        glyph: choice.glyph,
        checked: value === choice.value,
        onSelect: () => onChange(choice.value),
      }))}
      value={
        <span className="bot-row__item">
          {current?.glyph}
          <span className="bot-row__item-name">{current?.label}</span>
        </span>
      }
    />
  );
}

/** The folders it keeps to inside its projects: comma-separated globs, optional. */
export function FoldersField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <Field title={t("synbotEditor:paths")} hint={t("synbotEditor:pathsDescription")}>
      <TextField
        value={value}
        onChange={onChange}
        placeholder={t("synbotEditor:pathsPlaceholder")}
        aria-label={t("synbotEditor:paths")}
      />
    </Field>
  );
}
