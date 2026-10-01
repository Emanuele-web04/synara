import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import type { useSortable } from "@dnd-kit/sortable";
import type { SidebarThreadSortOrder } from "../../appSettings";
import { CentralIcon } from "../../lib/central-icons";
import {
  ArchiveIcon,
  EllipsisIcon,
  GlobeIcon,
  NewThreadIcon,
  PencilIcon,
  PinIcon,
  type LucideIcon,
} from "../../lib/icons";
import { createClientPointMenuAnchor } from "../../lib/clientPointMenuAnchor";
import { pinActionLabel } from "../../lib/pin";
import { DEFAULT_PROJECT_ICON, projectColorValue } from "../../lib/projectAppearance";
import {
  deriveWorkspaceProjectThreadRows,
  workspaceThreadKey,
  type WorkspaceProjectEntry,
  type WorkspaceThreadEntry,
} from "../../lib/hosts/workspaceSidebar";
import {
  readAvailableWorkspaceNavigation,
  readWorkspaceSessions,
  type WorkspaceSession,
} from "../../lib/hosts/workspaceSessions";
import type { WorkspaceSidebarActions } from "../../lib/hosts/workspaceFrame";
import { openWorkspacePath } from "./WorkspacePanels";
import { resolveProjectStatusIndicator } from "../Sidebar.logic";
import { FolderClosed, FolderOpen } from "../FolderClosed";
import { ProjectEmojiGlyph } from "../ProjectSidebarIcon";
import { SidebarIconButton } from "../SidebarIconButton";
import { SidebarProjectRowContent } from "../SidebarProjectRowContent";
import { SidebarSectionToolbar } from "../SidebarSectionToolbar";
import { SidebarStatusTrailingGlyph } from "../SidebarStatusTrailingGlyph";
import { SidebarThreadRowContent } from "../SidebarThreadRowContent";
import { SidebarRowHoverActions } from "../SidebarRowHoverActions";
import {
  createSidebarThreadRowGestures,
  type SidebarThreadRowGestureProps,
} from "../sidebarThreadRowGestures";
import { RenameThreadDialog } from "../RenameThreadDialog";
import { RenameDialog } from "../RenameDialog";
import { Menu, MenuItem, MenuSeparator } from "../ui/menu";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Kbd } from "../ui/kbd";
import {
  SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME,
  SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME,
  SidebarContextMenuIcon,
} from "../sidebarContextMenuStyles";
import {
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import {
  DISCLOSURE_INNER_CLASS,
  disclosureContentClassName,
  disclosureShellClassName,
} from "../../lib/disclosureMotion";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
  sidebarHoverRevealHideClassName,
} from "../../sidebarRowStyles";
import { cn } from "../../lib/utils";

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

type WorkspaceMenuState = { position: { x: number; y: number }; session: WorkspaceSession };

function WorkspaceRowMenu({
  menu,
  onClose,
  items,
}: {
  menu: WorkspaceMenuState | null;
  onClose: () => void;
  items: readonly { label: string; icon: LucideIcon; onClick: () => void; separator?: boolean }[];
}) {
  const anchor = useMemo(() => (menu ? createClientPointMenuAnchor(menu.position) : null), [menu]);
  if (!menu || !anchor) return null;
  const available = Boolean(readAvailableWorkspaceNavigation(menu.session)?.sidebar);
  return (
    <Menu
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <ComposerPickerMenuPopup
        anchor={anchor}
        align="start"
        side="bottom"
        sideOffset={0}
        className={SIDEBAR_CONTEXT_MENU_PANEL_CLASS_NAME}
      >
        {items.map((item) => (
          <span key={item.label}>
            {item.separator ? <MenuSeparator /> : null}
            <MenuItem
              disabled={!available}
              className={SIDEBAR_CONTEXT_MENU_ITEM_CLASS_NAME}
              onClick={() => {
                onClose();
                item.onClick();
              }}
            >
              <SidebarContextMenuIcon icon={item.icon} />
              <span>{item.label}</span>
            </MenuItem>
          </span>
        ))}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

async function runWorkspaceSidebarAction(
  session: WorkspaceSession,
  action: (actions: WorkspaceSidebarActions) => Promise<void> | void,
): Promise<void> {
  try {
    const actions = readAvailableWorkspaceNavigation(session)?.sidebar;
    if (!actions)
      throw new Error("This computer is no longer available. Reconnect before making changes.");
    await action(actions);
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not update workspace",
      description: error instanceof Error ? error.message : "Try again.",
    });
    throw error;
  }
}

