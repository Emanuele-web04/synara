import { PROVIDER_DISPLAY_NAMES, ProjectId } from "@synara/contracts";
import {
  type MindListResult,
  type MindMemory,
  type MindMemoryType,
  type MindProfile,
} from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { type VariantProps } from "class-variance-authority";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "~/components/chat/chatHeaderControls";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge, badgeVariants } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { RouteInsetSurface } from "~/components/RouteInsetSurface";
import { SearchInput } from "~/components/ui/search-input";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { CentralIcon } from "~/lib/central-icons";
import {
  MIND_HISTORY_NOTE,
  countStaleMindMemories,
  formatMindCountLabel,
  formatMindDigestSuffix,
  formatMindWeightLabel,
  formatMindHistoryActorLabel,
  formatMindHistoryOpLabel,
  groupMindMemoriesByDay,
  optimisticAffirmWeight,
  optimisticForgetCount,
  sortMindMemories,
} from "~/lib/mindList";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { formatRelativeTime } from "~/lib/relativeTime";
import { pinActionLabel, PinStatusIcon } from "~/lib/pin";
import { cn } from "~/lib/utils";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "~/surfaceStyles";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

export const Route = createFileRoute("/_chat/mind/")({
  component: MindRouteView,
});

const mindQueryKey = ["mind"] as const;

const EMPTY_MIND_LIST: MindListResult = { memories: [], count: 0, cap: 0 };

/** Quiet color coding for the four memory types, from the shared badge variants. */
type MindBadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;
const MIND_TYPE_BADGE_VARIANT: Record<MindMemoryType, MindBadgeVariant> = {
  decision: "info",
  procedural: "secondary",
  semantic: "outline",
  episodic: "warning",
};

/**
 * Provenance in human words, agent rows only. Humans have no save surface,
 * so user-kind rows (legacy backfills) render with no suffix.
 * Provider names reuse the shared display map; thread ids stay out of the UI.
 */
function provenanceLabel(provenance: MindMemory["provenance"]): string | null {
  if (provenance.kind === "user") return null;
  return `Saved by ${PROVIDER_DISPLAY_NAMES[provenance.provider]}`;
}

/**
 * Mind list row: a leading type badge, a two-line text/detail stack, and trailing
 * still-true affirm plus edit plus pin toggle plus hover-reveal delete, with an
 * inline editor and a per-row history timeline below. Not clickable —
 * there is no memory detail surface; the row is the whole interaction
 * (affirm, edit, pin, delete, history).
 */
