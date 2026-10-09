// FILE: privacy/page.tsx
// Purpose: Full privacy page — the detailed, honest account of what Synara does
//          (and doesn't do) with your data. Linked from the homepage + footer.
// Layer: App Router page (static)
// Depends on: Navbar, SiteFooter, react-icons/lu
// Note: Claims verified against the synara codebase. Keep them in sync with the
//       app: local workspaces, optional account features, explicit feedback,
//       opt-in product analytics and separate Beta diagnostics.

import type { ReactNode } from "react";
import Link from "next/link";
import { LuCheck, LuX, LuArrowDownToLine } from "react-icons/lu";
import Navbar from "@/components/Navbar";
import SiteFooter from "@/components/SiteFooter";
import { SITE_URL, breadcrumbJsonLd, jsonLdScript, pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Privacy — Synara",
  description:
    "Synara's security and privacy boundary: local workspaces, optional account features, opt-in product analytics and separate Beta diagnostics.",
  path: "/privacy",
});

const LAST_UPDATED = "October 5, 2026";

const RECEIVED_IF_OPTED_IN = [
  "Fixed event names for app opens, selected features, connection outcomes and chat requests",
  "A random installation identifier, event identifier and timestamp; unrelated to your account",
  "Your app version, release channel, app surface and platform",
  "Bounded durations and available token counts; no model names or conversation content",
];

const NEVER_COLLECTED = [
  "Your prompts, messages, or chat history",
  "Your code, files, diffs, or repository contents",
  "Your API keys, tokens, or provider credentials",
  "Your name, email, or IP-based location profile",
];

const PRIVACY_JSONLD = [
  {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${SITE_URL}/privacy#webpage`,
    name: "Synara privacy",
    url: `${SITE_URL}/privacy`,
    dateModified: "2026-10-05",
    description:
      "Synara privacy details covering local workspaces, optional account features, opt-in product analytics and separate Beta diagnostics.",
  },
  breadcrumbJsonLd([
    { name: "Synara", path: "/" },
    { name: "Privacy", path: "/privacy" },
  ]),
];

