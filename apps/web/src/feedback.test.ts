import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildFeedbackSubmission,
  FEEDBACK_CATEGORIES,
  normalizeHomePaths,
  redactObviousSecrets,
  submitFeedback,
} from "./feedback";

afterEach(() => vi.unstubAllGlobals());

describe("explicit feedback", () => {
  it("uses only reporter-written category and details, without reading legacy context", () => {
    const input = {
      category: "bug" as const,
      details: "  The composer stopped responding.  ",
      get context() {
        throw new Error("Automatic context must not be read");
      },
      get userAgent() {
        throw new Error("Browser identity must not be read");
      },
    };
    expect(buildFeedbackSubmission(input)).toEqual({
      category: "bug",
      details: "The composer stopped responding.",
    });
    expect(FEEDBACK_CATEGORIES.map((category) => category.value)).toContain("bug");
  });

  it("does not serialize diagnostic fields supplied by a legacy caller", async () => {
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    const fetchImplementation = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
    const submission = {
      category: "bug" as const,
      details: "The send button stopped responding.",
      get diagnostics() {
        throw new Error("Automatic diagnostics must not be read");
      },
    };
    await submitFeedback(submission, fetchImplementation);
    expect(JSON.parse(String(fetchImplementation.mock.calls[0]![1]?.body))).toEqual({
      category: "bug",
      details: submission.details,
    });
  });

  it("sanitizes secrets and home paths from reporter-written details", () => {
    const submission = buildFeedbackSubmission({
      category: "bug",
      details:
        "My token is ghp_0123456789abcdefghijklmnopqrst and I work in /Users/kartik/scratch.",
    });
    expect(submission.details).not.toContain("ghp_0123456789abcdefghijklmnopqrst");
    expect(submission.details).toContain("[REDACTED]");
    expect(submission.details).not.toContain("/Users/kartik");
    expect(submission.details).toContain("~/scratch");
  });

  // Every pattern family in SECRET_PATTERNS has a fixture here so a new or
  // edited row that stops matching fails loudly instead of leaking silently.
  it.each([
    ["a GitHub PAT", "ghp_0123456789abcdefghijklmnop"],
    ["a fine-grained GitHub PAT", "github_pat_0123456789abcdefghijklmnop"],
    ["a GitHub OAuth token", "gho_0123456789abcdefghijklmnop"],
    ["a GitHub user-to-server token", "ghu_0123456789abcdefghijklmnop"],
    ["a GitHub server-to-server token", "ghs_0123456789abcdefghijklmnop"],
    ["a GitHub refresh token", "ghr_0123456789abcdefghijklmnop"],
    ["an OpenAI project key", "sk-proj-0123456789abcdefghijkl"],
    ["an Anthropic key", "sk-ant-0123456789abcdefghijkl"],
    ["a bare sk- key", "sk-0123456789abcdefghijklmnopqrst"],
    ["a Stripe live key", "sk_live_0123456789abcdef"],
    ["a Stripe test key", "rk_test_0123456789abcdef"],
    ["an AWS access key", "AKIAIOSFODNN7EXAMPLE"],
    ["an AWS temporary key", "ASIAIOSFODNN7EXAMPLE"],
    ["an AWS ABIA key", "ABIAIOSFODNN7EXAMPLE"],
    ["a Slack bot token", "xoxb-123456789012-abcdefghijkl"],
    ["a Slack user token", "xoxp-123456789012-abcdefghijkl"],
    ["a Slack app token", "xoxa-123456789012-abcdefghijkl"],
    ["a GitLab PAT", "glpat-abcdefghij12345"],
    ["an npm token", "npm_0123456789abcdefghijklmn"],
    ["a Google OAuth token", "ya29.a0AfH6SMBx-0123456789abcdefghij"],
    ["a Google API key", "AIzaSyA0123456789abcdefghijklmnopqrstuv"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrst"],
    [
      "a private key block",
      "-----BEGIN PRIVATE KEY-----\nabcdef0123456789\n-----END PRIVATE KEY-----",
    ],
    ["a bearer token", "bearer abcdefghijklmnop"],
    ["a password assignment", "password=hunter2hunter2"],
    ["a secret assignment", "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCY"],
    ["an api_key assignment", "api_key: abcdef1234567890"],
    ["a token assignment", "token = abcdef1234567890"],
  ])("redacts %s from pasted details", (_label, secret) => {
    const submission = buildFeedbackSubmission({
      category: "bug",
      details: `here is the leak: ${secret} end`,
    });

    expect(submission.details).not.toContain(secret);
    expect(submission.details).toContain("[REDACTED]");
  });

  it.each([
    ['"password": "correct horse battery staple"', "correct horse battery staple"],
    ["'api_key': 'private key with spaces'", "private key with spaces"],
    ['"token": "prefix\\\"secret suffix"', "secret suffix"],
  ])("redacts quoted credential assignments: %s", (assignment, secret) => {
    const { text } = redactObviousSecrets(`config: {${assignment}, "retries": 3}`);

    expect(text).not.toContain(secret);
    expect(text).toContain('[REDACTED], "retries": 3');
  });

  it("redacts credentials embedded in URLs but keeps the host", () => {
    const { text } = redactObviousSecrets(
      "DATABASE_URL=postgres://deploy:hunter2pass@db.internal:5432/app",
    );

    expect(text).not.toContain("hunter2pass");
    expect(text).toContain("postgres://[REDACTED]@db.internal:5432/app");
  });

  it("does not mangle a word that merely contains the letters of a token prefix", () => {
    const { text } = redactObviousSecrets("the mybearer flag controls retries");

    expect(text).toBe("the mybearer flag controls retries");
  });

  // The generic assignment scrubber only fires on whole credential-key
  // segments: ordinary settings and camelCase names stay readable.
  it.each([
    "passwordless=true",
    "tokenizer=slow",
    "myPassword=hunter2",
    "set tokenization=v2",
    "apikeys.txt",
  ])("keeps ordinary assignment %s readable", (assignment) => {
    const { text } = redactObviousSecrets(`flag ${assignment} end`);

    expect(text).toBe(`flag ${assignment} end`);
  });

  it.each([
    "secrets=s3cr3tvalue",
    "client_secrets=s3cr3tvalue",
    "MY_API_TOKEN=s3cr3tvalue",
    // Numeric suffixes are real credential key names too.
    "TOKEN1=s3cr3tvalue",
    "API_KEY2=s3cr3tvalue",
  ])("still redacts the delimited credential key %s", (assignment) => {
    const { text } = redactObviousSecrets(`flag ${assignment} end`);

    expect(text).not.toContain(assignment);
    expect(text).toContain("[REDACTED]");
  });

  it("maps /root to ~ without swallowing the first directory", () => {
    expect(normalizeHomePaths("crash log at /root/project/config.txt")).toBe(
      "crash log at ~/project/config.txt",
    );
    expect(normalizeHomePaths("bare /root")).toBe("bare ~");
    expect(normalizeHomePaths("path /rooted/x stays")).toBe("path /rooted/x stays");
  });

  it("redacts home paths inside file:// URLs", () => {
    expect(normalizeHomePaths("see file:///Users/alice/project end")).toBe(
      "see file://~/project end",
    );
    expect(normalizeHomePaths("see file:///home/bob/x.log end")).toBe("see file://~/x.log end");
  });
});