function WorkspaceProjectIcon({
  entry,
  expanded,
}: {
  entry: WorkspaceProjectEntry;
  expanded: boolean;
}) {
  const appearance = entry.project.appearance;
  if (appearance?.kind === "emoji")
    return <ProjectEmojiGlyph emoji={appearance.emoji} className="size-4" />;
  const style: CSSProperties | undefined = appearance?.color
    ? { color: projectColorValue(appearance.color) }
    : undefined;
  if (appearance?.kind === "icon" && appearance.icon !== DEFAULT_PROJECT_ICON)
    return <CentralIcon name={appearance.icon} className="size-4" style={style} />;
  const Folder = expanded ? FolderOpen : FolderClosed;
  return <Folder className="size-4" style={style} />;
}

function selectedThreadPath(href: string, environmentId: string, threadId: string): boolean {
  const [pathname, search = ""] = href.split("?");
  if (pathname !== "/remote") return false;
  const params = new URLSearchParams(search);
  return (
    params.get("environment") === environmentId &&
    params.get("path")?.split("?")[0] === `/${threadId}`
  );
}

/** Shared remote gestures, menu and rename dialog for classic and Activity rows. */
export function WorkspaceThreadActions({
  entry,
  children,
}: {
  entry: WorkspaceThreadEntry;
  children: (controls: {
    rowEvents: SidebarThreadRowGestureProps;
    menuButton: ReactNode;
  }) => ReactNode;
}) {
  const { session, thread } = entry;
  const [menu, setMenu] = useState<WorkspaceMenuState | null>(null);
  const [renameSession, setRenameSession] = useState<WorkspaceSession | null>(null);
  if (!session) return null;
  const online = Boolean(readAvailableWorkspaceNavigation(session)?.sidebar);
  const openMenu = (position: { x: number; y: number }) => setMenu({ position, session });
  const actionSession = menu?.session ?? session;
  const runAction = (action: (actions: WorkspaceSidebarActions) => Promise<void> | void) => {
    void runWorkspaceSidebarAction(actionSession, action).catch(() => undefined);
  };
  const rowEvents = createSidebarThreadRowGestures({
    threadId: thread.id,
    onRename: () => {
      if (online) setRenameSession(session);
    },
    onRenamePointerUp: () => undefined,
    onContextMenu: (_threadId, position) => openMenu(position),
  });
  const menuButton = (
    <SidebarIconButton
      icon={EllipsisIcon}
      label={`Chat actions for ${thread.title} on ${session.host.hostName}`}
      disabled={!online}
      className="pointer-events-auto"
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        openMenu({ x: rect.left, y: rect.bottom });
      }}
    />
  );
  return (
    <>
      {children({ rowEvents, menuButton })}
      <WorkspaceRowMenu
        menu={menu}
        onClose={() => setMenu(null)}
        items={[
          {
            label: "Rename chat",
            icon: PencilIcon,
            onClick: () => setRenameSession(actionSession),
          },
          {
            label: pinActionLabel("thread", thread.isPinned === true),
            icon: PinIcon,
            onClick: () =>
              runAction((actions) => actions.setThreadPinned(thread.id, thread.isPinned !== true)),
          },
          ...(!thread.parentThreadId
            ? [
                {
                  label: "Archive",
                  icon: ArchiveIcon,
                  separator: true,
                  onClick: () => {
                    const currentPath =
                      readWorkspaceSessions().find((current) => current.host === actionSession.host)
                        ?.summary?.path ?? "/";
                    openWorkspacePath(actionSession, currentPath);
                    runAction((actions: WorkspaceSidebarActions) =>
                      actions.archiveThread(thread.id),
                    );
                  },
                },
              ]
            : []),
        ]}
      />
      <RenameThreadDialog
        open={renameSession !== null}
        currentTitle={thread.title}
        onOpenChange={(open) => {
          if (!open) setRenameSession(null);
        }}
        onSave={(title) => {
          if (!renameSession) return;
          return runWorkspaceSidebarAction(renameSession, (actions) =>
            actions.renameThread(thread.id, title),
          );
        }}
      />
    </>
  );
}

