// FILE: src/App.tsx
// Purpose: Auth gate, hash router, underline nav, filter row, and the shared
// page shell for the beta diagnostics dashboard.

import { useCallback, useEffect, useState } from "react";

import { api } from "./api";
import { Button, relativeTime } from "./components";
import { navigate, useFilters, useRoute } from "./filters";
import { Login } from "./views/Login";
import { Overview } from "./views/Overview";
import { Issues } from "./views/Issues";
import { IssueDetail } from "./views/IssueDetail";
import { Usage } from "./views/Usage";
import { Product } from "./views/Product";
import { Releases } from "./views/Releases";
import { AuthError } from "./api";

/** Last diagnostics event as plain header meta; polls /api/status. */
function LastEvent({ onAuthError }: { onAuthError: () => void }) {
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      api
        .status()
        .then((d) => {
          if (cancelled) return;
          setLastEventAt(d.lastEventAt);
          setChecked(true);
        })
        .catch((e) => {
          if (!cancelled && e instanceof AuthError) onAuthError();
        });
    };
    tick();
    const timer = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [onAuthError]);
  if (!checked) return null;
  return (
    <span className="label-13 secondary">
      {lastEventAt
        ? `Last diagnostics event ${relativeTime(lastEventAt)}`
        : "No diagnostics events yet"}
    </span>
  );
}

const NAV = [
  { view: "overview", label: "Overview", hash: "#/" },
  { view: "issues", label: "Issues", hash: "#/issues" },
  { view: "usage", label: "Usage", hash: "#/usage" },
  { view: "product", label: "Product", hash: "#/product" },
  { view: "releases", label: "Releases", hash: "#/releases" },
] as const;

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const route = useRoute();
  const { filters, setFilters } = useFilters();
  const onAuthError = useCallback(() => setAuthed(false), []);

  useEffect(() => {
    api
      .session()
      .then((s) => setAuthed(s.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  if (authed === null) return null;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const tab =
    route.view === "issues" || route.view === "issue"
      ? "issues"
      : route.view === "usage"
        ? "usage"
        : route.view === "product"
          ? "product"
          : route.view === "releases"
            ? "releases"
            : "overview";

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header>
        <div className="masthead">
          <span className="label-16 strong">Synara</span>
          <span className="label-16 secondary">Insights</span>
          <div className="masthead-meta">
            <LastEvent onAuthError={onAuthError} />
            <Button
              variant="tertiary"
              onClick={() => void api.logout().then(() => setAuthed(false))}
            >
              Sign out
            </Button>
          </div>
        </div>
        <nav className="main-nav" aria-label="Sections">
          {NAV.map((item) => (
            <a
              key={item.view}
              href={item.hash}
              className={tab === item.view ? "active" : ""}
              aria-current={tab === item.view ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate(
                  {
                    view:
                      item.view === "issues"
                        ? "issues"
                        : item.view === "usage"
                          ? "usage"
                          : item.view === "product"
                            ? "product"
                            : item.view === "releases"
                              ? "releases"
                              : "overview",
                  },
                  filters,
                );
              }}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </header>

      <main id="main" className="main">
        {route.view === "overview" && (
          <Overview filters={filters} onFilterChange={setFilters} onAuthError={onAuthError} />
        )}
        {route.view === "issues" && (
          <Issues filters={filters} onFilterChange={setFilters} onAuthError={onAuthError} />
        )}
        {route.view === "issue" && (
          <IssueDetail
            issueKey={route.key}
            filters={filters}
            onFilterChange={setFilters}
            onAuthError={onAuthError}
          />
        )}
        {route.view === "usage" && (
          <Usage filters={filters} onFilterChange={setFilters} onAuthError={onAuthError} />
        )}
        {route.view === "product" && (
          <Product section={route.section ?? "overview"} onAuthError={onAuthError} />
        )}
        {route.view === "releases" && (
          <Releases filters={filters} onFilterChange={setFilters} onAuthError={onAuthError} />
        )}
      </main>

      <footer className="footer label-13">
        Product events cover installations that enabled sharing and expire after 30 days. Beta
        diagnostics follow their existing policy.
      </footer>
    </div>
  );
}
