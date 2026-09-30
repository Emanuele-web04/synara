// FILE: ProjectMenuPicker.tsx
// Purpose: Shared searchable project picker, grouped by the active and other Spaces. Picks one
//          project by default; the multiple mode picks a set (empty meaning every project) for
//          filters such as the GitHub inbox's.

import type { ProjectId, SpaceId } from "@synara/contracts";
import { Fragment, type ReactElement, type ReactNode, useMemo, useState } from "react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { PickerPanelShell } from "~/components/chat/PickerPanelShell";
import {
  Menu,
  MenuCheckboxItem,
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
import { useVoidSpace } from "~/voidSpaceStore";
import { ProjectSidebarIcon } from "./ProjectSidebarIcon";
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

/** One project, or (multiple) a set of projects where the empty set means every project. */
export type ProjectMenuPickerSelection =
  | {
      readonly selectionMode?: "single";
      readonly selectedProjectId: ProjectId | null;
      readonly onProjectIdChange: (projectId: ProjectId) => void;
    }
  | {
      readonly selectionMode: "multiple";
      readonly selectedProjectIds: ReadonlyArray<ProjectId>;
      readonly onSelectedProjectIdsChange: (projectIds: ProjectId[]) => void;
    };

export function ProjectMenuPicker(
  props: ProjectMenuPickerSelection & {
    projectOptions: ReadonlyArray<ProjectMenuPickerOption>;
    /** Rendered through MenuTrigger's `render` slot so each surface owns its trigger chrome. */
    trigger: ReactElement;
    /** Content merged into the trigger element (label, chevron, …). */
    children?: ReactNode;
    align?: "start" | "center" | "end";
    popupClassName?: string;
    /** Lead each option with the project's own glyph, as the sidebar shows it. */
    showProjectIcons?: boolean;
    /** A small non-interactive title above the search, naming what the picker chooses. */
    heading?: string;
  },
) {
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
        {open && props.heading ? (
          <MenuGroup>
            <MenuGroupLabel>{props.heading}</MenuGroupLabel>
          </MenuGroup>
        ) : null}
        {open ? <ProjectMenuPickerList {...props} /> : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

function ProjectMenuPickerList(
  props: ProjectMenuPickerSelection & {
    projectOptions: ReadonlyArray<ProjectMenuPickerOption>;
    showProjectIcons?: boolean;
  },
) {
  const [query, setQuery] = useState("");
  const projects = useStore((state) => state.projects);
  const spaces = useStore((state) => state.spaces);
  const storedActiveSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  const activeSpaceId = resolveActiveSpaceId(storedActiveSpaceId, spaces);
  const voidSpace = useVoidSpace();
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );

  const groupedOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
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
          resolvedSpaceName:
            option.spaceName ?? spaceDisplayName(resolvedSpaceId, spaces, voidSpace),
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
      voidSpace,
    });
  }, [activeSpaceId, projectById, props.projectOptions, query, spaces, voidSpace]);

  const renderOptionLabel = (option: ResolvedProjectOption) => {
    const project = props.showProjectIcons ? projectById.get(option.id) : undefined;
    return (
      <span className="flex min-w-0 items-center gap-2">
        {project ? (
          <span className="relative flex size-3.5 shrink-0 items-center justify-center">
            <ProjectSidebarIcon
              cwd={project.cwd}
              expanded={false}
              appearance={project.appearance}
              glyphClassName="size-3.5"
            />
          </span>
        ) : null}
        <span className="min-w-0 truncate">{option.name}</span>
      </span>
    );
  };

  const renderGroups = (renderOption: (option: ResolvedProjectOption) => ReactNode) =>
    groupedOptions.map((group, index) => (
      <Fragment key={group.key}>
        {index > 0 ? <MenuSeparator /> : null}
        <MenuGroup>
          <MenuGroupLabel className="flex items-center gap-1.5">
            <SpaceIcon icon={group.icon} className="size-3 shrink-0" />
            <span className="min-w-0 truncate">{group.label}</span>
          </MenuGroupLabel>
          {group.items.map(renderOption)}
        </MenuGroup>
      </Fragment>
    ));

  const renderList = () => {
    if (props.selectionMode === "multiple") {
      const selected = new Set(props.selectedProjectIds);
      const { onSelectedProjectIdsChange } = props;
      return (
        <>
          <MenuCheckboxItem
            checked={selected.size === 0}
            onCheckedChange={() => onSelectedProjectIdsChange([])}
          >
            All projects
          </MenuCheckboxItem>
          {groupedOptions.length > 0 ? <MenuSeparator /> : null}
          {renderGroups((option) => (
            <MenuCheckboxItem
              key={option.id}
              checked={selected.has(option.id)}
              onCheckedChange={(checked) =>
                onSelectedProjectIdsChange(
                  checked
                    ? [...props.selectedProjectIds, option.id]
                    : props.selectedProjectIds.filter((projectId) => projectId !== option.id),
                )
              }
            >
              {renderOptionLabel(option)}
            </MenuCheckboxItem>
          ))}
        </>
      );
    }
    const { selectedProjectId, onProjectIdChange } = props;
    return (
      <MenuRadioGroup
        value={selectedProjectId ?? ""}
        onValueChange={(value) => {
          if (value === selectedProjectId) return;
          const option = props.projectOptions.find((candidate) => candidate.id === value);
          if (option) onProjectIdChange(option.id);
        }}
      >
        {renderGroups((option) => (
          <MenuRadioItem key={option.id} value={option.id}>
            {renderOptionLabel(option)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    );
  };

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
      {/* The multiple mode keeps its "All projects" row even when the search matches nothing. */}
      {groupedOptions.length > 0 || props.selectionMode === "multiple" ? renderList() : null}
      {groupedOptions.length === 0 ? (
        <p className="px-3 py-6 text-center text-ui-sm text-muted-foreground/60">
          {props.projectOptions.length === 0 ? "No projects yet" : "No matching projects"}
        </p>
      ) : null}
    </PickerPanelShell>
  );
}
