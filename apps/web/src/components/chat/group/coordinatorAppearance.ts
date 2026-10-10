// FILE: coordinatorAppearance.ts
// Purpose: Fixed icon and color sets for the group coordinator identity, plus the
//          resolver that maps stored config keys to a renderable icon + classes.
//          Unknown or cleared keys fall back to today's bot glyph and inherited
//          text color so old/partial configs always render.
// Layer: Web logic

import {
  BookIcon,
  BotIcon,
  BrainIcon,
  BugIcon,
  FastModeIcon,
  FlagIcon,
  FlaskConicalIcon,
  GiftIcon,
  GlobeIcon,
  GoalIcon,
  LightbulbIcon,
  PluginIcon,
  SkillCubeIcon,
  StarIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from "~/lib/icons";

export interface CoordinatorIconOption {
  readonly key: string;
  readonly label: string;
  readonly Icon: LucideIcon;
}

export interface CoordinatorColorOption {
  readonly key: string;
  readonly label: string;
  // Text color applied to the coordinator glyph; "" keeps the inherited row color.
  readonly iconClassName: string;
  // Fill used for the settings-dialog swatch button.
  readonly swatchClassName: string;
}

export const COORDINATOR_ICON_OPTIONS: ReadonlyArray<CoordinatorIconOption> = [
  { key: "bot", label: "Bot", Icon: BotIcon },
  { key: "brain", label: "Brain", Icon: BrainIcon },
  { key: "lightbulb", label: "Lightbulb", Icon: LightbulbIcon },
  { key: "flask", label: "Flask", Icon: FlaskConicalIcon },
  { key: "target", label: "Target", Icon: GoalIcon },
  { key: "agents", label: "Agents", Icon: WorkflowIcon },
  { key: "zap", label: "Zap", Icon: ZapIcon },
  { key: "fast", label: "Fast mode", Icon: FastModeIcon },
  { key: "star", label: "Star", Icon: StarIcon },
  { key: "globe", label: "Globe", Icon: GlobeIcon },
  { key: "puzzle", label: "Puzzle", Icon: PluginIcon },
  { key: "blocks", label: "Blocks", Icon: SkillCubeIcon },
  { key: "gift", label: "Gift", Icon: GiftIcon },
  { key: "book", label: "Book", Icon: BookIcon },
  { key: "bug", label: "Bug", Icon: BugIcon },
  { key: "flag", label: "Flag", Icon: FlagIcon },
];

// Mid-tone palette colors read against both light and dark surfaces without
// per-theme variants; "default" intentionally carries no color class.
export const COORDINATOR_COLOR_OPTIONS: ReadonlyArray<CoordinatorColorOption> = [
  {
    key: "default",
    label: "Default",
    iconClassName: "",
    swatchClassName: "bg-muted-foreground/60",
  },
  { key: "blue", label: "Blue", iconClassName: "text-blue-500", swatchClassName: "bg-blue-500" },
  {
    key: "violet",
    label: "Violet",
    iconClassName: "text-violet-500",
    swatchClassName: "bg-violet-500",
  },
  {
    key: "green",
    label: "Green",
    iconClassName: "text-emerald-500",
    swatchClassName: "bg-emerald-500",
  },
  {
    key: "amber",
    label: "Amber",
    iconClassName: "text-amber-500",
    swatchClassName: "bg-amber-500",
  },
  { key: "rose", label: "Rose", iconClassName: "text-rose-500", swatchClassName: "bg-rose-500" },
  { key: "cyan", label: "Cyan", iconClassName: "text-cyan-500", swatchClassName: "bg-cyan-500" },
  {
    key: "orange",
    label: "Orange",
    iconClassName: "text-orange-500",
    swatchClassName: "bg-orange-500",
  },
];

export const DEFAULT_COORDINATOR_ICON_KEY = "bot";
export const DEFAULT_COORDINATOR_COLOR_KEY = "default";

export interface CoordinatorAppearance {
  readonly Icon: LucideIcon;
  readonly iconClassName: string;
  readonly iconKey: string;
  readonly colorKey: string;
}

export function resolveCoordinatorAppearance(input: {
  readonly coordinatorIcon?: string | null | undefined;
  readonly coordinatorColor?: string | null | undefined;
}): CoordinatorAppearance {
  const iconOption = COORDINATOR_ICON_OPTIONS.find(
    (option) => option.key === input.coordinatorIcon,
  );
  const colorOption = COORDINATOR_COLOR_OPTIONS.find(
    (option) => option.key === input.coordinatorColor,
  );
  return {
    Icon: iconOption?.Icon ?? BotIcon,
    iconClassName: colorOption?.iconClassName ?? "",
    iconKey: iconOption?.key ?? DEFAULT_COORDINATOR_ICON_KEY,
    colorKey: colorOption?.key ?? DEFAULT_COORDINATOR_COLOR_KEY,
  };
}
