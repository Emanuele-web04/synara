// FILE: src/views/Errors.tsx
// Purpose: Error groups by fingerprint and per-fingerprint occurrence detail.

import { Empty, Link, Loader, Table, Text } from "@cloudflare/kumo";
import { useEffect, useState } from "react";

import { api, AuthError, type ErrorGroup, type ErrorOccurrence, type Filters } from "../api";

export function Errors({ filters, onAuthError }: { filters: Filters; onAuthError: () => void }) {
  const [rows, setRows] = useState<ErrorGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .errors(filters)
      .then((d) => !cancelled && setRows(d.errors))
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
  if (rows.length === 0) return <Empty title="No errors" />;

  return (
    <Table>
      <Table.Header>
        <Table.Row>
          <Table.Head>Message</Table.Head>
          <Table.Head>Count</Table.Head>
          <Table.Head>Installs</Table.Head>
          <Table.Head>Versions</Table.Head>
          <Table.Head>Last seen</Table.Head>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((r) => (
          <Table.Row key={r.fingerprint}>
            <Table.Cell>
              <Link href={`#/errors/${r.fingerprint}`}>
                <Text size="sm">{r.message ?? r.fingerprint}</Text>
              </Link>
            </Table.Cell>
            <Table.Cell>{r.count}</Table.Cell>
            <Table.Cell>{r.installs}</Table.Cell>
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

export function ErrorDetail({
  fingerprint,
  filters,
  onAuthError,
}: {
  fingerprint: string;
  filters: Filters;
  onAuthError: () => void;
}) {
  const [rows, setRows] = useState<ErrorOccurrence[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .error(fingerprint, filters)
      .then((d) => !cancelled && setRows(d.occurrences))
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof AuthError) onAuthError();
        else setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [fingerprint, filters, onAuthError]);

  if (error) return <Text variant="error">{error}</Text>;
  if (!rows) return <Loader />;

  const first = rows[0];
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div>
        <Link href="#/errors">← Errors</Link>
      </div>
      {first?.message && <Text>{first.message}</Text>}
      {first?.stack && (
        <pre
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            maxHeight: 320,
            overflow: "auto",
          }}
        >
          {first.stack}
        </pre>
      )}
      <div>
        <Text bold>Recent occurrences</Text>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.Head>Time</Table.Head>
              <Table.Head>Source</Table.Head>
              <Table.Head>Version</Table.Head>
              <Table.Head>Install</Table.Head>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows.map((r) => (
              <Table.Row key={r.id}>
                <Table.Cell>
                  <Text variant="secondary" size="sm">
                    {r.ts.slice(0, 19).replace("T", " ")}
                  </Text>
                </Table.Cell>
                <Table.Cell>{r.source}</Table.Cell>
                <Table.Cell>
                  <Text variant="mono">{r.appVersion}</Text>
                </Table.Cell>
                <Table.Cell>
                  <Text variant="mono">{r.installId.slice(0, 8)}</Text>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      </div>
    </div>
  );
}
