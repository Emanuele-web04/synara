// FILE: src/App.tsx
// Purpose: Auth gate, hash router, shared filters, and top-level layout for the
// beta diagnostics dashboard.

import { Badge, Button, Select, Surface, Tabs, Text } from "@cloudflare/kumo";
import { useCallback, useEffect, useState } from "react";

import { api, type Filters } from "./api";
import { Login } from "./views/Login";
import { Overview } from "./views/Overview";
import { CrashDetail, Crashes } from "./views/Crashes";
import { ErrorDetail, Errors } from "./views/Errors";

type Route =
  | { view: "overview" }
  | { view: "crashes" }
  | { view: "crash"; id: number }
  | { view: "errors" }
  | { view: "error"; fingerprint: string };

function parseHash(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const crash = /^crashes\/(\d+)$/.exec(hash);
  if (crash) return { view: "crash", id: Number(crash[1]) };
  const err = /^errors\/([0-9a-fA-F]{8,32})$/.exec(hash);
  if (err) return { view: "error", fingerprint: err[1]! };
  if (hash === "crashes") return { view: "crashes" };
  if (hash === "errors") return { view: "errors" };
  return { view: "overview" };
}

const nav = (to: string) => {
  window.location.hash = to;
};

const DAY_OPTIONS = [
  { label: "24h", value: 1 },
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "1y", value: 365 },
];

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [route, setRoute] = useState<Route>(parseHash);
  const [filters, setFilters] = useState<Filters>({ days: 7, version: "" });
  const [versions, setVersions] = useState<string[]>([]);

  useEffect(() => {
    api
      .session()
      .then((s) => setAuthed(s.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const onAuthError = useCallback(() => setAuthed(false), []);

  if (authed === null) return null;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const tab =
    route.view === "overview"
      ? "overview"
      : route.view === "crashes" || route.view === "crash"
        ? "crashes"
        : "errors";

  return (
    <div style={{ maxWidth: 1080, margin: "0 auto", padding: "24px 16px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          marginBottom: 16,
          flexWrap: "wrap",
        }}
      >
        <Text variant="heading" as="h1">
          Synara Beta Diagnostics
        </Text>
        <Badge variant="info">beta</Badge>
        <div style={{ flex: 1 }} />
        <Select
          aria-label="Time range"
          items={DAY_OPTIONS}
          value={filters.days}
          onValueChange={(v) => setFilters((f) => ({ ...f, days: Number(v) }))}
        />
        <Select
          aria-label="App version"
          placeholder="All versions"
          items={[
            { label: "All versions", value: "" },
            ...versions.map((v) => ({ label: v, value: v })),
          ]}
          value={filters.version}
          onValueChange={(v) => setFilters((f) => ({ ...f, version: String(v) }))}
        />
        <Button variant="secondary" onClick={() => void api.logout().then(() => setAuthed(false))}>
          Sign out
        </Button>
      </div>

      <Tabs
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "crashes", label: "Crashes" },
          { value: "errors", label: "Errors" },
        ]}
        value={tab}
        onValueChange={(v) => nav(v === "overview" ? "/" : `/${v}`)}
      />

      <Surface style={{ marginTop: 16, padding: 16 }}>
        {route.view === "overview" && (
          <Overview filters={filters} onVersions={setVersions} onAuthError={onAuthError} />
        )}
        {route.view === "crashes" && <Crashes filters={filters} onAuthError={onAuthError} />}
        {route.view === "crash" && <CrashDetail id={route.id} onAuthError={onAuthError} />}
        {route.view === "errors" && <Errors filters={filters} onAuthError={onAuthError} />}
        {route.view === "error" && (
          <ErrorDetail
            fingerprint={route.fingerprint}
            filters={filters}
            onAuthError={onAuthError}
          />
        )}
      </Surface>
    </div>
  );
}
