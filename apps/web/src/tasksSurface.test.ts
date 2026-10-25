import { TASKS_UNAVAILABLE_ERROR_CODE } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { isTasksRefusal, isTasksSurfaceEnabled, noteTasksRefusal } from "./tasksSurface";

describe("tasksSurface", () => {
  it("turns Tasks off for the session once the server refuses it", () => {
    // Tests have no desktop protocol, so the build offers Tasks in Stable and Beta.
    expect(isTasksSurfaceEnabled()).toBe(true);

    expect(noteTasksRefusal(new Error("Socket closed"))).toBe(false);
    expect(isTasksSurfaceEnabled()).toBe(true);

    const refusal = {
      code: TASKS_UNAVAILABLE_ERROR_CODE,
      message: "Tasks is unavailable on this server.",
    };
    expect(isTasksRefusal(refusal)).toBe(true);
    expect(noteTasksRefusal(refusal)).toBe(true);
    expect(isTasksSurfaceEnabled()).toBe(false);
  });
});
