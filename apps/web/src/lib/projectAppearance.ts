// FILE: projectAppearance.ts
// Purpose: The local look of a project in the sidebar and rail: a curated Central icon in
//          one of a few palette colors, or an emoji. Also owns parsing of the persisted form.
// Layer: Web lib (pure)
// Exports: ProjectAppearance, PROJECT_ICON_OPTIONS, PROJECT_COLORS, and helpers.

export const PROJECT_COLORS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const;
export type ProjectColor = (typeof PROJECT_COLORS)[number];

export const PROJECT_COLOR_LABELS: Record<ProjectColor, string> = {
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
};

export const PROJECT_COLOR_LABEL_KEYS: Record<ProjectColor, string> = {
  red: "workspace:projectColorRed",
  orange: "workspace:projectColorOrange",
  yellow: "workspace:projectColorYellow",
  green: "workspace:projectColorGreen",
  blue: "workspace:projectColorBlue",
  purple: "workspace:projectColorPurple",
  pink: "workspace:projectColorPink",
};

/** CSS color for a palette entry; the tokens are theme-aware (see `--project-*` in index.css). */
export function projectColorValue(color: ProjectColor): string {
  return `var(--project-${color})`;
}

export interface ProjectIconOption {
  /** Central icon asset name; also the persisted value. */
  readonly name: string;
  readonly label: string;
  readonly labelKey: string;
  /** Extra search words beyond the label. */
  readonly keywords: string;
  readonly keywordsKey: string;
}

/** The default folder, used as a fallback when a project has no detected favicon.
 *  It opens and closes with the project row.
 *  The value is only the persisted key: it renders the shared Hugeicons folder, not a Central asset. */
export const DEFAULT_PROJECT_ICON = "folder-2";

