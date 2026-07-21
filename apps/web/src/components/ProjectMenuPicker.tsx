// FILE: ProjectMenuPicker.tsx
// Purpose: Shared searchable project picker, grouped by the active and other Spaces.

import type { ProjectId, SpaceId } from "@synara/contracts";
import { Fragment, type ReactElement, type ReactNode, useMemo, useState } from "react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { PickerPanelShell } from "~/components/chat/PickerPanelShell";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { groupItemsBySpace, resolveActiveSpaceId, spaceDisplayName } from "~/lib/spaceGrouping";
import { useSpacesUiStore } from "~/spacesUiStore";
import { useStore } from "~/store";
import { SpaceIcon } from "./SpaceIcon";

export interface ProjectMenuPickerOption {
  readonly id: ProjectId;
  readonly name: string;
  readonly spaceId?: SpaceId | null;
  readonly spaceName?: string;
}

interface ResolvedProjectOption extends ProjectMenuPickerOption {
  readonly resolvedSpaceId: SpaceId | null;
  readonly resolvedSpaceName: string;
}

export function ProjectMenuPicker(props: {
  projectOptions: ReadonlyArray<ProjectMenuPickerOption>;
  selectedProjectId: ProjectId | null;
  onProjectIdChange: (projectId: ProjectId) => void;
  /** Rendered through MenuTrigger's `render` slot so each surface owns its trigger chrome. */
  trigger: ReactElement;
  /** Content merged into the trigger element (label, chevron, …). */
  children?: ReactNode;
  align?: "start" | "center" | "end";
  popupClassName?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={props.trigger}>{props.children}</MenuTrigger>
      <ComposerPickerMenuPopup
        align={props.align ?? "start"}
        className={props.popupClassName ?? "min-w-60"}
      >
        {/* The list is its own component so its store subscriptions mount with the popup
            and unmount with it: `projects` churns on every thread update, and a closed
            picker must stay completely inert rather than re-render on each tick. Query
            state lives here too, so closing the menu discards the search for free. */}
        {open ? (
          <ProjectMenuPickerList
            projectOptions={props.projectOptions}
            selectedProjectId={props.selectedProjectId}
            onProjectIdChange={props.onProjectIdChange}
          />
        ) : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function ProjectMenuPickerList(props: {
  projectOptions: ReadonlyArray<ProjectMenuPickerOption>;
  selectedProjectId: ProjectId | null;
  onProjectIdChange: (projectId: ProjectId) => void;
}) {
  const [query, setQuery] = useState("");
  const projects = useStore((state) => state.projects);
  const spaces = useStore((state) => state.spaces);
  const storedActiveSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const activeSpaceId = resolveActiveSpaceId(storedActiveSpaceId, spaces);

  const groupedOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const projectById = new Map(projects.map((project) => [project.id, project] as const));
    // A caller may pass its own space assignment (e.g. an optimistic move); otherwise the
    // project snapshot is the source of truth.
    const resolved: ResolvedProjectOption[] = props.projectOptions
      .map((option) => {
        const resolvedSpaceId =
          option.spaceId !== undefined
            ? option.spaceId
            : (projectById.get(option.id)?.spaceId ?? null);
        return {
          ...option,
          resolvedSpaceId,
          resolvedSpaceName: option.spaceName ?? spaceDisplayName(resolvedSpaceId, spaces),
        };
      })
      .filter(
        (option) =>
          normalizedQuery.length === 0 ||
          option.name.toLocaleLowerCase().includes(normalizedQuery) ||
          option.resolvedSpaceName.toLocaleLowerCase().includes(normalizedQuery),
      );

    return groupItemsBySpace({
      items: resolved,
      spaces,
      activeSpaceId,
      spaceIdOf: (option) => option.resolvedSpaceId,
    });
  }, [activeSpaceId, projects, props.projectOptions, query, spaces]);

  return (
    <PickerPanelShell
      searchPlaceholder="Search projects"
      query={query}
      onQueryChange={setQuery}
      // Lets Arrow/Enter fall through to the menu so the search field and the
      // list behave as one keyboard surface.
      stopSearchKeyPropagation
      autoFocusSearch
      widthClassName="w-full"
      bleedParentPadding
      listMaxHeightClassName="max-h-64"
    >
      {groupedOptions.length > 0 ? (
        <MenuRadioGroup
          value={props.selectedProjectId ?? ""}
          onValueChange={(value) => {
            if (value === props.selectedProjectId) return;
            const option = props.projectOptions.find((candidate) => candidate.id === value);
            if (option) props.onProjectIdChange(option.id);
          }}
        >
          {groupedOptions.map((group, index) => (
            <Fragment key={group.key}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuGroup>
                <MenuGroupLabel className="flex items-center gap-1.5">
                  <SpaceIcon icon={group.icon} className="size-3 shrink-0" />
                  <span className="min-w-0 truncate">{group.label}</span>
                </MenuGroupLabel>
                {group.items.map((option) => (
                  <MenuRadioItem key={option.id} value={option.id}>
                    <span className="min-w-0 truncate">{option.name}</span>
                  </MenuRadioItem>
                ))}
              </MenuGroup>
            </Fragment>
          ))}
        </MenuRadioGroup>
      ) : (
        <p className="px-3 py-6 text-center text-[length:var(--app-font-size-ui-sm,11px)] text-muted-foreground/60">
          {props.projectOptions.length === 0 ? "No projects yet" : "No matching projects"}
        </p>
      )}
    </PickerPanelShell>
  );
}
