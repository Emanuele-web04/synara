// FILE: src/api.ts
// Purpose: Thin fetch layer for the dashboard API plus the shared filter model.

export interface Filters {
  days: number;
  version: string;
  platform: string;
  kind: string;
  q: string;
}

export const EMPTY_FILTERS: Filters = {
  days: 7,
  version: "",
  platform: "",
  kind: "",
  q: "",
};

/** A copy of `filters` with only the listed fields kept — a view sends just
    the params its own filter bar exposes. `days` always goes along. */
export function pickFilters(f: Filters, fields: readonly (keyof Filters)[]): Filters {
  const out: Filters = { ...EMPTY_FILTERS, days: f.days };
  for (const key of fields) {
    if (key !== "days") out[key] = f[key];
  }
  return out;
}

export function filtersQuery(f: Filters): string {
  const p = new URLSearchParams({ days: String(f.days) });
  if (f.version) p.set("version", f.version);
  if (f.platform) p.set("platform", f.platform);
  if (f.kind) p.set("kind", f.kind);
  if (f.q) p.set("q", f.q);
  return `?${p}`;
}

/** Login error copy: network failure, rate limit, or wrong password. */
export function loginErrorMessage(res: Response | null): string {
  if (res === null) return "Couldn't reach the server. Try again.";
  if (res.status === 429) return "Too many attempts. Wait a minute and try again.";
  return "Wrong password.";
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

export class AuthError extends Error {}

export type IssueKind = "error" | "crash" | "update";
export type IssueStatus = "open" | "resolved" | "ignored" | "regressed";

export interface Issue {
  key: string;
  kind: IssueKind;
  title: string;
  events: number;
  users: number;
  firstSeen: string;
  lastSeen: string;
  versions: string[];
  firstVersion: string;
  status: IssueStatus;
  isNew: boolean;
  trend: number[];
}

export interface ReleaseRow {
  version: string;
  firstSeen: string;
  installs: number;
  crashFreePct: number | null;
  errors: number;
  crashes: number;
  updateFailures: number;
  newIssues: number;
}

export type ReleaseHealth = "healthy" | "watch" | "unhealthy" | null;

export interface OverviewData {
  activeInstalls24h: number;
  activeInstalls: number;
  crashFreePct: number | null;
  newIssues: number;
  updateFailures: number;
  timeseries: { day: string; errors: number; crashes: number; updateFailures: number }[];
  topIssues: Issue[];
  previous: {
    activeInstalls: number | null;
    crashFreePct: number | null;
    /** Null when a version filter is set — no meaningful previous window. */
    newIssues: number | null;
    updateFailures: number | null;
  };
  lastEventAt: string | null;
  latestRelease: (ReleaseRow & { health: ReleaseHealth }) | null;
}

export interface ActivityEvent {
  id: number;
  ts: string;
  event: string;
  kind: string;
  issueKey: string | null;
  title: string;
  appVersion: string;
  platform: string;
  outcome: string;
}

export interface IssueDetail {
  issue: Issue;
  detail: {
    message: string | null;
    stack: string | null;
    logTail: string | null;
    processType: string;
    reason: string;
    errorContext: string;
  } | null;
  timeseries: number[];
  byVersion: { version: string; events: number; users: number }[];
  byPlatform: { platform: string; events: number; users: number }[];
  occurrences: {
    id: number;
    ts: string;
    appVersion: string;
    platform: string;
    arch: string;
    source: string;
    installId: string;
    dumps: { id: number; r2Key: string; size: number }[];
  }[];
}

export interface UsageData {
  activeInstalls: number;
  installsByDay: { day: string; n: number }[];
  turns: number;
  turnsFailedPct: number;
  newInstalls: { imported: number; importFailed: number; fresh: number };
  left: { trash: number; keep: number };
  providers: {
    provider: string;
    installs: number;
    sharePct: number;
    threads: number;
    turns: number;
    failedPct: number;
  }[];
  osVersions: { platform: string; osVersion: string; installs: number }[];
  locales: { locale: string; installs: number }[];
}

export interface ProductFilters {
  from: string;
  to: string;
  channel: "" | "stable" | "beta";
  surface: "" | "desktop" | "ios" | "ipados";
}

export interface ProductData {
  from: string;
  to: string;
  channel: string | null;
  surface: string | null;
  events: number;
  activeInstallations: number;
  daily: { day: string; events: number; installations: number; turns: number }[];
  features: { feature: string; events: number; installations: number }[];
  outcomes: { event: string; outcome: string; events: number }[];
  latency: { event: string; meanDurationMs: number; samples: number }[];
  observedDesktopTurns: {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    daily: { day: string; provider: string; turns: number }[];
    previous: { from: string; to: string; providers: { provider: string; turns: number }[] } | null;
    providers: {
      provider: string;
      turns: number;
      succeeded: number;
      failed: number;
      cancelled: number;
      inputTokens: number | null;
      inputSamples: number;
      outputTokens: number | null;
      outputSamples: number;
      cachedInputTokens: number | null;
      cachedInputSamples: number;
    }[];
  };
  observedDesktopCompletions: {
    inputTokens: { total: number | null; samples: number };
    outputTokens: { total: number | null; samples: number };
    cachedInputTokens: { total: number | null; samples: number };
  };
  eventTypes: { event: string; events: number; installations: number }[];
}

export function productFiltersQuery(f: ProductFilters): string {
  const params = new URLSearchParams({ from: f.from, to: f.to });
  if (f.channel) params.set("channel", f.channel);
  if (f.surface) params.set("surface", f.surface);
  return `?${params}`;
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
  filterOptions: () => get<{ versions: string[]; platforms: string[] }>("/api/filters"),
  overview: (f: Filters) => get<OverviewData>(`/api/overview${filtersQuery(f)}`),
  issues: (f: Filters, status: string, sort: string) =>
    get<{ issues: Issue[] }>(`/api/issues${filtersQuery(f)}&status=${status}&sort=${sort}`),
  issue: (key: string, f: Filters) =>
    get<IssueDetail>(`/api/issues/${encodeURIComponent(key)}${filtersQuery(f)}`),
  setIssueStatus: (key: string, status: "open" | "resolved" | "ignored") =>
    post<{ status: string }>(`/api/issues/${encodeURIComponent(key)}/status`, { status }),
  releases: (f: Filters) => get<{ releases: ReleaseRow[] }>(`/api/releases${filtersQuery(f)}`),
  usage: (f: Filters) => get<UsageData>(`/api/usage${filtersQuery(f)}`),
  product: (f: ProductFilters) => get<ProductData>(`/api/product${productFiltersQuery(f)}`),
  activity: (f: Filters) => get<{ activity: ActivityEvent[] }>(`/api/activity${filtersQuery(f)}`),
  status: () => get<{ lastEventAt: string | null }>("/api/status"),
  dumpUrl: (key: string) => `/api/dumps/${encodeURIComponent(key)}`,
};
