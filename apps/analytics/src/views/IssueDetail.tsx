// FILE: src/views/IssueDetail.tsx
// Purpose: One issue — headline, meta line, status actions, a per-day bar
// chart, by-version/by-platform breakdowns, the stack block, and the
// occurrences ledger.

import { useMemo, useState } from "react";

import { api, AuthError, pickFilters, type Filters } from "../api";
import { navigate } from "../filters";
import {
  Button,
  chartChrome,
  CodeBlock,
  dayLabel,
  EChart,
  EmptyLine,
  ErrorState,
  FilterBar,
  filtersAreDefault,
  issueStatusWord,
  KIND_LABELS,
  Loading,
  platformLabel,
  plural,
  rangeSpansYears,
  relativeTime,
  RelTime,
  Stat,
  TableWrap,
  useApiData,
  useChartTheme,
} from "../components";

const FIELDS = ["days", "version", "platform"] as const;
const REQ_FIELDS = ["version", "platform"] as const;
const DAY_MS = 86_400_000;

export function IssueDetail({
  issueKey,
  filters,
  onFilterChange,
  onAuthError,
}: {
  issueKey: string;
  filters: Filters;
  onFilterChange: (patch: Partial<Filters>) => void;
  onAuthError: () => void;
}) {
  const t = useChartTheme();
  const [statusBusy, setStatusBusy] = useState(false);
  const [optimisticStatus, setOptimisticStatus] = useState<string | null>(null);
  // Only the params this view's filter bar exposes go on the request.
  const reqFilters = useMemo(() => pickFilters(filters, REQ_FIELDS), [filters]);
  const { data, error, busy, retry } = useApiData(
    () => api.issue(issueKey, reqFilters),
    [issueKey, JSON.stringify(reqFilters)],
    onAuthError,
  );

  const chartOptions = useMemo(() => {
    if (!data) return null;
    const chrome = chartChrome(t);
    const counts = data.timeseries;
    const n = counts.length;
    // Rebuild the day labels the worker used: the last bucket is today.
    const todayMs = Date.parse(new Date().toISOString().slice(0, 10));
    const days = counts.map((_, i) =>
      new Date(todayMs - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10),
    );
    const showYear = rangeSpansYears(days.map((day) => ({ day })));
    // Bound the axis to the data's useful span: at most one day of run-up
    // before the issue's first sighting.
    const firstSeenDay = Date.parse(data.issue.firstSeen.slice(0, 10));
    const firstIdx = Math.max(0, n - 1 - Math.round((todayMs - firstSeenDay) / DAY_MS) - 1);
    const color = t.gray1000;
    return {
      ...chrome,
      xAxis: {
        ...chrome.xAxis,
        data: days.map((d) => dayLabel(d, showYear)),
        min: firstIdx,
        max: n - 1,
      },
      series: [
        {
          name: "Events",
          type: "bar" as const,
          itemStyle: { color },
          barMaxWidth: 14,
          data: counts,
        },
      ],
    };
  }, [data, t]);

  const sentence =
    data && !filtersAreDefault(reqFilters)
      ? `${plural(data.issue.events, "event")} in scope`
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

  const { issue, detail } = data;
  const status = optimisticStatus ?? issue.status;

  const setStatus = async (next: "open" | "resolved" | "ignored") => {
    const previous = status;
    setOptimisticStatus(next);
    setStatusBusy(true);
    try {
      await api.setIssueStatus(issue.key, next);
      setOptimisticStatus(null);
      retry();
    } catch (e) {
      setOptimisticStatus(previous);
      if (e instanceof AuthError) onAuthError();
    } finally {
      setStatusBusy(false);
    }
  };

  const logs = [detail?.stack, detail?.logTail].filter(Boolean).join("\n\n");
  // The message repeats the title verbatim for many issues — skip it then.
  const message =
    detail?.message && detail.message.trim() !== issue.title.trim() ? detail.message : null;
  const sourceValues = new Set(data.occurrences.map((o) => o.source).filter(Boolean));
  const installValues = new Set(data.occurrences.map((o) => o.installId));
  const showSource = sourceValues.size >= 2;
  const showInstall = installValues.size >= 2;
  const showDump = data.occurrences.some((o) => o.dumps.length > 0);

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
        <a
          className="back-link label-13"
          href="#/issues"
          onClick={(e) => {
            e.preventDefault();
            navigate({ view: "issues" }, filters);
          }}
        >
          Back to issues
        </a>

        <div className="section-head">
          <h1 className="heading-24">{issue.title}</h1>
          <span className="spacer" />
          <div className="detail-actions">
            {status === "open" || status === "regressed" ? (
              <>
                <Button
                  variant="secondary"
                  disabled={statusBusy}
                  onClick={() => setStatus("resolved")}
                >
                  Resolve
                </Button>
                <Button
                  variant="secondary"
                  disabled={statusBusy}
                  onClick={() => setStatus("ignored")}
                >
                  Ignore
                </Button>
              </>
            ) : (
              <Button variant="secondary" disabled={statusBusy} onClick={() => setStatus("open")}>
                Reopen
              </Button>
            )}
          </div>
        </div>
        <p className="meta-line">
          {KIND_LABELS[issue.kind] ?? issue.kind}
          {" · "}
          <span className="mono">{issue.key}</span>
          {" · First seen "}
          {relativeTime(issue.firstSeen)}
          {" on "}
          <span className="mono">{issue.firstVersion}</span>
          {" · Last seen "}
          {relativeTime(issue.lastSeen)}
          {" · "}
          <span className="status-word">{issueStatusWord(issue)}</span>
        </p>

        <div className="stat-strip">
          {issue.events === issue.users ? (
            <div className="stat">
              <p className="stat-value heading-24 numeric">
                {plural(issue.events, "event")} from {plural(issue.users, "install")}
              </p>
            </div>
          ) : (
            <>
              <Stat label="Events" value={String(issue.events)} />
              <Stat label="Installs affected" value={String(issue.users)} />
            </>
          )}
        </div>

        <section className="section" aria-labelledby="issue-trend">
          <h2 id="issue-trend" className="heading-20 section-head">
            Events per day
          </h2>
          <EChart
            option={chartOptions!}
            height={200}
            ariaLabel={`Daily events for ${issue.title}`}
          />
        </section>

        <div className="split-2">
          <section className="section" aria-labelledby="by-version">
            <h2 id="by-version" className="heading-20 section-head">
              By version
            </h2>
            {data.byVersion.length === 0 ? (
              <EmptyLine text="No events in this range." />
            ) : (
              <TableWrap>
                <table className="data">
                  <caption className="visually-hidden">Events by app version</caption>
                  <thead>
                    <tr>
                      <th scope="col">Version</th>
                      <th scope="col" className="num">
                        Events
                      </th>
                      <th scope="col" className="num">
                        Installs
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byVersion.map((r) => (
                      <tr key={r.version}>
                        <td className="mono">{r.version}</td>
                        <td className="num">{r.events}</td>
                        <td className="num">{r.users}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </section>
          <section className="section" aria-labelledby="by-platform">
            <h2 id="by-platform" className="heading-20 section-head">
              By platform
            </h2>
            {data.byPlatform.length === 0 ? (
              <EmptyLine text="No events in this range." />
            ) : (
              <TableWrap>
                <table className="data">
                  <caption className="visually-hidden">Events by platform</caption>
                  <thead>
                    <tr>
                      <th scope="col">Platform</th>
                      <th scope="col" className="num">
                        Events
                      </th>
                      <th scope="col" className="num">
                        Installs
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byPlatform.map((r) => (
                      <tr key={r.platform}>
                        <td>{platformLabel(r.platform)}</td>
                        <td className="num">{r.events}</td>
                        <td className="num">{r.users}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </section>
        </div>

        {(message || logs) && (
          <section className="section" aria-labelledby="issue-detail-block">
            <h2 id="issue-detail-block" className="heading-20 section-head">
              Detail
            </h2>
            {message && <CodeBlock text={message} />}
            {logs && (
              <div style={{ marginTop: message ? 8 : 0 }}>
                <CodeBlock text={logs} />
              </div>
            )}
          </section>
        )}

        <section className="section" aria-labelledby="occurrences">
          <h2 id="occurrences" className="heading-20 section-head">
            Occurrences
          </h2>
          {data.occurrences.length === 0 ? (
            <EmptyLine text="Filters or the time range exclude every stored event." />
          ) : (
            <TableWrap>
              <table className="data">
                <caption className="visually-hidden">Individual occurrences of this issue</caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Version</th>
                    <th scope="col">Platform</th>
                    {showSource && <th scope="col">Source</th>}
                    {showInstall && <th scope="col">Install</th>}
                    {showDump && <th scope="col">Dump</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.occurrences.map((o) => (
                    <tr key={o.id}>
                      <td className="numeric" title={o.ts}>
                        <RelTime ts={o.ts} />
                      </td>
                      <td className="mono">{o.appVersion}</td>
                      <td>
                        {platformLabel(o.platform)} {o.arch}
                      </td>
                      {showSource && <td className="secondary">{o.source}</td>}
                      {showInstall && <td className="mono secondary">{o.installId}</td>}
                      {showDump && (
                        <td>
                          {o.dumps.map((d) => (
                            <a
                              key={d.id}
                              className="section-link label-13"
                              href={api.dumpUrl(d.r2Key)}
                            >
                              {Math.round(d.size / 1024)} KiB
                            </a>
                          ))}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </section>
      </div>
    </div>
  );
}