function MindListRow({
  memory,
  projectName,
  onAffirm,
  onTogglePinned,
  onDelete,
  onSaveEdit,
}: {
  readonly memory: MindMemory;
  readonly projectName: string;
  readonly onAffirm: () => void;
  readonly onTogglePinned: () => void;
  readonly onDelete: () => void;
  readonly onSaveEdit: (input: { readonly text: string; readonly type: MindMemoryType }) => void;
}) {
  const pinLabel = pinActionLabel("memory", memory.pinned);
  const provenance = provenanceLabel(memory.provenance);
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(memory.text);
  const [draftType, setDraftType] = useState<MindMemoryType>(memory.type);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyQuery = useQuery({
    queryKey: ["mind", "history", memory.memoryId] as const,
    queryFn: () =>
      ensureNativeApi().mind.history({
        projectId: memory.projectId,
        memoryId: memory.memoryId,
      }),
    enabled: historyOpen,
    staleTime: 30_000,
  });
  const openEditor = () => {
    setDraftText(memory.text);
    setDraftType(memory.type);
    setIsEditing(true);
  };
  return (
    <div
      className={cn(
        "group flex w-full items-start gap-2.5 rounded-md px-2 py-2.5 text-left",
        ELEVATED_HOVER_SURFACE_CLASS_NAME,
      )}
    >
      <span className="mt-0.5 flex shrink-0">
        <Badge size="sm" variant={MIND_TYPE_BADGE_VARIANT[memory.type]} className="capitalize">
          {memory.type}
        </Badge>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {isEditing ? (
          <span className="flex flex-col gap-1.5 py-0.5">
            <textarea
              aria-label="Edit memory text"
              value={draftText}
              onChange={(event) => setDraftText(event.target.value)}
              rows={3}
              maxLength={500}
              className="w-full resize-y rounded-md border border-input bg-background px-2 py-1.5 text-[0.8125rem] text-foreground outline-none [font-family:var(--font-ui-family)] focus-visible:ring-1 focus-visible:ring-ring"
            />
            <span className="flex items-center gap-1.5">
              <select
                aria-label="Edit memory type"
                value={draftType}
                onChange={(event) => setDraftType(event.target.value as MindMemoryType)}
                className="rounded-md border border-input bg-background px-1.5 py-1 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="semantic">semantic</option>
                <option value="episodic">episodic</option>
                <option value="procedural">procedural</option>
                <option value="decision">decision</option>
              </select>
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  onSaveEdit({ text: draftText, type: draftType });
                  setIsEditing(false);
                }}
              >
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setIsEditing(false)}>
                Cancel
              </Button>
            </span>
          </span>
        ) : (
          <>
            <span className="truncate text-[0.8125rem] text-foreground">{memory.text}</span>
            <span className="truncate text-xs text-muted-foreground">
              {projectName} · {formatRelativeTime(memory.createdAt)} ·{" "}
              {formatMindWeightLabel(memory.weight)}
              {provenance ? ` · ${provenance}` : ""}
              {memory.accessCount > 0
                ? ` · ${memory.accessCount} ${pluralize(memory.accessCount, "recall", "recalls")}`
                : ""}
              {memory.pinned ? " · pinned" : ""}
            </span>
            <span className="flex items-center gap-1">
              <button
                type="button"
                aria-label={historyOpen ? "Hide history" : "Show history"}
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((open) => !open)}
                className="w-fit rounded text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                History
              </button>
            </span>
            <DisclosureRegion open={historyOpen}>
              <span className="flex flex-col gap-0.5 py-1 text-xs text-muted-foreground">
                <span>{MIND_HISTORY_NOTE}</span>
                {historyQuery.isLoading ? (
                  <span>Loading history…</span>
                ) : historyQuery.isError ? (
                  <span>
                    {historyQuery.error instanceof Error
                      ? historyQuery.error.message
                      : "Failed to load history."}{" "}
                    <button
                      type="button"
                      onClick={() => void historyQuery.refetch()}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      Retry
                    </button>
                  </span>
                ) : (
                  (historyQuery.data?.entries ?? []).map((entry, index) => (
                    <span key={`${entry.createdAt}-${entry.op}-${index}`}>
                      {formatMindHistoryOpLabel(entry.op)} ·{" "}
                      {formatMindHistoryActorLabel(entry.actor)} ·{" "}
                      {formatRelativeTime(entry.createdAt)}
                    </span>
                  ))
                )}
              </span>
            </DisclosureRegion>
          </>
        )}
      </span>
      {/* Trailing actions hide while editing: Save/Cancel own the row then. */}
      {isEditing ? null : (
        <>
          <button
            type="button"
            aria-label="Still true"
            title="Still true"
            onClick={onAffirm}
            className="shrink-0 self-center rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <CentralIcon name="checkmark-1-small" className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Edit memory"
            title="Edit"
            onClick={openEditor}
            className="shrink-0 self-center rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <CentralIcon name="pencil" className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={pinLabel}
            title={pinLabel}
            onClick={onTogglePinned}
            className="shrink-0 self-center rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground"
          >
            <PinStatusIcon pinned={memory.pinned} className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="Delete memory"
            title="Delete"
            onClick={onDelete}
            className="shrink-0 self-center rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
          >
            <CentralIcon name="trash-can-simple" className="size-3.5" />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Per-project opt-in profile: user-authored context the recall digest appends
 * only while opted in. Agents have no write path — this card is the only one.
 * The parent remounts per project id, so draft state starts fresh each time.
 */
function MindProfileCard({
  projectId,
  projectName,
}: {
  readonly projectId: ProjectId;
  readonly projectName: string;
}) {
  const queryClient = useQueryClient();
  const profileQueryKey = ["mind", "profile", projectId] as const;
  const profileQuery = useQuery({
    queryKey: profileQueryKey,
    queryFn: () => ensureNativeApi().mind.profileGet({ projectId }),
    staleTime: 30_000,
  });
  const saved: MindProfile | null = profileQuery.data ?? null;
  const [draftText, setDraftText] = useState("");
  const [optedIn, setOptedIn] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (!hydrated && profileQuery.data !== undefined) {
      setDraftText(profileQuery.data?.text ?? "");
      setOptedIn(profileQuery.data?.optedIn ?? false);
      setHydrated(true);
    }
  }, [hydrated, profileQuery.data]);

  // Optimistic save, same rollback shape as the memory rows: the card shows
  // the draft eagerly and the invalidate-on-settle refetch converges it. An
  // empty text while opting out keeps the last saved text server-side, so the
  // optimistic row mirrors that instead of blanking.
  const saveMutation = useMutation({
    mutationFn: (input: { readonly text: string; readonly optedIn: boolean }) =>
      ensureNativeApi().mind.profileSet({
        projectId,
        text: input.text,
        optedIn: input.optedIn,
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: profileQueryKey });
      const previous = queryClient.getQueryData<MindProfile | null>(profileQueryKey);
      const trimmed = input.text.trim();
      queryClient.setQueryData<MindProfile | null>(profileQueryKey, {
        projectId,
        text: trimmed.length > 0 ? trimmed : (previous?.text ?? ""),
        optedIn: input.optedIn,
        updatedAt: new Date().toISOString(),
      });
      return { previous };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: profileQueryKey });
      toastManager.add({ type: "success", title: "Profile saved" });
    },
    onError: (error, _input, context) => {
      if (context?.previous !== undefined)
        queryClient.setQueryData(profileQueryKey, context.previous);
      toastManager.add({ type: "error", title: error.message });
    },
  });

  return (
    <section
      aria-label="Project profile"
      className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate text-sm font-medium text-foreground">
          Project profile · {projectName}
        </h2>
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
          <Switch
            checked={optedIn}
            onCheckedChange={setOptedIn}
            aria-label="Include profile in recalls"
          />
          Include in recalls
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Opt-in context for this project only. Included in recall digests while opted in, never
        shared across projects.
      </p>
      {profileQuery.isLoading ? (
        <span className="text-xs text-muted-foreground">Loading profile…</span>
      ) : profileQuery.isError ? (
        <span className="text-xs text-muted-foreground">
          {profileQuery.error instanceof Error
            ? profileQuery.error.message
            : "Failed to load profile."}{" "}
          <button
            type="button"
            onClick={() => void profileQuery.refetch()}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Retry
          </button>
        </span>
      ) : (
        <>
          <Textarea
            aria-label="Project profile text"
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            rows={3}
            maxLength={500}
            placeholder="E.g. Uses bun, prefers small diffs, deploys on Fridays."
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={saveMutation.isPending}
              onClick={() => saveMutation.mutate({ text: draftText, optedIn })}
            >
              Save profile
            </Button>
            {saved ? (
              <span className="truncate text-xs text-muted-foreground">
                Updated {formatRelativeTime(saved.updatedAt)}
                {saved.optedIn ? " · included in recalls" : " · not included"}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">No profile saved yet.</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function MindRouteView() {
  const queryClient = useQueryClient();
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const projects = useStore((state) => state.projects);
  const [search, setSearch] = useState("");
  const [projectFilter, setProjectFilter] = useState<string | null>(null);

  const mindQuery = useQuery({
    queryKey: mindQueryKey,
    queryFn: () => ensureNativeApi().mind.list({}),
    // Matches the sidebar Mind badge and provider catalog queries: fresh
    // enough to feel live, cached enough to survive route remounts.
    // Polls the bounded page while open so agent saves appear without refresh.
    staleTime: 30_000,
    refetchInterval: 30_000,
  });
  const data = mindQuery.data ?? EMPTY_MIND_LIST;

  // Optimistic removal: the row disappears immediately; the server's forget is
  // idempotent, so the invalidate-on-settle only converges the count/cap meta.
  // While the page is truncated the count is the true total and stays put —
  // the refetch converges it (see optimisticForgetCount).
  const forgetMutation = useMutation({
    mutationFn: (memory: MindMemory) =>
      ensureNativeApi().mind.forget({ projectId: memory.projectId, memoryId: memory.memoryId }),
    onMutate: async (memory) => {
      await queryClient.cancelQueries({ queryKey: mindQueryKey });
      const previous = queryClient.getQueryData<MindListResult>(mindQueryKey);
      queryClient.setQueryData<MindListResult>(mindQueryKey, (prev) =>
        prev
          ? {
              memories: prev.memories.filter((item) => item.memoryId !== memory.memoryId),
              count: optimisticForgetCount({ count: prev.count, shown: prev.memories.length }),
              cap: prev.cap,
            }
          : prev,
      );
      return { previous };
    },
    onSuccess: (_data, memory) => {
      void queryClient.invalidateQueries({ queryKey: mindQueryKey });
      toastManager.add({ type: "success", title: "Memory forgotten" });
    },
    onError: (error, _memory, context) => {
      if (context?.previous) queryClient.setQueryData(mindQueryKey, context.previous);
      toastManager.add({ type: "error", title: error.message });
    },
  });

  // Optimistic affirm ("still true"), same rollback shape as pin: the weight
  // bumps eagerly and the invalidate-on-settle refetch converges it.
  const affirmMutation = useMutation({
    mutationFn: (memory: MindMemory) =>
      ensureNativeApi().mind.affirm({ projectId: memory.projectId, memoryId: memory.memoryId }),
    onMutate: async (memory) => {
      await queryClient.cancelQueries({ queryKey: mindQueryKey });
      const previous = queryClient.getQueryData<MindListResult>(mindQueryKey);
      queryClient.setQueryData<MindListResult>(mindQueryKey, (prev) =>
        prev
          ? {
              ...prev,
              memories: prev.memories.map((item) =>
                item.memoryId === memory.memoryId
                  ? {
                      ...item,
                      weight: optimisticAffirmWeight(item.weight),
                      accessCount: item.accessCount + 1,
                    }
                  : item,
              ),
            }
          : prev,
      );
      return { previous };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mindQueryKey });
      toastManager.add({ type: "success", title: "Memory affirmed" });
    },
    onError: (error, _memory, context) => {
      if (context?.previous) queryClient.setQueryData(mindQueryKey, context.previous);
      toastManager.add({ type: "error", title: error.message });
    },
  });
  // Optimistic edit: the text swaps eagerly and the invalidate-on-settle
  // refetch converges it (the server trims, so the refetch also converges
  // whitespace). Server rejections — duplicates, secrets — roll back and
  // surface the server's message.
  const updateMutation = useMutation({
    mutationFn: (input: {
      readonly memory: MindMemory;
      readonly text: string;
      readonly type: MindMemoryType;
    }) =>
      ensureNativeApi().mind.update({
        projectId: input.memory.projectId,
        memoryId: input.memory.memoryId,
        text: input.text,
        type: input.type,
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: mindQueryKey });
      const previous = queryClient.getQueryData<MindListResult>(mindQueryKey);
      queryClient.setQueryData<MindListResult>(mindQueryKey, (prev) =>
        prev
          ? {
              ...prev,
              memories: prev.memories.map((item) =>
                item.memoryId === input.memory.memoryId
                  ? { ...item, text: input.text, type: input.type }
                  : item,
              ),
            }
          : prev,
      );
      return { previous };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: mindQueryKey });
      toastManager.add({ type: "success", title: "Saved" });
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(mindQueryKey, context.previous);
      toastManager.add({ type: "error", title: error.message });
    },
  });
  // Optimistic pin flip, same rollback shape as forget.
  const setPinnedMutation = useMutation({
    mutationFn: (input: { readonly memory: MindMemory; readonly pinned: boolean }) =>
      ensureNativeApi().mind.setPinned({
        projectId: input.memory.projectId,
        memoryId: input.memory.memoryId,
        pinned: input.pinned,
      }),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: mindQueryKey });
      const previous = queryClient.getQueryData<MindListResult>(mindQueryKey);
      queryClient.setQueryData<MindListResult>(mindQueryKey, (prev) =>
        prev
          ? {
              ...prev,
              memories: prev.memories.map((item) =>
                item.memoryId === input.memory.memoryId ? { ...item, pinned: input.pinned } : item,
              ),
            }
          : prev,
      );
      return { previous };
    },
    onSuccess: (_data, input) => {
      void queryClient.invalidateQueries({ queryKey: mindQueryKey });
      toastManager.add({
        type: "success",
        title: input.pinned ? "Memory pinned" : "Memory unpinned",
      });
    },
    onError: (error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(mindQueryKey, context.previous);
      toastManager.add({ type: "error", title: error.message });
    },
  });

  const projectNamesById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  // Projects present in the loaded page, for the filter chips.
  const visibleProjects = useMemo(() => {
    const ids = [...new Set(data.memories.map((memory) => memory.projectId))];
    return ids.map((id) => ({ id, name: projectNamesById.get(id) ?? "Unknown project" }));
  }, [data.memories, projectNamesById]);
  // The profile card edits exactly one project: the chip-selected one, or the
  // only loaded project when no filter is set. Otherwise the card names the
  // missing choice instead of guessing across projects. The id re-gains its
  // brand here — it always originates from server-loaded memory rows.
  const profileProjectId =
    projectFilter !== null
      ? ProjectId.makeUnsafe(projectFilter)
      : visibleProjects.length === 1 && visibleProjects[0] !== undefined
        ? ProjectId.makeUnsafe(visibleProjects[0].id)
        : null;
  const pinnedCount = useMemo(
    () => data.memories.filter((memory) => memory.pinned).length,
    [data.memories],
  );

  // The server already returns weight-desc; re-sort so optimistic pin/weight edits
  // and any out-of-order cache merges keep the same order the server would send.
  const sortedMemories = useMemo(() => sortMindMemories(data.memories), [data.memories]);
  const filteredMemories = useMemo(() => {
    const scoped =
      projectFilter === null
        ? sortedMemories
        : sortedMemories.filter((memory) => memory.projectId === projectFilter);
    const query = search.trim().toLowerCase();
    if (query.length === 0) return scoped;
    return scoped.filter(
      (memory) =>
        memory.text.toLowerCase().includes(query) ||
        (projectNamesById.get(memory.projectId) ?? "").toLowerCase().includes(query),
    );
  }, [sortedMemories, search, projectFilter, projectNamesById]);

  // Day groups for the loaded page: newest day first, weight-desc inside a day.
  const groupedMemories = useMemo(
    () => groupMindMemoriesByDay(filteredMemories),
    [filteredMemories],
  );

  // Digest signals computed client-side from the loaded rows: stale count plus
  // cap pressure, appended to the back-compat meta count line.
  const digestSuffix = useMemo(
    () =>
      formatMindDigestSuffix({
        staleCount: countStaleMindMemories(data.memories),
        count: data.count,
        cap: data.cap,
      }),
    [data.memories, data.count, data.cap],
  );

  const renderMindList = () => (
    <section className="flex flex-col gap-2">
      {filteredMemories.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-2 py-4 text-xs text-muted-foreground">
          <span>No memories match — clear search.</span>
          <Button variant="outline" size="sm" onClick={() => setSearch("")}>
            Clear search
          </Button>
        </div>
      ) : (
        <div className="flex flex-col">
          {groupedMemories.map((group, index) => (
            <div key={group.key} className="flex flex-col">
              <h2
                className={cn(
                  "px-2 pb-1 text-xs font-medium text-muted-foreground",
                  index > 0 && "pt-3",
                )}
              >
                {group.label}
              </h2>
              {group.memories.map((memory) => (
                <MindListRow
                  key={memory.memoryId}
                  memory={memory}
                  projectName={projectNamesById.get(memory.projectId) ?? "Unknown project"}
                  onAffirm={() => affirmMutation.mutate(memory)}
                  onTogglePinned={() =>
                    setPinnedMutation.mutate({ memory, pinned: !memory.pinned })
                  }
                  onDelete={() => forgetMutation.mutate(memory)}
                  onSaveEdit={(input) =>
                    updateMutation.mutate({ memory, text: input.text, type: input.type })
                  }
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );

  return (
    <RouteInsetSurface>
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <header
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "drag-region",
            desktopTopBarTrafficLightGutterClassName,
            desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <div className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
            <div className="min-w-0 flex-1" />
            <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
              <SearchInput
                aria-label="Search memories"
                placeholder="Search memories"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-56"
              />
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Refresh"
                title="Refresh"
                onClick={() => void mindQuery.refetch()}
              >
                <CentralIcon name="arrow-rotate-clockwise" className="size-4" />
              </Button>
            </div>
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-12 pt-8">
            <h1 className="px-2 font-heading text-2xl font-semibold tracking-tight text-foreground">
              Mind
            </h1>
            {data.memories.length > 0 ? (
              profileProjectId !== null ? (
                <MindProfileCard
                  key={profileProjectId}
                  projectId={profileProjectId}
                  projectName={projectNamesById.get(profileProjectId) ?? "Unknown project"}
                />
              ) : (
                <p className="px-2 text-xs text-muted-foreground">
                  Select a project to edit its profile.
                </p>
              )
            ) : null}
            {data.memories.length > 0 ? (
              <div className="flex flex-col gap-2 px-2">
                <p className="text-xs text-muted-foreground">
                  {formatMindCountLabel({
                    shown: data.memories.length,
                    total: data.count,
                    pinnedCount,
                    cap: data.cap,
                  })}
                  {digestSuffix}
                </p>
                {visibleProjects.length > 1 ? (
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by project">
                    <Button
                      type="button"
                      size="chip"
                      variant="ghost"
                      data-pressed={projectFilter === null}
                      aria-pressed={projectFilter === null}
                      onClick={() => setProjectFilter(null)}
                    >
                      All
                    </Button>
                    {visibleProjects.map((project) => (
                      <Button
                        key={project.id}
                        type="button"
                        size="chip"
                        variant="ghost"
                        data-pressed={projectFilter === project.id}
                        aria-pressed={projectFilter === project.id}
                        onClick={() =>
                          setProjectFilter(projectFilter === project.id ? null : project.id)
                        }
                      >
                        {project.name}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {mindQuery.isError ? (
              <Alert variant="error" size="sm" className="text-destructive">
                <AlertDescription>
                  <span>
                    {mindQuery.error instanceof Error
                      ? mindQuery.error.message
                      : "Failed to load memories."}
                  </span>
                  <Button variant="outline" size="sm" onClick={() => void mindQuery.refetch()}>
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : mindQuery.isLoading ? (
              <div className="py-16 text-center text-sm text-muted-foreground">
                Loading memories...
              </div>
            ) : data.memories.length === 0 ? (
              <div className="flex flex-col items-center gap-1 py-16 text-center">
                <p className="max-w-md text-sm font-medium text-foreground">
                  Mind is Synara's shared memory for your projects. Agents save durable decisions
                  and conventions here and recall them in any provider's session.
                </p>
                <p className="text-xs text-muted-foreground">
                  Agents save memories as you work — ask yours to remember a choice. Recall only
                  reads; confirming a memory lifts its weight.
                </p>
              </div>
            ) : (
              renderMindList()
            )}
          </div>
        </main>
      </div>
    </RouteInsetSurface>
  );
}
