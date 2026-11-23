import { describe, expect, it } from "vitest";

import { listDevinCloudSessions, readDevinCloudMessages } from "./devinCloudHistory.ts";

const OPTIONS = {
  apiUrl: "https://api.devin.ai",
  orgId: "org-1",
  token: "test-token",
};

function mockFetch(
  payload: unknown,
  status = 200,
): (url: string, init?: RequestInit) => Promise<Response> {
  return async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("listDevinCloudSessions", () => {
  it("maps the paginated v3 shape and adds the devin- prefix", async () => {
    const page = await listDevinCloudSessions({
      ...OPTIONS,
      fetchImpl: mockFetch({
        items: [
          {
            session_id: "abc123",
            title: "Test",
            status: "running",
            url: "https://app.devin.ai/sessions/abc123",
            created_at: 1795441258,
            updated_at: 1795442000,
            origin: "cli",
            devin_mode: "swe-2-medium",
          },
        ],
        end_cursor: "cursor-2",
        has_next_page: true,
        total: null,
      }),
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      sessionId: "devin-abc123",
      createdAt: new Date(1795441258 * 1000).toISOString(),
      origin: "cli",
    });
    expect(page.endCursor).toBe("cursor-2");
    expect(page.hasNextPage).toBe(true);
  });

  it("encodes the cursor into the qs JSON param", async () => {
    let requestedUrl = "";
    const fetchImpl = async (url: string) => {
      requestedUrl = String(url);
      return new Response(JSON.stringify({ items: [], end_cursor: null, has_next_page: false }));
    };
    await listDevinCloudSessions({ ...OPTIONS, fetchImpl }, { first: 50, after: "opaque-cursor" });
    const url = new URL(requestedUrl);
    expect(JSON.parse(url.searchParams.get("qs") ?? "{}")).toEqual({
      first: 50,
      after: "opaque-cursor",
    });
  });

  it("maps 401 to auth-failed, 404 to not-found, 429 to rate-limited", async () => {
    for (const [status, code] of [
      [401, "auth-failed"],
      [403, "auth-failed"],
      [404, "not-found"],
      [429, "rate-limited"],
      [500, "read-failed"],
    ] as const) {
      await expect(
        listDevinCloudSessions({ ...OPTIONS, fetchImpl: mockFetch({}, status) }),
      ).rejects.toMatchObject({ code });
    }
  });

  it("sends the token only as an Authorization header on GET", async () => {
    let method = "";
    let authHeader: string | null = null;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      method = init?.method ?? "";
      authHeader = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ items: [], end_cursor: null, has_next_page: false }));
    };
    await listDevinCloudSessions({ ...OPTIONS, fetchImpl });
    expect(method).toBe("GET");
    expect(authHeader).toBe("Bearer test-token");
  });
});

describe("readDevinCloudMessages", () => {
  it("maps user/devin sources and epoch-second timestamps", async () => {
    const page = await readDevinCloudMessages(
      {
        ...OPTIONS,
        fetchImpl: mockFetch({
          items: [
            { event_id: "event-1", source: "user", message: "hi", created_at: 1795441258 },
            { event_id: "event-2", source: "devin", message: "answer", created_at: 1795441266 },
          ],
          end_cursor: null,
          has_next_page: false,
        }),
      },
      { sessionId: "devin-abc123" },
    );
    expect(page.items).toEqual([
      {
        eventId: "event-1",
        source: "user",
        message: "hi",
        createdAt: new Date(1795441258 * 1000).toISOString(),
      },
      {
        eventId: "event-2",
        source: "devin",
        message: "answer",
        createdAt: new Date(1795441266 * 1000).toISOString(),
      },
    ]);
  });
});
