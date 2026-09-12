import { describe, expect, it } from "vitest";
import {
  KANBAN_STUCK_HARD_MS,
  deriveKanbanAttention,
  deriveKanbanColumnV2,
  type KanbanThreadDerivationInput,
} from "./kanban";

const NOW = Date.parse("2026-03-09T12:00:00.000Z");
const FRESH_NOW = { now: NOW };
const STALE_ISO = new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString();

type Turn = NonNullable<KanbanThreadDerivationInput["latestTurn"]>;
type Session = NonNullable<KanbanThreadDerivationInput["session"]>;

const makeInput = (
  overrides: Partial<KanbanThreadDerivationInput> = {},
): KanbanThreadDerivationInput => ({ latestTurn: null, session: null, ...overrides });

const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  state: "completed",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:05:00.000Z",
  ...overrides,
});

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  status: "idle",
  updatedAt: new Date(NOW).toISOString(),
  ...overrides,
});

const liveInput = (overrides: Partial<KanbanThreadDerivationInput> = {}) =>
  makeInput({
    latestTurn: makeTurn({ state: "running", completedAt: null }),
    session: makeSession({ status: "running" }),
    ...overrides,
  });

describe("deriveKanbanColumnV2", () => {
  it("puts never-ran threads in draft", () => {
    expect(deriveKanbanColumnV2(makeInput())).toBe("draft");
  });

  it("puts live turn work in progress", () => {
    expect(deriveKanbanColumnV2(liveInput())).toBe("inProgress");
  });

  it("hoists actionable pending approvals to awaitingYou", () => {
    expect(deriveKanbanColumnV2(makeInput({ hasPendingApprovals: true }), FRESH_NOW)).toBe(
      "awaitingYou",
    );
  });

  it("puts settled threads in done", () => {
    expect(deriveKanbanColumnV2(makeInput({ latestTurn: makeTurn() }))).toBe("done");
  });
});

describe("deriveKanbanAttention", () => {
  it("maps pending approval to its pill", () => {
    expect(deriveKanbanAttention(makeInput({ hasPendingApprovals: true }), FRESH_NOW)).toEqual([
      "awaiting-approval",
    ]);
  });
});

describe("stuck timing", () => {
  it("trips stuck past the hard threshold; fresh heartbeats stay in progress", () => {
    const stale = liveInput({
      session: makeSession({ status: "running", updatedAt: STALE_ISO }),
    });
    expect(deriveKanbanColumnV2(stale, FRESH_NOW)).toBe("awaitingYou");
    expect(deriveKanbanAttention(stale, FRESH_NOW)).toEqual(["stuck"]);
    expect(deriveKanbanColumnV2(liveInput(), FRESH_NOW)).toBe("inProgress");
  });
});
