import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/feedbackRateLimit", () => ({
  consumeFeedbackRateLimit: vi.fn(async () => ({ allowed: true })),
}));
import { POST } from "./route";

const deliver = vi.fn<typeof fetch>();
function report(body: unknown) {
  return new Request("https://www.trysynara.com/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "x-synara-feedback": "1" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", deliver);
  vi.stubEnv("RESEND_API_KEY", "synthetic-feedback-key");
  vi.stubEnv("SYNARA_FEEDBACK_TO_EMAIL", "reports@example.test");
  vi.stubEnv("SYNARA_FEEDBACK_FROM_EMAIL", "feedback@example.test");
  deliver.mockResolvedValue(
    new Response(JSON.stringify({ id: "synthetic-delivery" }), { status: 200 }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("manual feedback delivery boundary", () => {
  it("delivers only reporter text and ignores legacy diagnostics and hidden summary", async () => {
    const response = await POST(
      report({
        category: "bug",
        details: "Send stopped responding.",
        diagnostics: { appVersion: "synthetic-private-version", model: "synthetic-private-model" },
        summary: "synthetic-private-context",
      }),
    );
    expect(response.status).toBe(200);
    expect(deliver).toHaveBeenCalledOnce();
    const email = JSON.parse(String(deliver.mock.calls[0]![1]?.body));
    expect(email).toMatchObject({
      subject: "[Synara Feedback] Bug",
      text: "Send stopped responding.",
    });
    expect(JSON.stringify(email)).not.toContain("synthetic-private");
    expect(email.html).not.toContain("Diagnostic context");
  });

  it("redacts pasted credentials through the shared helper before delivery", async () => {
    const secret = "ghp_0123456789abcdefghijklmnopqrst";
    expect((await POST(report({ category: null, details: `Pasted key ${secret}` }))).status).toBe(
      200,
    );
    const email = JSON.parse(String(deliver.mock.calls[0]![1]?.body));
    expect(JSON.stringify(email)).not.toContain(secret);
    expect(email.text).toContain("[redacted]");
  });

  it.each(["constructor", "toString", "unknown"])(
    "rejects an unrecognized category %s without delivering",
    async (category) => {
      expect((await POST(report({ category, details: "A report" }))).status).toBe(400);
      expect(deliver).not.toHaveBeenCalled();
    },
  );
});
