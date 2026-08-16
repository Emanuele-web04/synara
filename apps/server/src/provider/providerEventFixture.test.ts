import { describe, expect, it, vi } from "vitest";

import {
  parseProviderEventFixture,
  ProviderEventFixtureError,
  replayProviderEventFixture,
  sanitizeProviderEventFixtureEvents,
  serializeProviderEventFixture,
} from "./providerEventFixture";

describe("provider event fixtures", () => {
  it("redacts content and preserves deterministic identifier relationships", () => {
    const sanitized = sanitizeProviderEventFixtureEvents([
      {
        type: "message.part.delta",
        properties: {
          sessionID: "session-private",
          partID: "part-private",
          timestamp: 1_786_000_000,
          text: "private assistant text",
          token: "secret-token",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          sessionID: "session-private",
          partID: "part-private",
          timestamp: 1_786_000_100,
          status: "completed",
        },
      },
    ]) as Array<Record<string, any>>;
    const first = sanitized[0]!;
    const second = sanitized[1]!;

    expect(first.properties.sessionID).toBe("<id-1>");
    expect(first.properties.partID).toBe("<id-2>");
    expect(first.properties.timestamp).toBe(0);
    expect(first.properties.text).toBe("<redacted>");
    expect(first.properties.token).toBe("<redacted>");
    expect(second.properties.sessionID).toBe("<id-1>");
    expect(second.properties.partID).toBe("<id-2>");
    expect(second.properties.status).toBe("completed");
  });

  it("keeps numeric and string identifiers distinct", () => {
    const [sanitized] = sanitizeProviderEventFixtureEvents([
      {
        type: "message.part.updated",
        properties: {
          sessionID: 1,
          partID: "1",
          status: "completed",
        },
      },
    ]) as Array<Record<string, any>>;

    expect(sanitized.properties.sessionID).toBe("<id-1>");
    expect(sanitized.properties.partID).toBe("<id-2>");
  });

  it("preserves timestamp types while normalizing values", () => {
    const [sanitized] = sanitizeProviderEventFixtureEvents([
      {
        type: "turn.completed",
        createdAt: "2026-08-15T12:34:56.000Z",
        properties: { timestamp: 1_786_000_000, state: "completed" },
      },
    ]) as Array<Record<string, any>>;

    expect(sanitized.createdAt).toBe("2000-01-01T00:00:00.000Z");
    expect(sanitized.properties.timestamp).toBe(0);
  });

  it("preserves safe native event methods", () => {
    const [sanitized] = sanitizeProviderEventFixtureEvents([
      {
        method: "thread/started",
        params: { sessionID: "session-private", status: "ready" },
      },
    ]) as Array<Record<string, any>>;

    expect(sanitized.method).toBe("thread/started");
    expect(sanitized.params.sessionID).toBe("<id-1>");
  });

  it("fails closed for an unclassified string field", () => {
    expect(() =>
      serializeProviderEventFixture([
        {
          type: "custom.event",
          properties: {
            mystery: "could contain user data",
          },
        },
      ]),
    ).toThrow(ProviderEventFixtureError);
  });

  it("rejects unclassified object keys even when their values are not strings", () => {
    expect(() =>
      serializeProviderEventFixture([
        {
          type: "custom.event",
          metadata: {
            "/home/alice/private-project": true,
          },
        },
      ]),
    ).toThrow(/unclassified object key/u);
  });

  it("does not trust globally safe-looking keys inside arbitrary metadata", () => {
    expect(() =>
      serializeProviderEventFixture([
        {
          type: "custom.event",
          metadata: {
            type: "private-project",
          },
        },
      ]),
    ).toThrow(/unclassified string field/u);
  });

  it("rejects prototype-shaped keys instead of mutating the sanitizer result prototype", () => {
    const metadata = JSON.parse('{"__proto__":{"status":"completed"}}') as unknown;
    expect(() =>
      serializeProviderEventFixture([
        {
          type: "custom.event",
          metadata,
        },
      ]),
    ).toThrow(/unclassified object key/u);
  });

  it("round-trips a sanitized line-oriented fixture", () => {
    const serialized = serializeProviderEventFixture([
      {
        type: "session.state.changed",
        properties: {
          sessionID: "session-private",
          status: "ready",
          timestamp: 123,
        },
      },
      {
        type: "turn.completed",
        properties: {
          sessionID: "session-private",
          state: "completed",
          timestamp: 456,
        },
      },
    ]);

    const records = parseProviderEventFixture(serialized);

    expect(records).toHaveLength(2);
    expect(records.map((record) => record.index)).toEqual([0, 1]);
    expect(records[0]?.event).toMatchObject({
      type: "session.state.changed",
      properties: { sessionID: "<id-1>", status: "ready", timestamp: 0 },
    });
  });

  it("rejects malformed, version-mismatched, out-of-order, and non-object events", () => {
    expect(() => parseProviderEventFixture("not-json")).toThrow(ProviderEventFixtureError);
    expect(() =>
      parseProviderEventFixture(JSON.stringify({ version: 2, index: 0, event: {} })),
    ).toThrow(/unsupported version/u);
    expect(() =>
      parseProviderEventFixture(JSON.stringify({ version: 1, index: 1, event: {} })),
    ).toThrow(/out-of-order index/u);
    for (const event of [null, "event", 1, []]) {
      expect(() =>
        parseProviderEventFixture(JSON.stringify({ version: 1, index: 0, event })),
      ).toThrow(/event must be an object/u);
    }
  });

  it("enforces byte and event-count bounds", () => {
    const one = JSON.stringify({ version: 1, index: 0, event: {} });
    const two = `${one}\n${JSON.stringify({ version: 1, index: 1, event: {} })}`;

    expect(() => parseProviderEventFixture(one, { maxBytes: 1 })).toThrow(/exceeds 1 bytes/u);
    expect(() => parseProviderEventFixture(two, { maxEvents: 1 })).toThrow(/exceeds 1 events/u);
  });

  it("replays records sequentially in fixture order", async () => {
    const records = parseProviderEventFixture(
      [
        JSON.stringify({ version: 1, index: 0, event: { type: "first" } }),
        JSON.stringify({ version: 1, index: 1, event: { type: "second" } }),
      ].join("\n"),
    );
    const observed: string[] = [];
    const consume = vi.fn(async (event: unknown) => {
      await Promise.resolve();
      observed.push((event as { type: string }).type);
    });

    await replayProviderEventFixture(records, consume);

    expect(observed).toEqual(["first", "second"]);
    expect(consume).toHaveBeenCalledTimes(2);
  });
});
