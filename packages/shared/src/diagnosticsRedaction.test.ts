// FILE: diagnosticsRedaction.test.ts
// Purpose: Table-driven coverage of every diagnostics redaction rule.

import { describe, expect, it } from "vitest";

import { redactDiagnosticText } from "./diagnosticsRedaction";

const OPTS = { homeDir: "/Users/kartik", maxLength: 16 * 1024 };
const redact = (text: string) => redactDiagnosticText(text, OPTS);

describe("redactDiagnosticText", () => {
  it.each([
    [
      "home directory collapses to ~",
      "crash at /Users/kartik/.synara-beta/logs/x.log",
      "~/",
      "/Users/kartik",
    ],
    ["macOS user path", "open /Users/alice/project failed", "<user>", "alice"],
    ["linux user path", "open /home/bob/project failed", "<user>", "bob"],
    ["windows user path", "open C:\\Users\\carol\\file.txt failed", "<user>", "carol"],
    ["email", "contact user@example.com for help", "<email>", "user@example.com"],
    [
      "URL query and fragment dropped",
      "GET https://api.example.com/v1/items?key=secret&id=1#frag failed",
      "https://api.example.com/v1/items",
      "secret",
    ],
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

  it("keeps HH:MM:SS timestamps in log excerpts readable", () => {
    const out = redact("2026-09-23T12:34:56.789Z backend exited");
    expect(out).toContain("12:34:56");
  });

  it("truncates to maxLength", () => {
    const out = redactDiagnosticText("log line ".repeat(500), { maxLength: 100 });
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith("…")).toBe(true);
  });

  it("works without homeDir", () => {
    const out = redactDiagnosticText("email me at a@b.co", { maxLength: 1024 });
    expect(out).toContain("<email>");
  });
});
