// The walkthrough surface is off by default. Enable it per-session with the
// `?walkthrough=1` (or `?walkthrough=true`) search param on a PR route, e.g.
// /review/123?walkthrough=1. Evaluated once from the initial URL so the seam
// stays additive and the normal PR view is untouched when the flag is absent.
function readWalkthroughFlag(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const value = new URLSearchParams(window.location.search).get("walkthrough");
  return value === "1" || value === "true";
}

export const WALKTHROUGH_ENABLED: boolean = readWalkthroughFlag();