/** Icons in the order the picker offers them. */
export const PROJECT_ICON_OPTIONS: ReadonlyArray<ProjectIconOption> = [
  {
    name: DEFAULT_PROJECT_ICON,
    label: "Folder",
    labelKey: "workspace:folder",
    keywords: "default directory project",
    keywordsKey: "workspace:projectIconFolderKeywords",
  },
  {
    name: "dollar",
    label: "Money",
    labelKey: "workspace:projectIconMoney",
    keywords: "finance dollar budget cash",
    keywordsKey: "workspace:projectIconMoneyKeywords",
  },
  {
    name: "book",
    label: "Book",
    labelKey: "common:book",
    keywords: "reading docs library",
    keywordsKey: "workspace:projectIconBookKeywords",
  },
  {
    name: "graduate-cap",
    label: "Education",
    labelKey: "workspace:projectIconEducation",
    keywords: "school study course learn",
    keywordsKey: "workspace:projectIconEducationKeywords",
  },
  {
    name: "pencil",
    label: "Writing",
    labelKey: "workspace:projectIconWriting",
    keywords: "edit draft blog",
    keywordsKey: "workspace:projectIconWritingKeywords",
  },
  {
    name: "feather",
    label: "Pen",
    labelKey: "workspace:projectIconPen",
    keywords: "writing poetry quill",
    keywordsKey: "workspace:projectIconPenKeywords",
  },
  {
    name: "brackets-2",
    label: "Code",
    labelKey: "common:code",
    keywords: "braces json dev programming",
    keywordsKey: "workspace:projectIconCodeKeywords",
  },
  {
    name: "console",
    label: "Terminal",
    labelKey: "workspace:viewportPane_terminal",
    keywords: "shell cli command",
    keywordsKey: "workspace:projectIconTerminalKeywords",
  },
  {
    name: "audio",
    label: "Music",
    labelKey: "workspace:projectIconMusic",
    keywords: "song sound note",
    keywordsKey: "workspace:projectIconMusicKeywords",
  },
  {
    name: "popcorn",
    label: "Movies",
    labelKey: "workspace:projectIconMovies",
    keywords: "film cinema entertainment",
    keywordsKey: "workspace:projectIconMoviesKeywords",
  },
  {
    name: "ruler",
    label: "Design",
    labelKey: "workspace:projectIconDesign",
    keywords: "layout measure architecture",
    keywordsKey: "workspace:projectIconDesignKeywords",
  },
  {
    name: "color-palette",
    label: "Art",
    labelKey: "workspace:projectIconArt",
    keywords: "paint colors creative",
    keywordsKey: "workspace:projectIconArtKeywords",
  },
  {
    name: "heart-beat",
    label: "Health",
    labelKey: "workspace:projectIconHealth",
    keywords: "medical doctor pulse",
    keywordsKey: "workspace:projectIconHealthKeywords",
  },
  {
    name: "medicine-pill",
    label: "Medicine",
    labelKey: "workspace:projectIconMedicine",
    keywords: "pharmacy pills care",
    keywordsKey: "workspace:projectIconMedicineKeywords",
  },
  {
    name: "form-flower",
    label: "Wellness",
    labelKey: "workspace:projectIconWellness",
    keywords: "calm lotus mindfulness",
    keywordsKey: "workspace:projectIconWellnessKeywords",
  },
  {
    name: "suitcase-work",
    label: "Work",
    labelKey: "common:work",
    keywords: "briefcase job business office",
    keywordsKey: "workspace:projectIconWorkKeywords",
  },
  {
    name: "chart-3",
    label: "Analytics",
    labelKey: "workspace:projectIconAnalytics",
    keywords: "chart stats data metrics",
    keywordsKey: "workspace:projectIconAnalyticsKeywords",
  },
  {
    name: "dumbell",
    label: "Fitness",
    labelKey: "workspace:projectIconFitness",
    keywords: "gym workout sport",
    keywordsKey: "workspace:projectIconFitnessKeywords",
  },
  {
    name: "notebook",
    label: "Notes",
    labelKey: "common:notes",
    keywords: "journal notebook diary",
    keywordsKey: "workspace:projectIconNotesKeywords",
  },
  {
    name: "law",
    label: "Law",
    labelKey: "workspace:projectIconLaw",
    keywords: "legal scale justice balance",
    keywordsKey: "workspace:projectIconLawKeywords",
  },
  {
    name: "globe",
    label: "Globe",
    labelKey: "common:globe",
    keywords: "web internet world",
    keywordsKey: "workspace:projectIconGlobeKeywords",
  },
  {
    name: "airplane",
    label: "Travel",
    labelKey: "workspace:projectIconTravel",
    keywords: "plane trip flight",
    keywordsKey: "workspace:projectIconTravelKeywords",
  },
  {
    name: "earth",
    label: "Earth",
    labelKey: "workspace:projectIconEarth",
    keywords: "planet world climate",
    keywordsKey: "workspace:projectIconEarthKeywords",
  },
  {
    name: "maintenance",
    label: "Tools",
    labelKey: "workspace:projectIconTools",
    keywords: "wrench fix settings repair",
    keywordsKey: "workspace:projectIconToolsKeywords",
  },
  {
    name: "pets",
    label: "Pets",
    labelKey: "workspace:projectIconPets",
    keywords: "paw dog cat animal",
    keywordsKey: "workspace:projectIconPetsKeywords",
  },
  {
    name: "lab",
    label: "Science",
    labelKey: "workspace:projectIconScience",
    keywords: "flask lab research experiment",
    keywordsKey: "workspace:projectIconScienceKeywords",
  },
  {
    name: "brain",
    label: "Brain",
    labelKey: "workspace:projectIconBrain",
    keywords: "mind ai thinking research",
    keywordsKey: "workspace:projectIconBrainKeywords",
  },
  {
    name: "heart",
    label: "Heart",
    labelKey: "common:heart",
    keywords: "love favorite personal",
    keywordsKey: "workspace:projectIconHeartKeywords",
  },
  {
    name: "tree",
    label: "Nature",
    labelKey: "workspace:projectIconNature",
    keywords: "plant garden tree green",
    keywordsKey: "workspace:projectIconNatureKeywords",
  },
  {
    name: "rocket",
    label: "Launch",
    labelKey: "workspace:projectIconLaunch",
    keywords: "rocket startup ship",
    keywordsKey: "workspace:projectIconLaunchKeywords",
  },
  {
    name: "light-bulb",
    label: "Idea",
    labelKey: "common:idea",
    keywords: "lightbulb ideas brainstorm",
    keywordsKey: "workspace:projectIconIdeaKeywords",
  },
  {
    name: "star",
    label: "Star",
    labelKey: "common:star",
    keywords: "favorite important",
    keywordsKey: "workspace:projectIconStarKeywords",
  },
  {
    name: "camera-1",
    label: "Photo",
    labelKey: "workspace:projectIconPhoto",
    keywords: "camera pictures photography",
    keywordsKey: "workspace:projectIconPhotoKeywords",
  },
  {
    name: "gamecontroller",
    label: "Games",
    labelKey: "common:games",
    keywords: "gaming play controller",
    keywordsKey: "workspace:projectIconGamesKeywords",
  },
  {
    name: "home",
    label: "Home",
    labelKey: "workspace:projectIconHome",
    keywords: "house personal family",
    keywordsKey: "workspace:projectIconHomeKeywords",
  },
  {
    name: "people",
    label: "People",
    labelKey: "workspace:projectIconPeople",
    keywords: "team user community",
    keywordsKey: "workspace:projectIconPeopleKeywords",
  },
  {
    name: "robot",
    label: "Bot",
    labelKey: "workspace:projectIconBot",
    keywords: "robot ai agent automation",
    keywordsKey: "workspace:projectIconBotKeywords",
  },
  {
    name: "cup-hot",
    label: "Coffee",
    labelKey: "workspace:projectIconCoffee",
    keywords: "tea break drink",
    keywordsKey: "workspace:projectIconCoffeeKeywords",
  },
  {
    name: "shopping-bag-1",
    label: "Shopping",
    labelKey: "workspace:projectIconShopping",
    keywords: "store shop ecommerce",
    keywordsKey: "workspace:projectIconShoppingKeywords",
  },
  {
    name: "bug",
    label: "Bugs",
    labelKey: "workspace:projectIconBugs",
    keywords: "debug issue qa",
    keywordsKey: "workspace:projectIconBugsKeywords",
  },
  {
    name: "server",
    label: "Server",
    labelKey: "workspace:projectIconServer",
    keywords: "backend infra database hosting",
    keywordsKey: "workspace:projectIconServerKeywords",
  },
  {
    name: "puzzle",
    label: "Puzzle",
    labelKey: "workspace:projectIconPuzzle",
    keywords: "plugin extension piece",
    keywordsKey: "workspace:projectIconPuzzleKeywords",
  },
  {
    name: "trophy",
    label: "Trophy",
    labelKey: "workspace:projectIconTrophy",
    keywords: "win award goal",
    keywordsKey: "workspace:projectIconTrophyKeywords",
  },
  {
    name: "target",
    label: "Goal",
    labelKey: "chat:goal",
    keywords: "target focus objective",
    keywordsKey: "workspace:projectIconGoalKeywords",
  },
  {
    name: "map-pin",
    label: "Place",
    labelKey: "workspace:projectIconPlace",
    keywords: "location map local",
    keywordsKey: "workspace:projectIconPlaceKeywords",
  },
  {
    name: "chat-bubbles",
    label: "Chat",
    labelKey: "workspace:editor_chatLabel",
    keywords: "messages conversation support",
    keywordsKey: "workspace:projectIconChatKeywords",
  },
  {
    name: "calendar-1",
    label: "Calendar",
    labelKey: "workspace:projectIconCalendar",
    keywords: "schedule date plan events",
    keywordsKey: "workspace:projectIconCalendarKeywords",
  },
  {
    name: "lightning",
    label: "Speed",
    labelKey: "chat:traitsPicker_speed",
    keywords: "fast bolt power energy",
    keywordsKey: "workspace:projectIconSpeedKeywords",
  },
];

