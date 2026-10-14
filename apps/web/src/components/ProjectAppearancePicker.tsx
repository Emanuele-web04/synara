// FILE: ProjectAppearancePicker.tsx
// Purpose: Popover body for choosing a project's emoji, or its icon and color.
// Layer: UI component
// Exports: ProjectAppearancePicker
// Depends on: projectAppearance (icon set, palette) and projectEmoji (bundled emoji).

import { useId, useMemo, useState, type KeyboardEvent, type RefObject } from "react";

import { CentralIcon } from "~/lib/central-icons";
import {
  DEFAULT_PROJECT_ICON,
  PROJECT_COLOR_LABELS,
  PROJECT_COLORS,
  PROJECT_ICON_OPTIONS,
  firstEmoji,
  projectColorValue,
  type ProjectAppearance,
  type ProjectColor,
} from "~/lib/projectAppearance";
import { PROJECT_EMOJI_OPTIONS } from "~/lib/projectEmoji";
import { handleRadioGridKeyDown } from "~/lib/radioGridKeyboard";
import { cn } from "~/lib/utils";
import { FolderIcon } from "~/lib/icons";
import { ProjectEmojiGlyph } from "./ProjectSidebarIcon";
import { Input } from "./ui/input";
import { toggleVariants } from "./ui/toggle";

const PICKER_TABS = ["emoji", "icons"] as const;
type PickerTab = (typeof PICKER_TABS)[number];

const GRID_COLUMNS = 8;

/** One cell of the icon, emoji, and color grids; selection reads as a soft filled square. */
const CELL_CLASS_NAME =
  "flex aspect-square cursor-pointer items-center justify-center rounded-xl outline-hidden transition-colors hover:bg-foreground/6 focus-visible:ring-2 focus-visible:ring-ring/50";
const SELECTED_CELL_CLASS_NAME = "bg-foreground/9 hover:bg-foreground/9";

/** Every query word must start one of the option's words, so "cat" finds the cat, not "education". */
function matchesQuery(query: string, ...fields: string[]): boolean {
  if (query.length === 0) return true;
  const words = fields.join(" ").toLowerCase().split(/\s+/);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((queryWord) => words.some((word) => word.startsWith(queryWord)));
}

