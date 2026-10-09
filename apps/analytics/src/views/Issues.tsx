// FILE: src/views/Issues.tsx
// Purpose: The issue ledger — status underline tabs with counts, a sort
// control, and one full-width table.

import { useMemo, useState } from "react";

import { api, pickFilters, type Filters, type Issue } from "../api";
import {
  EmptyLine,
  ErrorState,
  FilterBar,
  filtersAreDefault,
  IssueTable,
  Loading,
  plural,
  useApiData,
} from "../components";

const FIELDS = ["days", "version", "platform", "kind", "search"] as const;
const REQ_FIELDS = ["version", "platform", "kind", "q"] as const;

const STATUS_TABS = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "ignored", label: "Ignored" },
  { value: "all", label: "All" },
];

const SORT_OPTIONS = [
  { label: "Most users", value: "users" },
  { label: "Most events", value: "events" },
  { label: "Last seen", value: "last" },
  { label: "First seen", value: "first" },
];

function matchesStatus(issue: Issue, status: string): boolean {
  if (status === "all") return true;
  // "Open" groups open + regressed, matching the worker's definition.
  if (status === "open") return issue.status === "open" || issue.status === "regressed";
  return issue.status === status;
}

export function Issues({
  filters,
  onFilterChange,
  onAuthError,
}: {
  filters: Filters;
  onFilterChange: (patch: Partial<Filters>) => void;
  onAuthError: () => void;
}) {
  const [status, setStatus] = useState("open");
  const [sort, setSort] = useState("users");
  // Fetch the full filtered list once; the status tabs and their counts are
  // computed locally so every count shares one query.
  // Only the params this view's filter bar exposes go on the request.
  const reqFilters = useMemo(() => pickFilters(filters, REQ_FIELDS), [filters]);
  const { data, error, busy, retry } = useApiData(
    () => api.issues(filters, "all", sort),
    [JSON.stringify(filters), sort],
    onAuthError,
  );
  // The headline claim needs the latest release version to count overlap.
  const { data: releaseData } = useApiData(
    () => api.releases(reqFilters),
    [JSON.stringify(reqFilters)],
    onAuthError,
  );

  const counts = useMemo(() => {
    const all = data?.issues ?? [];
    return {
      open: all.filter((i) => matchesStatus(i, "open")).length,
      resolved: all.filter((i) => i.status === "resolved").length,
      ignored: all.filter((i) => i.status === "ignored").length,
      all: all.length,
    };
  }, [data]);

  const shown = useMemo(
    () => (data?.issues ?? []).filter((i) => matchesStatus(i, status)),
    [data, status],
  );

  const latestVersion = releaseData?.releases[0]?.version;
  const openIssues = (data?.issues ?? []).filter((i) => matchesStatus(i, "open"));
  const onLatest = latestVersion
    ? openIssues.filter((i) => i.versions.includes(latestVersion)).length
    : 0;
  const headline =
    openIssues.length === 0
      ? "No open issues."
      : `${plural(openIssues.length, "open issue")}${
          onLatest > 0 && latestVersion ? `, ${onLatest} affecting the latest release` : ""
        }.`;
  const sentence =
    data && !filtersAreDefault(reqFilters)
      ? data.issues.length === 1
        ? "1 issue matches"
        : `${data.issues.length} issues match`
      : undefined;

  return (
    <div>
      <FilterBar
        filters={filters}
        onChange={onFilterChange}
        onAuthError={onAuthError}
        fields={[...FIELDS]}
        sentence={sentence}
      />
      {data && <h1 className="heading-32">{headline}</h1>}

      <div aria-busy={busy} className={busy ? "stale" : undefined}>
        <div className="section-head">
          <nav className="status-tabs" aria-label="Issue status">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                type="button"
                className={`status-tab${status === tab.value ? " active" : ""}`}
                aria-pressed={status === tab.value}
                onClick={() => setStatus(tab.value)}
              >
                {tab.label}
                <span className="secondary"> {counts[tab.value as keyof typeof counts]}</span>
              </button>
            ))}
          </nav>
          <span className="spacer" />
          <span className="select-wrap">
            <select
              className="select"
              aria-label="Sort issues"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </span>
        </div>

        {!data ? (
          error ? (
            <ErrorState error={error} onRetry={retry} />
          ) : (
            <Loading variant="list" />
          )
        ) : shown.length === 0 ? (
          <EmptyLine
            text={
              status === "open"
                ? "No open issues in this range."
                : `No ${status} issues in this range. Try a wider time range or different filters.`
            }
          />
        ) : (
          <IssueTable issues={shown} filters={filters} caption="Issues" />
        )}
      </div>
    </div>
  );
}