const PROJECT_ICON_NAMES = new Set(PROJECT_ICON_OPTIONS.map((option) => option.name));

export type ProjectAppearance =
  | { readonly kind: "icon"; readonly icon: string; readonly color: ProjectColor | null }
  | { readonly kind: "emoji"; readonly emoji: string };

// Keycaps (1️⃣, #️⃣) carry no pictographic code point, only the combining keycap U+20E3.
const EMOJI_PATTERN = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{20E3}/u;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The first emoji in `value`, as one grapheme (keeps skin tones, flags, and ZWJ sequences). */
export function firstEmoji(value: string): string | null {
  for (const { segment } of graphemeSegmenter.segment(value)) {
    if (EMOJI_PATTERN.test(segment)) return segment;
  }
  return null;
}

/**
 * The stored form of an appearance: `null` for the default folder in the default tone, so a
 * project that was reset leaves nothing behind in storage.
 */
export function normalizeProjectAppearance(
  appearance: ProjectAppearance | null,
): ProjectAppearance | null {
  if (!appearance) return null;
  if (appearance.kind === "icon") {
    return appearance.icon === DEFAULT_PROJECT_ICON && appearance.color === null
      ? null
      : appearance;
  }
  return appearance;
}

export function projectAppearanceEquals(
  left: ProjectAppearance | null,
  right: ProjectAppearance | null,
): boolean {
  return projectAppearanceKey(left) === projectAppearanceKey(right);
}

/** Stable string identity, for caches keyed by what a glyph looks like. */
export function projectAppearanceKey(appearance: ProjectAppearance | null): string {
  if (!appearance) return "default";
  return appearance.kind === "icon"
    ? `icon:${appearance.icon}:${appearance.color ?? ""}`
    : `emoji:${appearance.emoji}`;
}

/** Validates a persisted appearance; anything unknown or malformed falls back to the default. */
export function parseProjectAppearance(value: unknown): ProjectAppearance | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "icon" && typeof record.icon === "string") {
    if (!PROJECT_ICON_NAMES.has(record.icon)) return null;
    const color = PROJECT_COLORS.find((candidate) => candidate === record.color) ?? null;
    return normalizeProjectAppearance({ kind: "icon", icon: record.icon, color });
  }
  if (record.kind === "emoji" && typeof record.emoji === "string") {
    const emoji = firstEmoji(record.emoji);
    return emoji === record.emoji ? { kind: "emoji", emoji } : null;
  }
  return null;
}
