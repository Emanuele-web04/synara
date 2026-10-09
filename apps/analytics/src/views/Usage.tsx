// FILE: src/views/Usage.tsx
// Purpose: Anonymous usage — how many installs run Beta, how much they use
// it, and which providers carry the turns. Aligned bar list for provider
// share, exact tables for the audit path.

import { useMemo } from "react";

import { api, pickFilters, type Filters } from "../api";
import {
  chartChrome,
  dayLabel,
  EChart,
  EmptyLine,
  ErrorState,
  FilterBar,
  filtersAreDefault,
  Loading,
  platformLabel,
  plural,
  rangeLabel,
  rangeSpansYears,
  Stat,
  TableWrap,
  useApiData,
  useChartTheme,
} from "../components";

const FIELDS = ["days", "version", "platform"] as const;
const REQ_FIELDS = ["version", "platform"] as const;
const DAY_MS = 86_400_000;

const PROVIDER_LABELS: Record<string, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  cursor: "Cursor",
  antigravity: "Antigravity",
  grok: "Grok",
  droid: "Droid",
  opencode: "OpenCode",
  pi: "Pi",
  devin: "Devin",
};

function localeName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function Usage({
  filters,
  onFilterChange,
  onAuthError,
}: {
  filters: Filters;
  onFilterChange: (patch: Partial<Filters>) => void;
  onAuthError: () => void;
}) {
  const t = useChartTheme();
  // Only the params this view's filter bar exposes go on the request.
  const reqFilters = useMemo(() => pickFilters(filters, REQ_FIELDS), [filters]);
  const { data, error, busy, retry } = useApiData(
    () => api.usage(reqFilters),
    [JSON.stringify(reqFilters)],
    onAuthError,
  );

  // Fill missing days client-side so a sparse day shows as 0, not a gap.
  const installsByDay = useMemo(() => {
    if (!data) return [];
    const n = Math.min(filters.days, 365);
    const todayMs = Date.parse(new Date().toISOString().slice(0, 10));
    const byDay = new Map(data.installsByDay.map((d) => [d.day, d.n]));
    return Array.from({ length: n }, (_, i) => {
      const day = new Date(todayMs - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10);
      return { day, n: byDay.get(day) ?? 0 };
    });
  }, [data, filters.days]);

  const chartOptions = useMemo(() => {
    if (!data) return null;
    const chrome = chartChrome(t);
    const showYear = rangeSpansYears(installsByDay);
    return {
      ...chrome,
      xAxis: {
        ...chrome.xAxis,
        data: installsByDay.map((d) => dayLabel(d.day, showYear)),
        axisLabel: {
          ...chrome.xAxis.axisLabel,
          interval: Math.max(0, Math.floor(installsByDay.length / 12)),
        },
      },
      series: [
        {
          name: "Active installs",
          type: "line" as const,
          data: installsByDay.map((d) => d.n),
          showSymbol: false,
          lineStyle: { color: t.gray1000, width: 1.5 },
          itemStyle: { color: t.gray1000 },
        },
      ],
    };
  }, [data, installsByDay, t]);

  const sentence =
    data && !filtersAreDefault(reqFilters)
      ? `${plural(data.activeInstalls, "install")} in scope`
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

  const range = rangeLabel(filters);
  const empty = data.activeInstalls === 0 && data.providers.length === 0;
  const mergeEnvironment = data.osVersions.length <= 3 || data.locales.length <= 3;

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
          {empty
            ? `No Beta installs were active in the ${range}.`
            : `${data.activeInstalls} active installs used Beta in the ${range}.`}
        </h1>

        <div className="stat-strip">
          <Stat
            label="Turns"
            value={String(data.turns)}
            detail={data.turns > 0 ? `${data.turnsFailedPct}% failed` : undefined}
          />
          <Stat
            label="New installs"
            value={String(
              data.newInstalls.imported + data.newInstalls.importFailed + data.newInstalls.fresh,
            )}
            detail={
              data.newInstalls.imported > 0
                ? `${data.newInstalls.imported} copied from Synara`
                : undefined
            }
          />
          <Stat
            label="Left Beta"
            value={String(data.left.trash + data.left.keep)}
            detail={data.left.trash > 0 ? `${data.left.trash} moved to Trash` : undefined}
          />
        </div>

        <section className="section" aria-labelledby="daily-active">
          <h2 id="daily-active" className="heading-20 section-head">
            Daily active installs
          </h2>
          <EChart
            option={chartOptions!}
            height={220}
            ariaLabel="Line chart of daily active installs"
          />
        </section>

        <section className="section" aria-labelledby="providers">
          <h2 id="providers" className="heading-20 section-head">
            Providers
          </h2>
          {data.providers.length === 0 ? (
            <EmptyLine text="No usage.daily events in this range." />
          ) : (
            <>
              <TableWrap>
                <table className="data data-fixed">
                  <caption className="visually-hidden">Usage by provider</caption>
                  <colgroup>
                    <col style={{ width: "24%" }} />
                    <col style={{ width: "34%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "14%" }} />
                    <col style={{ width: "14%" }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">Provider</th>
                      <th scope="col">Installs</th>
                      <th scope="col" className="num">
                        Threads
                      </th>
                      <th scope="col" className="num">
                        Turns
                      </th>
                      <th scope="col" className="num">
                        Failed
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.providers.map((p) => (
                      <tr key={p.provider}>
                        <td>{PROVIDER_LABELS[p.provider] ?? p.provider}</td>
                        <td>
                          <span className="share-cell">
                            <span className="share-track">
                              <span className="share-fill" style={{ width: `${p.sharePct}%` }} />
                            </span>
                            <span className="share-value">
                              {p.installs} · {p.sharePct}%
                            </span>
                          </span>
                        </td>
                        <td className="num">{p.threads}</td>
                        <td className="num">{p.turns}</td>
                        <td className="num">{p.failedPct}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <p className="chart-caption">
                Share of {plural(data.activeInstalls, "active install")}
              </p>
            </>
          )}
        </section>

        {mergeEnvironment ? (
          <section className="section" aria-labelledby="environment">
            <h2 id="environment" className="heading-20 section-head">
              Environment
            </h2>
            {data.osVersions.length === 0 && data.locales.length === 0 ? (
              <EmptyLine text="No app.start events in range." />
            ) : (
              <TableWrap>
                <table className="data">
                  <caption className="visually-hidden">
                    Installs by operating system and language
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Type</th>
                      <th scope="col">Value</th>
                      <th scope="col" className="num">
                        Installs
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.osVersions.map((row) => (
                      <tr key={`os:${row.platform}:${row.osVersion}`}>
                        <td className="secondary">OS</td>
                        <td>
                          {platformLabel(row.platform)} {row.osVersion || "unknown"}
                        </td>
                        <td className="num">{row.installs}</td>
                      </tr>
                    ))}
                    {data.locales.map((row) => (
                      <tr key={`lang:${row.locale}`}>
                        <td className="secondary">Language</td>
                        <td>
                          {localeName(row.locale)}{" "}
                          <span className="secondary label-13">({row.locale})</span>
                        </td>
                        <td className="num">{row.installs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            )}
          </section>
        ) : (
          <div className="split-2">
            <section className="section" aria-labelledby="os-versions">
              <h2 id="os-versions" className="heading-20 section-head">
                OS versions
              </h2>
              <TableWrap>
                <table className="data">
                  <caption className="visually-hidden">Installs by OS version</caption>
                  <thead>
                    <tr>
                      <th scope="col">OS</th>
                      <th scope="col" className="num">
                        Installs
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.osVersions.map((row) => (
                      <tr key={`${row.platform}:${row.osVersion}`}>
                        <td>
                          {platformLabel(row.platform)} {row.osVersion || "unknown"}
                        </td>
                        <td className="num">{row.installs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </section>
            <section className="section" aria-labelledby="languages">
              <h2 id="languages" className="heading-20 section-head">
                Languages
              </h2>
              <TableWrap>
                <table className="data">
                  <caption className="visually-hidden">Installs by language</caption>
                  <thead>
                    <tr>
                      <th scope="col">Language</th>
                      <th scope="col" className="num">
                        Installs
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.locales.map((row) => (
                      <tr key={row.locale}>
                        <td>
                          {localeName(row.locale)}{" "}
                          <span className="secondary label-13">({row.locale})</span>
                        </td>
                        <td className="num">{row.installs}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