export function WorkspaceThreadRow({
  entry,
  topLevel: topLevelProp,
  depth: depthProp,
  threadJumpLabel,
}: {
  entry: WorkspaceThreadEntry;
  topLevel?: boolean;
  depth?: number | undefined;
  threadJumpLabel?: string | null;
}) {
  const topLevel = topLevelProp ?? false;
  const depth = depthProp ?? 0;
  const href = useLocation({ select: (location) => location.href });
  const { session, thread } = entry;
  if (!session) return null;
  const environmentId = session.host.executionScope.environmentId;
  const active = selectedThreadPath(href, environmentId, thread.id);
  const hostName = session.host.hostName;
  const status = thread.status;
  const content = (
    <SidebarThreadRowContent
      thread={thread}
      terminalEntryPoint={thread.terminalEntryPoint ?? false}
      terminalStatus={null}
      terminalCount={0}
      isActive={active}
      variant="standard"
      subagentIndentPx={Math.max(0, Math.min(depth - 1, 3) * 10)}
      relatedThreads={session.summary?.threads}
      pendingStatusColorClass={status?.label === "Pending Approval" ? status.colorClass : null}
      suffix={
        <>
          {topLevel ? (
            <>
              <GlobeIcon className="size-3 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
              <span className="max-w-[40%] shrink-0 truncate text-ui-xs text-muted-foreground">
                {hostName}
              </span>
            </>
          ) : null}
          <span className={sidebarHoverRevealHideClassName("thread-row")}>
            {threadJumpLabel ? (
              <Kbd>{threadJumpLabel}</Kbd>
            ) : status ? (
              <SidebarStatusTrailingGlyph status={status} />
            ) : null}
          </span>
        </>
      }
    />
  );
  const label = `${thread.title}, ${hostName}${status ? `, ${status.label}` : ""}`;
  const open = () => openWorkspacePath(session, `/${thread.id}`);
  return (
    <WorkspaceThreadActions entry={entry}>
      {({ rowEvents, menuButton }) => (
        <div className="group/thread-row relative w-full" {...rowEvents}>
          {topLevel ? (
            <SidebarMenuButton
              size="sm"
              isActive={active}
              aria-label={label}
              className={cn(
                SIDEBAR_HEADER_ROW_CLASS_NAME,
                "gap-1.5 pr-7",
                active ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : SIDEBAR_ROW_HOVER_CLASS_NAME,
              )}
              onClick={open}
            >
              {content}
            </SidebarMenuButton>
          ) : (
            <SidebarMenuSubButton
              render={<button type="button" />}
              size="sm"
              isActive={active}
              aria-label={label}
              className={cn(SIDEBAR_THREAD_ROW_BASE_CLASS_NAME, "pr-7")}
              onClick={open}
            >
              {content}
            </SidebarMenuSubButton>
          )}
          <SidebarRowHoverActions threadId={entry.key}>
            <span className="mr-1.5">{menuButton}</span>
          </SidebarRowHoverActions>
        </div>
      )}
    </WorkspaceThreadActions>
  );
}