export default function PrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--page-bg)] text-[var(--text-primary)]">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(PRIVACY_JSONLD) }}
      />
      <Navbar />

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-10 pb-20 sm:px-6 sm:pt-14">
        <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
          Privacy
        </p>
        <h1 className="mt-3 text-[1.75rem] font-medium leading-[1.1] tracking-[-0.035em] sm:text-[2.25rem]">
          Private by default. Clear by design.
        </h1>
        <p className="mt-5 text-[14px] leading-[1.7] text-[var(--text-secondary)] sm:text-[15px]">
          Synara stores workspace history on the computer running the workspace. Optional account
          features, connections and mobile access use additional services as described below.
          Product analytics are off by default. Synara Beta has separate, always-on crash and
          release diagnostics; the product analytics switch does not disable those diagnostics.
        </p>

        <Section title="Where your data lives">
          <p>
            Workspace chats, projects and operational state live in a local SQLite database on the
            host computer. A connected device can access that host with your authorization. Optional
            Synara account features store profile information, private usage aggregates and saved
            Inbox recaps in our account database on PostgreSQL/Supabase, accessed through our
            Cloudflare API. These saved account records are separate from product analytics.
          </p>
        </Section>

        <Section title="Where your prompts and code go">
          <p>
            When you chat with a model, Synara connects <strong>directly</strong> to the provider
            you chose — Claude, Codex, OpenCode, Cursor, Antigravity, Grok, Droid, and so on — using
            your own existing logins. Your prompts and code go only to that provider, governed by{" "}
            <em>their</em> privacy terms. Synara does not proxy, copy, or store that traffic on any
            server of ours.
          </p>
        </Section>

        <Section title="Optional accounts and connections">
          <p>
            Local desktop use does not require a Synara account. Signing in enables account features
            and managed device connections. Authentication uses WorkOS; the account API and managed
            tunnels use Cloudflare. Approved devices can access the selected host, including its
            chats and files, through that connection. You can revoke device access. Information you
            choose to publish on your profile is public; saved Inbox recaps are private.
          </p>
        </Section>

        <Section title="Product analytics — off by default">
          <p>
            Desktop Stable, Beta and the native mobile apps can send limited product events to our
            Cloudflare service when you enable <strong>Share product analytics</strong> in Settings.
            Consent is local to each installation, off by default, and independent of your account
            or another connected device. The random installation identifier allows events from that
            consenting installation to be grouped; it is not your account identity.
          </p>

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <DataCard
              tone="receive"
              title="If you opt in, we receive"
              items={RECEIVED_IF_OPTED_IN}
            />
            <DataCard tone="never" title="Analytics never receives" items={NEVER_COLLECTED} />
          </div>

          <p className="mt-6">
            Events are stored in a separate Cloudflare D1 table with a 30-day raw-data retention
            policy and an authenticated dashboard. Turning collection off clears unsent events,
            cancels uploads where possible and removes the local analytics identifier. It cannot
            retract events already received. Re-enabling creates a new identifier. Usage counters
            are best-effort observations, not billing records or complete account usage totals.
          </p>
        </Section>

        <Section title="Separate Beta diagnostics">
          <p>
            Synara Beta sends crash, error, release-health and daily usage diagnostics
            automatically. These may include bounded, redacted error stacks, log excerpts and recent
            diagnostic context. Stable does not send Beta diagnostics. Product analytics consent
            does not control this separate Beta path, whose retention policy is independent of the
            30-day product-event policy. See the{" "}
            <a href="https://github.com/Emanuele-web04/synara/blob/main/docs/diagnostics.md">
              diagnostics documentation
            </a>{" "}
            for its field allowlist and storage details.
          </p>
        </Section>

        <Section title="Feedback you choose to send">
          <p>
            The in-app <strong>Feedback Synara</strong> dialog sends only when you press Submit. It
            includes the text you wrote, app version, operating system, provider and model, runtime
            modes, and session/turn status so we can understand the conditions around a problem.
          </p>
          <p>
            Feedback context excludes chat messages, prompts, project paths, repository contents,
            session logs and screenshots. Feedback reports are delivered through our website and
            email provider to the Synara maintainer for support and product improvement, rather than
            being added to an analytics profile.
          </p>
        </Section>

        <Section title="Open source">
          <p>
            Synara is open source under the MIT license. If a sentence on this page isn&apos;t
            enough, you can verify every claim yourself —{" "}
            <a
              href="https://github.com/Emanuele-web04/synara"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent-link)] transition-colors hover:text-[var(--accent-link-hover)]"
            >
              read the code on GitHub
            </a>
            .
          </p>
        </Section>

        <Section title="About this website">
          <p>
            This marketing site (the page you&apos;re reading) uses privacy- friendly{" "}
            <a
              href="https://developers.cloudflare.com/web-analytics/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent-link)] transition-colors hover:text-[var(--accent-link-hover)]"
            >
              Cloudflare Web Analytics
            </a>{" "}
            for anonymous, aggregate visit counts. No cookies, no cross-site tracking, no selling of
            data.
          </p>
        </Section>

        <div className="mt-12 flex flex-col gap-4 border-t border-[var(--divide)] pt-8 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[12px] text-[var(--text-tertiary)]">
            Last updated {LAST_UPDATED}. Questions?{" "}
            <a
              href="https://x.com/emanueledpt"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[var(--accent-link)] transition-colors hover:text-[var(--accent-link-hover)]"
            >
              Reach out on X
            </a>
            .
          </p>
          <Link
            href="/install"
            className="inline-flex w-fit items-center gap-2 rounded-full bg-[var(--btn-primary-bg)] px-5 py-2.5 text-[13px] font-medium text-[var(--btn-primary-fg)] transition-opacity hover:opacity-90"
          >
            Download Synara
            <LuArrowDownToLine className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-10 border-t border-[var(--divide)] pt-8">
      <h2 className="text-[1.05rem] font-medium tracking-[-0.02em] text-[var(--text-primary)]">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[14px] leading-[1.7] text-[var(--text-secondary)] [&_strong]:font-medium [&_strong]:text-[var(--text-primary)]">
        {children}
      </div>
    </section>
  );
}

function DataCard({
  tone,
  title,
  items,
}: {
  tone: "receive" | "never";
  title: string;
  items: string[];
}) {
  const isNever = tone === "never";
  return (
    <div className="rounded-2xl border border-[var(--divide)] bg-[var(--block-elevated)] p-5">
      <h3 className="text-[13px] font-medium text-[var(--text-primary)]">{title}</h3>
      <ul className="mt-3 space-y-2.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-[13px] leading-snug">
            <span
              className={`mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full ${
                isNever
                  ? "bg-[color-mix(in_oklab,var(--text-primary)_10%,transparent)] text-[var(--text-tertiary)]"
                  : "bg-[color-mix(in_oklab,var(--accent-link)_18%,transparent)] text-[var(--accent-link)]"
              }`}
            >
              {isNever ? (
                <LuX className="size-3" aria-hidden="true" />
              ) : (
                <LuCheck className="size-3" aria-hidden="true" />
              )}
            </span>
            <span className="text-[var(--text-secondary)]">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
