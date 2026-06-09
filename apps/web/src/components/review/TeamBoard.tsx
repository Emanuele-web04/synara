import type {
  ReviewProjectCard,
  ReviewProjectColumn,
  ReviewProjectSummary,
} from "@t3tools/contracts";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import {
  reviewCheckProjectAccessQueryOptions,
  reviewListProjectsQueryOptions,
  reviewMoveProjectCardMutationOptions,
  reviewProjectBoardQueryOptions,
  reviewQueryKeys,
} from "~/lib/reviewReactQuery";
import {
  Columns2Icon,
  CopyIcon,
  GitPullRequestIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  EmptyState,
  ReviewColumn,
  ReviewLoadingRows,
  reviewCardShellClassName,
} from "./reviewPrimitives";

const REFRESH_PROJECT_SCOPE_COMMAND = "gh auth refresh -s project";

function TeamBoardLoadingSkeleton() {
  return (
    <div
      className="flex h-full min-w-0 flex-col gap-3 p-3 md:min-w-max md:flex-row"
      aria-busy="true"
    >
      {["Backlog", "In progress", "Review"].map((label) => (
        <ReviewColumn key={label} label={label} count={0}>
          {[0, 1, 2].map((index) => (
            <li key={index}>
              <div className="flex flex-col gap-1.5 rounded-md border border-border/70 bg-card px-3 py-2">
                <div className="h-3.5 w-3/4 animate-pulse rounded-sm bg-muted" />
                <div className="h-3 w-1/2 animate-pulse rounded-sm bg-muted/70" />
              </div>
            </li>
          ))}
        </ReviewColumn>
      ))}
    </div>
  );
}

function ProjectSelectLoading() {
  return (
    <div
      className="flex h-8 w-64 shrink-0 items-center gap-2 rounded-md border border-border/70 bg-background px-3"
      aria-busy="true"
      aria-label="Loading projects"
    >
      <Skeleton className="h-3 w-28" />
      <Skeleton className="ms-auto size-3 rounded-sm" />
    </div>
  );
}

function ProjectAccessBanner() {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    void navigator.clipboard
      ?.writeText(REFRESH_PROJECT_SCOPE_COMMAND)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };
  return (
    <div className="flex flex-1 items-start justify-center overflow-auto px-6 py-8">
      <Alert variant="warning" className="w-full max-w-lg">
        <TriangleAlertIcon />
        <AlertTitle>GitHub Projects access not granted</AlertTitle>
        <AlertDescription>
          <p className="text-foreground">
            The GitHub CLI token is missing the{" "}
            <span className="font-mono text-foreground">project</span> scope, so the team board
            can&apos;t read your GitHub Project. Run this once in a terminal, then reconnect:
          </p>
          <div className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded-md border border-border/70 bg-muted/40 px-2 py-1 font-mono text-[12px] text-foreground"
              title={REFRESH_PROJECT_SCOPE_COMMAND}
            >
              {REFRESH_PROJECT_SCOPE_COMMAND}
            </code>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="shrink-0"
              aria-label="Copy the gh auth refresh command"
              onClick={handleCopy}
            >
              <CopyIcon />
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </AlertDescription>
      </Alert>
    </div>
  );
}

function ProjectCardContent(props: { card: ReviewProjectCard }) {
  const { card } = props;
  return (
    <>
      <span
        className="min-w-0 truncate font-medium text-[13px] text-foreground leading-snug"
        title={card.title}
      >
        {card.title}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {card.isPullRequest ? <GitPullRequestIcon className="size-3 shrink-0 opacity-70" /> : null}
        {card.number !== null ? <span className="tabular-nums">#{card.number}</span> : null}
        {card.repositoryNameWithOwner ? (
          <span className="truncate font-mono" title={card.repositoryNameWithOwner}>
            {card.repositoryNameWithOwner}
          </span>
        ) : null}
        {card.author.trim().length > 0 ? (
          <span className="text-muted-foreground/70">by {card.author}</span>
        ) : null}
      </div>
    </>
  );
}

function ProjectCard(props: { card: ReviewProjectCard; cwd: string }) {
  const navigate = useNavigate();
  const { card, cwd } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.itemId,
  });

  const reference = card.number !== null ? String(card.number) : null;

  const handleOpen = () => {
    if (!reference) return;
    void navigate({ to: "/review/$reference", params: { reference }, search: { cwd } });
  };

  return (
    // useSortable's `attributes` already supply role="button" + tabIndex, so the card
    // is focusable and keyboard-draggable (via the KeyboardSensor); click opens it.
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      title={card.title}
      onClick={handleOpen}
      className={cn(
        reviewCardShellClassName(),
        "cursor-grab active:cursor-grabbing",
        // The lifted card rides in the DragOverlay (which escapes the column's
        // overflow clip); the source stays put as a faded placeholder.
        isDragging && "opacity-40",
      )}
      {...attributes}
      {...listeners}
    >
      <ProjectCardContent card={card} />
    </div>
  );
}

