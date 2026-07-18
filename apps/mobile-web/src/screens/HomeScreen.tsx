import {
  IconAlertTriangle,
  IconArrowUpRight,
  IconFolder,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useCompanion } from "../companionContext";
import { EmptyState, ScreenHeader, SectionHeading, ThreadRow } from "../components/ui";
import { needsAttention, sortThreads } from "../lib/mobileLogic";

export function HomeScreen() {
  const { shell, refresh } = useCompanion();
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const matchingThreads = useMemo(
    () =>
      sortThreads(shell.threads).filter((thread) => {
        if (!normalizedQuery) return true;
        const project = shell.projects.find((candidate) => candidate.id === thread.projectId);
        return `${thread.title} ${thread.summary ?? ""} ${project?.name ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery);
      }),
    [normalizedQuery, shell.projects, shell.threads],
  );
  const attentionThreads = matchingThreads.filter((thread) => needsAttention(thread.status));
  const runningThreads = matchingThreads.filter((thread) => thread.status === "running");
  const recentThreads = matchingThreads.filter(
    (thread) => !needsAttention(thread.status) && thread.status !== "running",
  );

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="screen home-screen">
      <ScreenHeader
        eyebrow="Mobile companion"
        title="Your Synara"
        actions={
          <button
            className="icon-button"
            type="button"
            aria-label="Refresh tasks"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
          >
            <IconRefresh className={refreshing ? "spin" : undefined} aria-hidden="true" size={20} />
          </button>
        }
      />

      <label className="search-field">
        <IconSearch aria-hidden="true" size={19} />
        <span className="visually-hidden">Search tasks and projects</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search tasks and projects"
          autoComplete="off"
        />
      </label>

      {!normalizedQuery ? (
        <section className="section-block" aria-labelledby="projects-heading">
          <SectionHeading title="Projects" count={shell.projects.length} />
          <div className="horizontal-cards">
            {shell.projects.map((project) => {
              const threadCount = shell.threads.filter(
                (thread) => thread.projectId === project.id,
              ).length;
              return (
                <Link
                  key={project.id}
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  className="project-card"
                >
                  <div className="project-card__icon">
                    <IconFolder aria-hidden="true" size={19} stroke={1.8} />
                  </div>
                  <h3>{project.name}</h3>
                  <p>{project.workspaceLabel}</p>
                  <span>
                    {threadCount} {threadCount === 1 ? "task" : "tasks"}
                    <IconArrowUpRight aria-hidden="true" size={15} />
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      ) : null}

      {attentionThreads.length > 0 ? (
        <section className="section-block" aria-labelledby="attention-heading">
          <SectionHeading title="Needs attention" count={attentionThreads.length} />
          <div className="thread-list thread-list--attention">
            {attentionThreads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </div>
        </section>
      ) : null}

      {runningThreads.length > 0 ? (
        <section className="section-block" aria-labelledby="running-heading">
          <SectionHeading title="Running now" count={runningThreads.length} />
          <div className="thread-list">
            {runningThreads.map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="section-block" aria-labelledby="recent-heading">
        <SectionHeading title={normalizedQuery ? "Search results" : "Recent tasks"} />
        {recentThreads.length > 0 ? (
          <div className="thread-list">
            {recentThreads.slice(0, normalizedQuery ? undefined : 8).map((thread) => (
              <ThreadRow key={thread.id} thread={thread} />
            ))}
          </div>
        ) : attentionThreads.length === 0 && runningThreads.length === 0 ? (
          <EmptyState
            icon={normalizedQuery ? <IconSearch size={23} /> : <IconPlayerPlay size={23} />}
            title={normalizedQuery ? "No matching tasks" : "Ready for a task"}
            description={
              normalizedQuery
                ? "Try a project name or a different keyword."
                : shell.projects.length > 0
                  ? "Open a project to start a new task from your phone."
                  : "Add a project in the desktop app before starting a mobile task."
            }
          />
        ) : null}
      </section>

      {shell.projects.length === 0 ? (
        <div className="inline-warning">
          <IconAlertTriangle aria-hidden="true" size={18} />
          Projects can only be added from the Synara desktop app.
        </div>
      ) : null}
    </div>
  );
}