export function WorkspaceProjectItem({
  entry,
  expanded,
  onToggle,
  threadSortOrder,
  dragHandleProps,
  manualSorting: manualSortingProp,
  extraPages: extraPagesProp,
  onExtraPagesChange,
  threadJumpLabels,
}: {
  entry: WorkspaceProjectEntry;
  expanded: boolean;
  onToggle: () => void;
  threadSortOrder: SidebarThreadSortOrder;
  dragHandleProps?: SortableProjectHandleProps | null;
  manualSorting?: boolean;
  extraPages?: number;
  onExtraPagesChange?: (pages: number) => void;
  threadJumpLabels?: ReadonlyMap<string, string>;
}) {
  const manualSorting = manualSortingProp ?? false;
  const [localExtraPages, setLocalExtraPages] = useState(0);
  const extraPages = extraPagesProp ?? localExtraPages;
  const setExtraPages = onExtraPagesChange ?? setLocalExtraPages;
  const [menu, setMenu] = useState<WorkspaceMenuState | null>(null);
  const [renameSession, setRenameSession] = useState<WorkspaceSession | null>(null);
  const href = useLocation({ select: (location) => location.href });
  const { project, session } = entry;
  if (!session) return null;
  const hostName = session.host.hostName;
  const environmentId = session.host.executionScope.environmentId;
  const online = Boolean(readAvailableWorkspaceNavigation(session));
  const status = expanded
    ? null
    : resolveProjectStatusIndicator(entry.threads.map((thread) => thread.status));
  const activeThreadId = entry.threads.find((thread) =>
    selectedThreadPath(href, environmentId, thread.id),
  )?.id;
  const { visibleEntries, paging, canShowMore } = deriveWorkspaceProjectThreadRows({
    entry,
    sortOrder: threadSortOrder,
    activeThreadId,
    extraPages,
  });
  const startChat = () => {
    const navigation = readAvailableWorkspaceNavigation(session);
    if (!online || !navigation) return;
    void navigation
      .newChat(project.id)
      .then((path) => {
        openWorkspacePath(session, path);
      })
      .catch((error: unknown) =>
        toastManager.add({
          type: "error",
          title: "Could not create chat",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
  };
  const actionSession = menu?.session ?? session;
  const openMenu = (position: { x: number; y: number }) => setMenu({ position, session });

  return (
    <div className="group/collapsible">
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={manualSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className={cn(
            SIDEBAR_HEADER_ROW_CLASS_NAME,
            SIDEBAR_ROW_HOVER_CLASS_NAME,
            manualSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          )}
          {...(manualSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(manualSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          aria-expanded={expanded}
          aria-label={`${project.name}, ${hostName}${status ? `, ${status.label}` : ""}`}
          title={`${project.cwd}\n${hostName}`}
          onClick={onToggle}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openMenu({ x: event.clientX, y: event.clientY });
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (online) setRenameSession(session);
          }}
        >
          <SidebarProjectRowContent
            icon={
              <span className="relative inline-flex size-4 shrink-0">
                <WorkspaceProjectIcon entry={entry} expanded={expanded} />
                <span className="absolute -right-1 -bottom-0.5 inline-flex rounded-full bg-sidebar">
                  <GlobeIcon className="size-2.5 text-sky-600 dark:text-sky-400" aria-hidden />
                </span>
              </span>
            }
            label={project.name}
            hostName={hostName}
            reserveClassName="group-hover/project-header:pr-12 group-has-[:focus-visible]/project-header:pr-12"
            trailing={
              status ? (
                <span
                  aria-label={`Project status: ${status.label}`}
                  title={status.label}
                  className={cn(
                    "ml-auto flex min-w-[1.625rem] shrink-0 items-center justify-end self-center",
                    sidebarHoverRevealHideClassName("project-header"),
                  )}
                >
                  <SidebarStatusTrailingGlyph status={status} />
                </span>
              ) : null
            }
          />
        </SidebarMenuButton>
        <SidebarSectionToolbar placement="overlay" revealOnHover>
          <SidebarIconButton
            icon={EllipsisIcon}
            label={`Project actions for ${project.name} on ${hostName}`}
            disabled={!online || !session.navigation?.sidebar}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu({ x: rect.left, y: rect.bottom });
            }}
          />
          <SidebarIconButton
            icon={NewThreadIcon}
            label={`New chat in ${project.name} on ${hostName}`}
            disabled={!online}
            onClick={startChat}
          />
        </SidebarSectionToolbar>
      </div>
      <div
        className={cn(disclosureShellClassName(expanded), SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME)}
      >
        <div className={DISCLOSURE_INNER_CLASS}>
          <SidebarMenuSub
            className={cn("mx-0 border-0 px-0", disclosureContentClassName(expanded))}
          >
            {visibleEntries.map(({ row }) => (
              <SidebarMenuSubItem key={row.thread.id}>
                <WorkspaceThreadRow
                  entry={{ key: `${entry.key}:${row.thread.id}`, thread: row.thread, session }}
                  depth={row.depth}
                  threadJumpLabel={
                    threadJumpLabels?.get(workspaceThreadKey(environmentId, row.thread.id)) ?? null
                  }
                />
              </SidebarMenuSubItem>
            ))}
            {canShowMore || paging.canShowLess ? (
              <SidebarMenuSubItem className="w-full">
                <div className="flex w-full items-center gap-1">
                  {canShowMore ? (
                    <SidebarMenuSubButton
                      render={<button type="button" />}
                      size="sm"
                      className="h-7 flex-1 translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-ui text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setExtraPages(paging.effectiveExtraPages + 1)}
                    >
                      <span>Show more</span>
                    </SidebarMenuSubButton>
                  ) : null}
                  {paging.canShowLess ? (
                    <SidebarMenuSubButton
                      render={<button type="button" />}
                      size="sm"
                      className={cn(
                        "h-7 translate-x-0 justify-start rounded-lg text-left text-ui text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground",
                        canShowMore ? "w-auto flex-none px-2" : "flex-1 pr-2 pl-8",
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setExtraPages(Math.max(0, paging.effectiveExtraPages - 1))}
                    >
                      <span>Show less</span>
                    </SidebarMenuSubButton>
                  ) : null}
                </div>
              </SidebarMenuSubItem>
            ) : null}
          </SidebarMenuSub>
        </div>
      </div>
      <WorkspaceRowMenu
        menu={menu}
        onClose={() => setMenu(null)}
        items={[
          {
            label: "Rename project",
            icon: PencilIcon,
            onClick: () => setRenameSession(actionSession),
          },
          {
            label: pinActionLabel("project", project.isPinned === true),
            icon: PinIcon,
            onClick: () => {
              void runWorkspaceSidebarAction(actionSession, (actions) =>
                actions.setProjectPinned(project.id, project.isPinned !== true),
              ).catch(() => undefined);
            },
          },
        ]}
      />
      <RenameDialog
        open={renameSession !== null}
        title="Rename project"
        description="Choose a recognizable name for this checkout."
        initialValue={project.name}
        allowEmpty
        onOpenChange={(open) => {
          if (!open) setRenameSession(null);
        }}
        onSave={(name) => {
          if (!renameSession) return;
          return runWorkspaceSidebarAction(renameSession, (actions) =>
            actions.renameProject(project.id, name),
          );
        }}
      />
    </div>
  );
}
