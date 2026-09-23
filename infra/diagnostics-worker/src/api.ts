// FILE: src/api.ts
// Purpose: Thin fetch layer for the dashboard API.

export interface Filters {
  days: number;
  version: string;
}

const qs = (f: Filters): string => {
  const p = new URLSearchParams({ days: String(f.days) });
  if (f.version) p.set("version", f.version);
  return `?${p}`;
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export class AuthError extends Error {}

export interface OverviewData {
  activeInstalls24h: number;
  activeInstallsRange: number;
  crashesByVersion: { version: string; n: number }[];
  errorsByVersion: { version: string; n: number }[];
  timeseries: { day: string; event: string; n: number }[];
  versions: string[];
}

export interface CrashGroup {
  processType: string;
  reason: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  versions: string;
  latestId: number;
}

export interface CrashDetail {
  crash: {
    id: number;
    ts: string;
    install_id: string;
    app_version: string;
    platform: string;
    arch: string;
    process_type: string;
    reason: string;
    log_tail: string | null;
  };
  dumps: { id: number; r2Key: string; size: number; receivedAt: string }[];
}

export interface ErrorGroup {
  fingerprint: string;
  count: number;
  installs: number;
  firstSeen: string;
  lastSeen: string;
  versions: string;
  message: string | null;
}

export interface ErrorOccurrence {
  id: number;
  ts: string;
  installId: string;
  appVersion: string;
  source: string;
  message: string | null;
  stack: string | null;
}

export const api = {
  session: () => get<{ authenticated: boolean }>("/api/session"),
  login: (password: string) =>
    fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
      credentials: "same-origin",
    }),
  logout: () => fetch("/api/logout", { method: "POST", credentials: "same-origin" }),
  overview: (f: Filters) => get<OverviewData>(`/api/overview${qs(f)}`),
  crashes: (f: Filters) => get<{ crashes: CrashGroup[] }>(`/api/crashes${qs(f)}`),
  crash: (id: number) => get<CrashDetail>(`/api/crashes/${id}`),
  errors: (f: Filters) => get<{ errors: ErrorGroup[] }>(`/api/errors${qs(f)}`),
  error: (fp: string, f: Filters) =>
    get<{ fingerprint: string; occurrences: ErrorOccurrence[] }>(
      `/api/errors/${encodeURIComponent(fp)}${qs(f)}`,
    ),
  dumpUrl: (key: string) => `/api/dumps/${encodeURIComponent(key)}`,
};
