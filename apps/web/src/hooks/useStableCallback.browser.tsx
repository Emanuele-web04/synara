// FILE: useStableCallback.browser.tsx
// Purpose: Verifies a stable callback keeps one identity while running the latest closure.

import { expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useStableCallback } from "./useStableCallback";

it("keeps one identity across renders and calls the closure from the latest render", async () => {
  const hook = await renderHook(
    (props?: { label: string }) =>
      useStableCallback((suffix: string) => `${props?.label ?? "none"}${suffix}`),
    { initialProps: { label: "first" } },
  );
  try {
    const stable = hook.result.current;
    expect(stable("!")).toBe("first!");

    await hook.rerender({ label: "second" });

    expect(hook.result.current).toBe(stable);
    expect(stable("!")).toBe("second!");
  } finally {
    await hook.unmount();
  }
});