export function ProjectAppearancePicker({
  value,
  searchInputRef,
  onChange,
  onEmojiPicked,
}: {
  value: ProjectAppearance | null;
  /** The popover focuses search on open, so typing filters straight away. */
  searchInputRef: RefObject<HTMLInputElement | null>;
  onChange: (next: ProjectAppearance | null) => void;
  /** Called after an emoji is chosen: there is nothing else to pick on that tab. */
  onEmojiPicked: () => void;
}) {
  const [tab, setTab] = useState<PickerTab>(value?.kind === "emoji" ? "emoji" : "icons");
  const [query, setQuery] = useState("");
  // The palette tints the icon grid as a preview. It only lands on the project once an icon
  // is the choice, so trying a color while an emoji is set does not replace the emoji.
  const [color, setColor] = useState<ProjectColor | null>(
    value?.kind === "icon" ? value.color : null,
  );
  const fieldId = useId();
  const trimmedQuery = query.trim();

  const selectedIcon =
    value?.kind === "emoji" ? null : value?.kind === "icon" ? value.icon : DEFAULT_PROJECT_ICON;
  const selectedEmoji = value?.kind === "emoji" ? value.emoji : null;

  const icons = useMemo(
    () =>
      PROJECT_ICON_OPTIONS.filter((option) =>
        matchesQuery(trimmedQuery, option.label, option.keywords),
      ),
    [trimmedQuery],
  );
  const emoji = useMemo(() => {
    const matches = PROJECT_EMOJI_OPTIONS.filter(
      (option) => option.emoji === trimmedQuery || matchesQuery(trimmedQuery, option.keywords),
    ).map((option) => option.emoji);
    // Any emoji typed or pasted into the search is offered too, so the bundled list is a
    // shortcut rather than a limit.
    const typed = firstEmoji(trimmedQuery);
    return typed && !matches.includes(typed) ? [typed, ...matches] : matches;
  }, [trimmedQuery]);

  const selectedIconListed = icons.some((option) => option.name === selectedIcon);
  const selectedEmojiListed = selectedEmoji !== null && emoji.includes(selectedEmoji);

  const selectTab = (next: PickerTab) => {
    setTab(next);
    setQuery("");
  };

  // Tabs follow the WAI-ARIA pattern: one tab stop, arrows move and select, focus stays on
  // the tabs. A click instead jumps to search, since that is where a pointer user goes next.
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = PICKER_TABS.indexOf(tab);
    const nextIndex =
      event.key === "ArrowLeft"
        ? (index - 1 + PICKER_TABS.length) % PICKER_TABS.length
        : event.key === "ArrowRight"
          ? (index + 1) % PICKER_TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? PICKER_TABS.length - 1
              : null;
    const next = nextIndex === null ? undefined : PICKER_TABS[nextIndex];
    if (!next) return;
    event.preventDefault();
    selectTab(next);
    event.currentTarget.querySelector<HTMLElement>(`[data-picker-tab="${next}"]`)?.focus();
  };

  const pickColor = (next: ProjectColor | null) => {
    setColor(next);
    if (value?.kind !== "emoji") {
      onChange({ kind: "icon", icon: selectedIcon ?? DEFAULT_PROJECT_ICON, color: next });
    }
  };

  const tintStyle = color ? { color: projectColorValue(color) } : undefined;

  return (
    <div className="flex w-full flex-col gap-3">
      <div
        role="tablist"
        aria-label="Project icon type"
        onKeyDown={handleTabKeyDown}
        className="flex gap-1"
      >
        {PICKER_TABS.map((option) => {
          const active = tab === option;
          return (
            <button
              key={option}
              type="button"
              role="tab"
              id={`${fieldId}-${option}-tab`}
              aria-selected={active}
              aria-controls={`${fieldId}-panel`}
              data-picker-tab={option}
              data-pressed={active ? "" : undefined}
              tabIndex={active ? 0 : -1}
              onClick={() => {
                selectTab(option);
                searchInputRef.current?.focus();
              }}
              className={cn(
                toggleVariants({ size: "sm" }),
                "rounded-full px-3 font-normal",
                !active && "text-muted-foreground hover:text-foreground",
              )}
            >
              {option === "emoji" ? "Emoji" : "Icons"}
            </button>
          );
        })}
      </div>

      <div
        id={`${fieldId}-panel`}
        role="tabpanel"
        aria-labelledby={`${fieldId}-${tab}-tab`}
        className="flex flex-col gap-3"
      >
        <Input
          ref={searchInputRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={tab === "emoji" ? "Search emoji" : "Search icons"}
          aria-label={tab === "emoji" ? "Search emoji" : "Search icons"}
        />

        {tab === "icons" ? (
          <div
            role="radiogroup"
            aria-label="Color"
            onKeyDown={(event) => handleRadioGridKeyDown(event, "[data-project-color]")}
            className="grid grid-cols-8 gap-1"
          >
            {([null, ...PROJECT_COLORS] as const).map((option) => {
              const selected = color === option;
              return (
                <button
                  key={option ?? "default"}
                  type="button"
                  role="radio"
                  data-project-color
                  aria-checked={selected}
                  aria-label={option ? PROJECT_COLOR_LABELS[option] : "Default color"}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => pickColor(option)}
                  className={cn(
                    CELL_CLASS_NAME,
                    "rounded-full",
                    selected && SELECTED_CELL_CLASS_NAME,
                  )}
                >
                  <span
                    aria-hidden
                    className="size-5 rounded-full bg-muted-foreground/70"
                    style={option ? { backgroundColor: projectColorValue(option) } : undefined}
                  />
                </button>
              );
            })}
          </div>
        ) : null}

        {/* About four rows, with the next one peeking so the scroll is discoverable. Short
            enough that the popover fits below the field instead of covering it. */}
        <div className="-mx-1 max-h-44 overflow-y-auto px-1 pb-0.5">
          {tab === "icons" ? (
            icons.length > 0 ? (
              <div
                role="radiogroup"
                aria-label="Icon"
                onKeyDown={(event) =>
                  handleRadioGridKeyDown(event, "[data-project-icon]", { columns: GRID_COLUMNS })
                }
                className="grid grid-cols-8 gap-1"
              >
                {icons.map((option, index) => {
                  const selected = selectedIcon === option.name;
                  return (
                    <button
                      key={option.name}
                      type="button"
                      role="radio"
                      data-project-icon
                      aria-checked={selected}
                      aria-label={option.label}
                      title={option.label}
                      // Roving tabindex: the grid is one tab stop, entered at the selection.
                      tabIndex={selected || (!selectedIconListed && index === 0) ? 0 : -1}
                      onClick={() => onChange({ kind: "icon", icon: option.name, color })}
                      className={cn(
                        CELL_CLASS_NAME,
                        "text-muted-foreground",
                        selected && SELECTED_CELL_CLASS_NAME,
                      )}
                    >
                      {option.name === DEFAULT_PROJECT_ICON ? (
                        <FolderIcon className="size-5" style={tintStyle} />
                      ) : (
                        <CentralIcon name={option.name} className="size-5" style={tintStyle} />
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="py-6 text-center text-ui-sm text-muted-foreground">
                No icons match “{trimmedQuery}”.
              </p>
            )
          ) : emoji.length > 0 ? (
            <div
              role="radiogroup"
              aria-label="Emoji"
              onKeyDown={(event) =>
                // Arrows only move focus here: choosing an emoji closes the picker, so it
                // waits for Enter, Space, or a click.
                handleRadioGridKeyDown(event, "[data-project-emoji]", {
                  columns: GRID_COLUMNS,
                  selectOnMove: false,
                })
              }
              className="grid grid-cols-8 gap-1"
            >
              {emoji.map((option, index) => {
                const selected = selectedEmoji === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    data-project-emoji
                    aria-checked={selected}
                    aria-label={option}
                    tabIndex={selected || (!selectedEmojiListed && index === 0) ? 0 : -1}
                    onClick={() => {
                      onChange({ kind: "emoji", emoji: option });
                      onEmojiPicked();
                    }}
                    className={cn(CELL_CLASS_NAME, selected && SELECTED_CELL_CLASS_NAME)}
                  >
                    <ProjectEmojiGlyph emoji={option} className="size-6" />
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="py-6 text-center text-ui-sm text-muted-foreground">
              No emoji match. Paste any emoji to use it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
