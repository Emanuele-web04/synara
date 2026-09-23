// FILE: src/views/Overview.tsx
// Purpose: Install counts, per-version crash/error counts, events-over-time.

import * as echarts from "echarts";
import { ChartPalette, Loader, Table, Text, TimeseriesChart } from "@cloudflare/kumo";
import { useEffect, useMemo, useState } from "react";

import { api, AuthError, type Filters, type OverviewData } from "../api";

export function Overview({
  filters,
  onVersions,
  onAuthError,
}: {
  filters: Filters;
  onVersions: (v: string[]) => void;
  onAuthError: () => void;
}) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .overview(filters)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        onVersions(d.versions);
      })
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onAuthError();
        else setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [filters, onVersions, onAuthError]);

  const series = useMemo(() => {
    if (!data) return [];
    const byEvent = new Map<string, [number, number][]>();
    for (const row of data.timeseries) {
      const day = new Date(`${row.day}T00:00:00Z`).getTime();
      const list = byEvent.get(row.event) ?? [];
      list.push([day, row.n]);
      byEvent.set(row.event, list);
    }
    return [...byEvent.entries()].map(([name, points], i) => ({
      name,
      data: points.toSorted((a, b) => a[0] - b[0]),
      color: ChartPalette.categorical(i),
    }));
  }, [data]);

  if (error) return <Text variant="error">{error}</Text>;
  if (!data) return <Loader />;

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <div style={{ display: "flex", gap: 32 }}>
        <Stat label="Active installs · 24h" value={data.activeInstalls24h} />
        <Stat label={`Active installs · ${filters.days}d`} value={data.activeInstallsRange} />
      </div>

      <div>
        <Text bold>Events</Text>
        <TimeseriesChart echarts={echarts} type="bar" data={series} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <CountTable title="Crashes by version" rows={data.crashesByVersion} />
        <CountTable title="Errors by version" rows={data.errorsByVersion} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <Text variant="secondary" size="sm">
        {label}
      </Text>
      <div>
        <Text size="lg" bold>
          {value}
        </Text>
      </div>
    </div>
  );
}

function CountTable({ title, rows }: { title: string; rows: { version: string; n: number }[] }) {
  return (
    <div>
      <Text bold>{title}</Text>
      <Table>
        <Table.Header>
          <Table.Row>
            <Table.Head>Version</Table.Head>
            <Table.Head>Count</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {rows.map((r) => (
            <Table.Row key={r.version}>
              <Table.Cell>{r.version}</Table.Cell>
              <Table.Cell>{r.n}</Table.Cell>
            </Table.Row>
          ))}
          {rows.length === 0 && (
            <Table.Row>
              <Table.Cell colSpan={2}>
                <Text variant="secondary">None</Text>
              </Table.Cell>
            </Table.Row>
          )}
        </Table.Body>
      </Table>
    </div>
  );
}
