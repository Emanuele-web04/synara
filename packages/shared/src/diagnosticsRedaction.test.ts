// FILE: diagnosticsRedaction.test.ts
// Purpose: Table-driven coverage of every diagnostics redaction rule.

import { describe, expect, it } from "vitest";

import { redactDiagnosticText } from "./diagnosticsRedaction";

const OPTS = { homeDir: "/Users/kartik", maxLength: 16 * 1024 };
const redact = (text: string) => redactDiagnosticText(text, OPTS);

describe("redactDiagnosticText", () => {
  it.each([
    [
      "home directory collapses to ~ then basename",
      "crash at /Users/kartik/.synara-beta/logs/x.log",
      "~/…/x.log",
      "/Users/kartik",
    ],
    ["macOS user path", "open /Users/alice/project failed", "~/…/project", "alice"],
    ["linux user path", "open /home/bob/project failed", "~/…/project", "bob"],
    ["windows user path", "open C:\\Users\\carol\\file.txt failed", "~/…/file.txt", "carol"],
    [
      "windows user path with spaces",
      "open C:\\Users\\John Doe\\docs\\file.txt failed",
      "~/…/file.txt",
      "Doe",
    ],
    [
      "path collapses to basename, folders dropped",
      "crash in /Users/kartik/code/secret-repo/main.ts",
      "~/…/main.ts",
      "secret-repo",
    ],
    ["email", "contact user@example.com for help", "<email>", "user@example.com"],
    [
      "URL query and fragment dropped",
      "GET https://api.example.com/v1/items?key=secret&id=1#frag failed",
      "https://api.example.com/…",
      "secret",
    ],
    [
      "URL userinfo redacted",
      "GET https://user:password@example.com/x failed",
      "https://<redacted>@example.com/…",
      "password",
    ],
    [
      "non-http URL userinfo redacted",
      "connect postgres://admin:s3cret@db.internal:5432/app?ssl=true",
      "postgres://<redacted>@db.internal:5432/…",
      "s3cret",
    ],
    [
      "https git remote keeps only the host",
      "clone https://github.com/acme/private-repo.git failed",
      "https://github.com/…",
      "private-repo",
    ],
    [
      "ticket URL path dropped",
      "see https://jira.acme.internal/browse/SECRET-42",
      "https://jira.acme.internal/…",
      "SECRET-42",
    ],
    [
      "standard base64 secret",
      "aws_secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY1 used",
      "[redacted]",
      "wJalrXUtnFEMI",
    ],
    ["scp-style git url", "clone git@github.com:org/repo.git done", "<git-url>", "org/repo"],
    ["ssh git url", "clone ssh://git@gitlab.com/org/repo done", "<git-url>", "org/repo"],
    ["Bearer token", "sent Bearer abc.def.ghi upstream", "Bearer [redacted]", "abc.def.ghi"],
    [
      "Authorization header",
      "header Authorization: Basic dXNlcjpwYXNz sent",
      "Authorization: [redacted]",
      "dXNlcjpwYXNz",
    ],
    ["OpenAI key", "key sk-AbCdEfGhIjKlMnOpQrStUvWx used", "[redacted]", "sk-AbCd"],
    ["Anthropic key", "key sk-ant-api03-XYZ_123 used", "[redacted]", "sk-ant-"],
    ["GitHub PAT", "token ghp_0123456789abcdefABCDEF1234 ok", "[redacted]", "ghp_0123"],
    [
      "GitHub fine-grained PAT",
      "token github_pat_11ABCDEFG0abcdefghijklmn ok",
      "[redacted]",
      "github_pat_",
    ],
    ["Slack token", "xoxb-1234-5678-abcdef leaked", "[redacted]", "xoxb-"],
    ["AWS access key", "credential AKIAIOSFODNN7EXAMPLE found", "[redacted]", "AKIA"],
    ["Google API key", "key AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe", "[redacted]", "AIza"],
    [
      "JWT",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature_here",
      "[redacted]",
      "eyJhbGci",
    ],
    [
      "JSON secret field",
      '{"apiKey": "supersecretvalue", "ok": true}',
      '"[redacted]"',
      "supersecretvalue",
    ],
    [
      "env-style password",
      "DATABASE_PASSWORD=hunter2please loaded",
      "DATABASE_PASSWORD=[redacted]",
      "hunter2please",
    ],
    ["colon-style password", "config password: hunter2 loaded", "password: [redacted]", "hunter2"],
    ["header-style api key", "X-Api-Key: abc123xyz rejected", "X-Api-Key: [redacted]", "abc123xyz"],
    ["base64-ish secret value", "AccountKey=abc/+= stored", "AccountKey=[redacted]", "abc/+"],
    [
      "cookie header redacted whole",
      "req Cookie: a=b; PHPSESSID=deadbeefcafe sent",
      "Cookie: [redacted]",
      "PHPSESSID",
    ],
    [
      "set-cookie header redacted whole",
      "res Set-Cookie: session=abc123; Path=/ ok",
      "Set-Cookie: [redacted]",
      "abc123",
    ],
    [
      "PEM private key block",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----\ndone",
      "[redacted private key]",
      "MIIE",
    ],
    ["IPv4", "dial 192.168.1.20:8080 refused", "<ip>", "192.168.1.20"],
    ["IPv6", "dial fe80::1ff:fe23:4567:890a refused", "<ip>", "fe80::"],
    [
      "long opaque token",
      "trace 0123456789abcdef0123456789abcdef01234567 done",
      "[redacted]",
      "0123456789abcdef0123456789abcdef",
    ],
  ])("%s", (_name, input, mustContain, mustNotContain) => {
    const out = redact(input);
    expect(out).toContain(mustContain);
    if (mustNotContain) expect(out).not.toContain(mustNotContain);
  });

  it("keeps a normal stack trace readable", () => {
    const input = [
      "Error: request failed with status 500",
      "    at fetchFeed (apps/desktop/src/update.ts:123:45)",
      "    at async checkForUpdates (apps/desktop/src/main.ts:678:9)",
    ].join("\n");
    const out = redact(input);
    expect(out).toContain("at fetchFeed");
    expect(out).toContain("update.ts:123:45");
    expect(out).toContain("status 500");
  });

  it("keeps local-scheme stack frames and relative paths readable", () => {
    const out = redact(
      [
        "at render (synara-beta://app/assets/index-abc123.js:10:5)",
        "at load (file:///Applications/Synara%20Beta.app/Contents/Resources/app.asar/dist/main.js:88:1)",
        "at run (node_modules/effect/dist/internal/fiberRuntime.js:1:2)",
      ].join("\n"),
    );
    expect(out).toContain("synara-beta://app/assets/index-abc123.js:10:5");
    expect(out).toContain("app.asar/dist/main.js:88:1");
    expect(out).toContain("node_modules/effect/dist/internal/fiberRuntime.js");
  });

  it("keeps HH:MM:SS timestamps in log excerpts readable", () => {
    const out = redact("2026-09-23T12:34:56.789Z backend exited");
    expect(out).toContain("12:34:56");
  });

  it("truncates to maxLength", () => {
    const out = redactDiagnosticText("log line ".repeat(500), { maxLength: 100 });
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("redacts a 64 KiB adversarial string in bounded time", () => {
    // Long alphanumeric runs used to drive the sensitive-key pattern into
    // quadratic backtracking.
    const input = `password: hunter2 ${"a".repeat(64 * 1024)}`;
    const started = performance.now();
    const out = redact(input);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(50);
    expect(out).toContain("password: [redacted]");
    expect(out).not.toContain("hunter2");
  });

  it("redacts a PEM block that spans the maxLength cut", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(200) + "\n-----END PRIVATE KEY-----\n";
    const out = redactDiagnosticText(`${"x".repeat(50)}${pem}${"y".repeat(200)}`, {
      maxLength: 100,
    });
    expect(out).not.toContain("PRIVATE KEY");
  });

  it("works without homeDir", () => {
    const out = redactDiagnosticText("email me at a@b.co", { maxLength: 1024 });
    expect(out).toContain("<email>");
  });
});
