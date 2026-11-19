import { describe, expect, it } from "vitest";

import {
  FAR,
  TAIL_SLACK,
  afterScroll,
  initialFollow,
  shouldPin,
  showsLatest,
  type FollowState,
  type ScrollMetrics,
} from "./transcriptFollow";

const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 500): ScrollMetrics => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});
const end = (scrollHeight = 2000) => at(scrollHeight - 500, scrollHeight);

describe("transcript follow-tail", () => {
  it("follows from the start and pins while content grows at the end", () => {
    let state: FollowState = afterScroll(initialFollow, end());
    expect(state.following).toBe(true);
    // A reply grows the list by 300 px; the view is still where it was.
    expect(shouldPin(state, at(1500, 2300))).toBe(true);
    state = afterScroll(state, end(2300));
    expect(state.following).toBe(true);
  });

  it("an upward scroll leaves the tail and growth no longer pins", () => {
    let state = afterScroll(initialFollow, end());
    state = afterScroll(state, at(1200));
    expect(state.following).toBe(false);
    // Work, a typing row, a card or a pending approval grows the list: still detached.
    expect(shouldPin(state, at(1200, 2600))).toBe(false);
    state = afterScroll(state, at(1200, 2600));
    expect(state.following).toBe(false);
  });

  it("does not pin when the reader scrolled up before the scroll event arrived", () => {
    const state = afterScroll(initialFollow, end());
    expect(shouldPin(state, at(1300, 2100))).toBe(false);
  });

  it("follows again only when the reader comes back to the end", () => {
    let state = afterScroll(afterScroll(initialFollow, end()), at(800));
    state = afterScroll(state, at(1000));
    expect(state.following).toBe(false);
    state = afterScroll(state, at(2000 - 500 - (TAIL_SLACK - 1)));
    expect(state.following).toBe(true);
  });

  it("shows the jump to the latest past FAR and hides it only near the end", () => {
    let state = afterScroll(afterScroll(initialFollow, end()), at(1500 - FAR - 10));
    expect(showsLatest(state, at(1500 - FAR - 10), false)).toBe(true);
    state = afterScroll(state, at(1500 - FAR + 10));
    // Between TAIL_SLACK and FAR: stays shown once shown, not shown otherwise.
    expect(showsLatest(state, at(1500 - FAR + 10), true)).toBe(true);
    expect(showsLatest(state, at(1500 - FAR + 10), false)).toBe(false);
  });
});
