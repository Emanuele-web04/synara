import { describe, expect, it } from "vitest";
import { ComputerTurnTimings } from "./computerTurnTiming.ts";

describe("computer turn timings", () => {
  it("measures model delay and observation-to-write without another native call", () => {
    let now = 0;
    const rows: Record<string, number | string>[] = [];
    const timings = new ComputerTurnTimings(
      () => now,
      (row) => rows.push(row),
    );
    timings.start("thread", "turn");
    now = 100;
    const observed = timings.begin("thread", "turn", "observation");
    now = 150;
    observed(true);
    now = 300;
    const wrote = timings.begin("thread", "turn", "write");
    now = 320;
    wrote(true);
    expect(rows[1]).toMatchObject({
      origin: "provider-turn-start",
      time_to_first_observation_ms: 150,
      time_to_first_write_ms: 300,
      observe_to_write_start_ms: 150,
      observe_to_write_end_ms: 170,
    });
  });
  it("does not record refusals or late completions after a turn ends", () => {
    const rows: unknown[] = [];
    const timings = new ComputerTurnTimings(
      () => 10,
      (row) => rows.push(row),
    );
    timings.begin("thread", "old", "write")(false);
    const old = timings.begin("thread", "old", "observation");
    timings.start("thread", "new");
    timings.end("thread", "old");
    old(true);
    timings.begin("thread", "new", "write")(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turnId: "new" });
  });
  it("labels missing provider start honestly and isolates overlapping turns", () => {
    let now = 0;
    const rows: Record<string, number | string>[] = [];
    const timings = new ComputerTurnTimings(
      () => now,
      (row) => rows.push(row),
    );
    timings.begin("t", "a", "observation")(true);
    now = 10;
    timings.begin("t", "b", "write")(true);
    expect(rows[1]).toMatchObject({ origin: "first-computer-call", time_to_first_write_ms: 0 });
    expect(rows[1]).not.toHaveProperty("observe_to_write_start_ms");
  });
});
