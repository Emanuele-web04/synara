// FILE: src/views/Releases.tsx
// Purpose: Per-release health — the audit table behind the overview's
// latest-release line.

import { useMemo } from "react";

import { api, pickFilters, type Filters } from "../api";
import {
  EmptyLine,
  ErrorState,
  FilterBar,
  filtersAreDefault,
  HealthWord,
  healthFor,
  Loading,
  plural,
  rangeLabel,
  RelTime,
  TableWrap,
  useApiData,
} from "../components";

const FIELDS = ["days", "platform"] as const;
const REQ_FIELDS = ["platform"] as const;

export function Releases({
  filters,
  onFilterChange,
  onAuthError,
}: {
  filters: Filters;
  onFilterChange: (patch: Partial<Filters>) => void;
  onAuthError: () => void;
}) {
  // Only the params this view's filter bar exposes go on the request.
  const reqFilters = useMemo(() => pickFilters(filters, REQ_FIELDS), [filters]);
  const { data, error, busy, retry } = useApiData(
    () => api.releases(reqFilters),
    [JSON.stringify(reqFilters)],
    onAuthError,
  );

  const sentence =
    data && !filtersAreDefault(reqFilters)
      ? `${plural(data.releases.length, "release")} in scope`
      : undefined;

  if (error || !data) {
    return (
      <div>
        <FilterBar
          filters={filters}
          onChange={onFilterChange}
          onAuthError={onAuthError}
          fields={[...FIELDS]}
        />
        {error ? <ErrorState error={error} onRetry={retry} /> : <Loading />}
      </div>
    );
  }

  const latest = data.releases[0];
  const range = rangeLabel(filters);

  return (
    <div>
      <FilterBar
        filters={filters}
        onChange={onFilterChange}
        onAuthError={onAuthError}
        fields={[...FIELDS]}
        sentence={sentence}
      />
      <div aria-busy={busy} className={busy ? "stale" : undefined}>
        {error && <ErrorState error={error} onRetry={retry} />}
        <h1 className="heading-32">
          {latest
            ? `${latest.version} is the latest release, first seen ${new Date(
                latest.firstSeen,
              ).toLocaleDateString("en-US", { month: "short", day: "numeric" })}.`
            : `No releases reported in the ${range}.`}
        </h1>

        <section className="section" aria-labelledby="release-table">
          <h2 id="release-table" className="heading-20 section-head">
            Release health
          </h2>
          {data.releases.length === 0 ? (
            <EmptyLine text="No release events in this range." />
          ) : (
            <TableWrap>
              <table className="data">
                <caption className="visually-hidden">Health per release version</caption>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">First seen</th>
                    <th scope="col" className="num">
                      Installs
                    </th>
                    <th scope="col" className="num">
                      Crash-free
                    </th>
                    <th scope="col" className="num">
                      Errors
                    </th>
                    <th scope="col" className="num">
                      Crashes
                    </th>
                    <th scope="col" className="num">
                      Update failures
                    </th>
                    <th scope="col" className="num">
                      New issues
                    </th>
                    <th scope="col">Health</th>
                  </tr>
                </thead>
                <tbody>
                  {data.releases.map((r) => (
                    <tr key={r.version}>
                      <td className="mono">{r.version}</td>
                      <td className="secondary">
                        <RelTime ts={r.firstSeen} />
                      </td>
                      <td className="num">{r.installs}</td>
                      <td className="num">{r.crashFreePct === null ? "" : `${r.crashFreePct}%`}</td>
                      <td className="num">{r.errors}</td>
                      <td className="num">{r.crashes}</td>
                      <td className="num">{r.updateFailures}</td>
                      <td className="num">{r.newIssues}</td>
                      <td>
                        <HealthWord health={healthFor(r.crashFreePct, r.installs)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
          <p className="chart-caption">
            Healthy means at least 99.5% crash-free; watch starts under that and unhealthy under
            98%.
          </p>
        </section>
      </div>
    </div>
  );
}
