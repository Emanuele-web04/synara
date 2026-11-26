// FILE: SpaceIcon.tsx
// Purpose: Renders built-in and custom Space icons through Synara's Central asset renderer.

import { SPACE_ICON_NAMES, type SpaceIconName } from "@synara/contracts";

import { CentralIcon } from "~/lib/central-icons";
import { DEFAULT_VOID_SPACE_ICON, type VoidSpaceIconName } from "~/lib/spaceGrouping";
import { cn } from "~/lib/utils";

export type SpaceIconValue = VoidSpaceIconName;

/**
 * Spoken names for the curated icon set. The asset basenames leak numbering and
 * compound words ("chart-2", "camera-1", "gamecontroller") that read badly to a
 * screen reader and in the picker, so every icon gets a human label here.
 */
const SPACE_ICON_LABELS: Record<SpaceIconName, string> = {
  bag: "Bag",
  home: "Home",
  "code-brackets": "Code",
  rocket: "Rocket",
  "light-bulb": "Idea",
  "color-palette": "Palette",
  book: "Book",
  lab: "Lab",
  heart: "Heart",
  star: "Star",
  globe: "Globe",
  cloud: "Cloud",
  hammer: "Hammer",
  "chart-2": "Chart",
  gamecontroller: "Games",
  "camera-1": "Camera",
  target: "Target",
  tree: "Tree",
  school: "School",
  backpack: "Backpack",
};

export const SPACE_ICON_LABEL_KEYS: Record<SpaceIconValue, string> = {
  bag: "common:bag",
  home: "common:home",
  "code-brackets": "common:code",
  rocket: "common:rocket",
  "light-bulb": "common:idea",
  "color-palette": "common:palette",
  book: "common:book",
  lab: "common:lab",
  heart: "common:heart",
  star: "common:star",
  globe: "common:globe",
  cloud: "common:cloud",
  hammer: "common:hammer",
  "chart-2": "common:chart",
  gamecontroller: "common:games",
  "camera-1": "common:camera",
  target: "common:target",
  tree: "common:tree",
  school: "common:school",
  backpack: "common:backpack",
  [DEFAULT_VOID_SPACE_ICON]: "common:blackHole",
};

export interface SpaceIconOption {
  readonly name: SpaceIconValue;
  readonly label: string;
}

/** Icon options in the order the picker offers them. */
export const SPACE_ICON_OPTIONS: ReadonlyArray<SpaceIconOption> = SPACE_ICON_NAMES.map((name) => ({
  name,
  label: SPACE_ICON_LABELS[name],
}));

/**
 * Void's own glyph, offered only when editing Void: it is the one icon that means "nothing
 * is filed here", so a stored Space wearing it would be lying about itself.
 */
export const VOID_SPACE_ICON_OPTIONS: ReadonlyArray<SpaceIconOption> = [
  { name: DEFAULT_VOID_SPACE_ICON, label: "Black hole" },
  ...SPACE_ICON_OPTIONS,
];

export function SpaceIcon(props: {
  icon: SpaceIconValue;
  className?: string | undefined;
  label?: string;
}) {
  return (
    <CentralIcon name={props.icon} label={props.label} className={cn("size-4", props.className)} />
  );
}