function BoardColumn(props: {
  column: ReviewProjectColumn;
  cards: readonly ReviewProjectCard[];
  cwd: string;
}) {
  const { column, cards, cwd } = props;
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  return (
    <ReviewColumn
      label={column.name}
      count={cards.length}
      innerRef={setNodeRef}
      isOver={isOver}
      isEmpty={cards.length === 0}
      empty={
        <EmptyState icon={<Columns2Icon />} title="Empty column">
          Drag a card here to set this status.
        </EmptyState>
      }
    >
      <SortableContext
        items={cards.map((card) => card.itemId)}
        strategy={verticalListSortingStrategy}
      >
        {cards.map((card) => (
          <li key={card.itemId}>
            <ProjectCard card={card} cwd={cwd} />
          </li>
        ))}
      </SortableContext>
    </ReviewColumn>
  );
}

const UNASSIGNED_COLUMN_ID = "__unassigned__";

function TeamBoardColumns(props: {
  cwd: string;
  project: ReviewProjectSummary;
  onlyPullRequests: boolean;
}) {
  const { cwd, project, onlyPullRequests } = props;
  const queryClient = useQueryClient();
  const owner = project.ownerLogin;
  const number = project.number;

  const boardQuery = useQuery(reviewProjectBoardQueryOptions({ cwd, owner, number }));
  const moveMutation = useMutation(
    reviewMoveProjectCardMutationOptions({ queryClient, cwd, owner, number }),
  );
  const [activeCard, setActiveCard] = useState<ReviewProjectCard | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const board = boardQuery.data ?? null;
  const grouped = useMemo(() => {
    const groups = new Map<string, ReviewProjectCard[]>();
    if (!board) return groups;
    for (const column of board.columns) {
      groups.set(column.id, []);
    }
    const cards = onlyPullRequests ? board.cards.filter((card) => card.isPullRequest) : board.cards;
    for (const card of cards) {
      const key = card.columnId ?? UNASSIGNED_COLUMN_ID;
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(card);
      } else {
        groups.set(key, [card]);
      }
    }
    return groups;
  }, [board, onlyPullRequests]);
  const unassignedCards = grouped.get(UNASSIGNED_COLUMN_ID) ?? [];

  const handleSync = () => {
    void queryClient.invalidateQueries({
      queryKey: reviewQueryKeys.projectBoard(cwd, owner, number),
    });
  };

  const handleDragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    setActiveCard(board?.cards.find((entry) => entry.itemId === id) ?? null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveCard(null);
    const { active, over } = event;
    if (!board || !over) return;
    const itemId = String(active.id);
    const card = board.cards.find((entry) => entry.itemId === itemId);
    if (!card) return;
    const overId = String(over.id);
    const targetColumn =
      board.columns.find((column) => column.id === overId) ??
      board.columns.find(
        (column) => column.id === (board.cards.find((c) => c.itemId === overId)?.columnId ?? null),
      );
    if (!targetColumn || targetColumn.id === card.columnId) return;
    if (!board.statusFieldId) return;
    moveMutation.mutate({
      cwd,
      projectId: board.project.id,
      itemId,
      fieldId: board.statusFieldId,
      optionId: targetColumn.id,
    });
  };

  if (boardQuery.isLoading) {
    return (
      <ScrollArea className="flex-1">
        <TeamBoardLoadingSkeleton />
      </ScrollArea>
    );
  }
  if (boardQuery.isError) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-destructive">
        {boardQuery.error instanceof Error
          ? boardQuery.error.message
          : "Failed to load the project board."}
      </div>
    );
  }
  if (!board || board.columns.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <EmptyState icon={<Columns2Icon />} title="No status columns">
          This project has no Status field columns to display.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        {moveMutation.isError ? (
          <span
            role="alert"
            className="flex min-w-0 items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/[0.055] px-2 py-1 text-[11px] text-destructive"
          >
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {moveMutation.error instanceof Error ? moveMutation.error.message : "Move failed."}
            </span>
          </span>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ms-auto shrink-0"
          onClick={handleSync}
          disabled={boardQuery.isFetching}
        >
          <RefreshCwIcon className={cn(boardQuery.isFetching && "animate-spin")} />
          Sync
        </Button>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <ScrollArea className="flex-1">
          <div className="flex h-full min-w-0 flex-col gap-3 p-3 md:min-w-max md:flex-row">
            {board.columns.map((column) => (
              <BoardColumn
                key={column.id}
                column={column}
                cards={grouped.get(column.id) ?? []}
                cwd={cwd}
              />
            ))}
            {unassignedCards.length > 0 ? (
              <BoardColumn
                column={{ id: UNASSIGNED_COLUMN_ID, name: "Unassigned" }}
                cards={unassignedCards}
                cwd={cwd}
              />
            ) : null}
          </div>
        </ScrollArea>
        <DragOverlay dropAnimation={{ duration: 150, easing: "cubic-bezier(0.2, 0, 0, 1)" }}>
          {activeCard ? (
            <div className={cn(reviewCardShellClassName({ dragging: true }), "cursor-grabbing")}>
              <ProjectCardContent card={activeCard} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

export function TeamBoard(props: { cwd: string | null }) {
  const { cwd } = props;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [onlyPullRequests, setOnlyPullRequests] = useState(true);

  const accessQuery = useQuery(reviewCheckProjectAccessQueryOptions({ cwd }));
  const hasAccess = accessQuery.data?.hasProjectScope === true;
  const projectsQuery = useQuery({
    ...reviewListProjectsQueryOptions({ cwd }),
    enabled: cwd !== null && hasAccess,
  });

  const projects = projectsQuery.data?.projects ?? [];
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? projects[0] ?? null,
    [projects, selectedProjectId],
  );

  if (cwd === null) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-sm text-muted-foreground">
        Add a project to open the team board.
      </div>
    );
  }

  if (accessQuery.isLoading) {
    return (
      <div className="min-w-0 flex-1 px-3 py-3">
        <ReviewLoadingRows rows={5} className="rounded-md border border-border/60" />
      </div>
    );
  }
  if (accessQuery.isError) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-destructive">
        {accessQuery.error instanceof Error
          ? accessQuery.error.message
          : "Failed to check GitHub Projects access."}
      </div>
    );
  }
  if (!hasAccess) {
    return <ProjectAccessBanner />;
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">
        {projectsQuery.isLoading ? (
          <ProjectSelectLoading />
        ) : projects.length === 0 ? (
          <span className="text-[12px] text-muted-foreground">No GitHub Projects found.</span>
        ) : (
          <Select
            value={selectedProject?.id ?? ""}
            onValueChange={(value) => {
              if (value) setSelectedProjectId(value);
            }}
          >
            <SelectTrigger size="sm" className="w-64 shrink-0" aria-label="Team project">
              <SelectValue>{selectedProject?.title ?? "Select a project"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )}
        <ToggleGroup
          variant="outline"
          size="xs"
          className="ms-auto shrink-0"
          value={[onlyPullRequests ? "prs" : "all"]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "prs") setOnlyPullRequests(true);
            else if (next === "all") setOnlyPullRequests(false);
          }}
        >
          <Toggle aria-label="Pull requests only" value="prs">
            PRs only
          </Toggle>
          <Toggle aria-label="All items" value="all">
            All items
          </Toggle>
        </ToggleGroup>
      </div>

      {projectsQuery.isError ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-destructive">
          {projectsQuery.error instanceof Error
            ? projectsQuery.error.message
            : "Failed to load GitHub Projects."}
        </div>
      ) : selectedProject ? (
        <TeamBoardColumns cwd={cwd} project={selectedProject} onlyPullRequests={onlyPullRequests} />
      ) : projectsQuery.isLoading ? (
        <div className="min-w-0 flex-1 px-3 py-3">
          <ReviewLoadingRows rows={5} className="rounded-md border border-border/60" />
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center px-6">
          <EmptyState icon={<GitPullRequestIcon />} title="Choose a project">
            Pick a GitHub Project to see its board.
          </EmptyState>
        </div>
      )}
    </div>
  );
}
