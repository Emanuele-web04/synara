// FILE: src/views/Crashes.tsx
// Purpose: Crash groups (process_type:reason) and a crash detail with log tail
// and dump download links.

import { Empty, Link, Loader, Table, Text } from "@cloudflare/kumo";
import { useEffect, useState } from "react";

import {
  api,
  AuthError,
  type CrashDetail as CrashDetailData,
  type CrashGroup,
  type Filters,
} from "../api";

export function Crashes({ filters, onAuthError }: { filters: Filters; onAuthError: () => void }) {
  const [rows, setRows] = useState<CrashGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .crashes(filters)
      .then((d) => !cancelled && setRows(d.crashes))
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onAuthError();
        else setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [filters, onAuthError]);

  if (error) return <Text variant="error">{error}</Text>;
  if (!rows) return <Loader />;
  if (rows.length === 0) return <Empty title="No crashes" />;

  return (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.Head>Process</Table.Head>
          <Table.Head>Reason</Table.Head>
          <Table.Head>Count</Table.Head>
          <Table.Head>Versions</Table.Head>
          <Table.Head>Last seen</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((r) => (
          <Table.Row key={`${r.processType}:${r.reason}`}>
            <Table.Cell>
              <Link href={`#/crashes/${r.latestId}`}>
                <Text variant="mono">{r.processType || "unknown"}</Text>
              </Link>
            </Table.Cell>
            <Table.Cell>
              <Text variant="mono">{r.reason || "—"}</Text>
            </Table.Cell>
            <Table.Cell>{r.count}</Table.Cell>
            <Table.Cell>
              <Text variant="secondary" size="sm">
                {r.versions}
              </Text>
            </Table.Cell>
            <Table.Cell>
              <Text variant="secondary" size="sm">
                {r.lastSeen.slice(0, 16).replace("T", " ")}
              </Text>
            </Table.Cell>
          </Table.Row>
        ))}
      </Table.Body>
    </Table>
  );
}

export function CrashDetail({ id, onAuthError }: { id: number; onAuthError: () => void }) {
  const [data, setData] = useState<CrashDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .crash(id)
      .then((d) => !cancelled && setData(d))
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onAuthError();
        else setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id, onAuthError]);

  if (error) return <Text variant="error">{error}</Text>;
  if (!data) return <Loader />;

  const { crash, dumps } = data;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <Link href="#/crashes">← Crashes</Link>
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <Field label="Process" value={crash.process_type} />
        <Field label="Reason" value={crash.reason} />
        <Field label="Version" value={crash.app_version} />
        <Field label="Platform" value={`${crash.platform}/${crash.arch}`} />
        <Field label="Time" value={crash.ts} />
      </div>
      {dumps.length > 0 && (
        <div>
          <Text bold>Minidumps</Text>
          <ul>
            {dumps.map((d) => (
              <li key={d.id}>
                <Link href={api.dumpUrl(d.r2Key)}>
                  <Text variant="mono">
                    {d.r2Key.split("/").pop()} ({Math.round(d.size / 1024)} KiB)
                  </Text>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {crash.log_tail && (
        <div>
          <Text bold>Log tail</Text>
          <pre
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              maxHeight: 400,
              overflow: "auto",
            }}
          >
            {crash.log_tail}
          </pre>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text variant="secondary" size="sm">
        {label}
      </Text>
      <div>
        <Text variant="mono">{value || "—"}</Text>
      </div>
    </div>
  );
}
